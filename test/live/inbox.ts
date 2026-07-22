/**
 * Gmail inbox reader for the live tier — the "did it actually arrive, and did
 * it survive the trip" check that no mock can make.
 *
 * Auth is IMAP + an app password (`GMAIL_USER` / `GMAIL_APP_PASSWORD`); the
 * account needs 2FA enabled to mint one. Nothing here runs unless the live
 * gate is open — see `gate.ts`.
 *
 * Correlation is by a unique token embedded in the SUBJECT. Gmail's IMAP
 * search over custom headers is unreliable; subject search is not. Recipients
 * use plus-tagging (`you+mailery-<token>@gmail.com`) so every run is isolable
 * inside one inbox.
 */

import { ImapFlow } from 'imapflow'

import { gmailUser, gmailPassword } from './gate.js'

export interface ReceivedMessage {
  subject: string
  from: string
  to: string
  html: string
  text: string
  headers: Record<string, string>
  /** True when the message carried BOTH a text/html and a text/plain part. */
  isMultipartAlternative: boolean
}

/** A unique, IMAP-searchable token. Also used as the plus-tag on the address. */
export function newToken(): string {
  return `mlrytest${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * A self-describing header block for live test emails.
 *
 * These land in a real inbox and a human eventually reads them. An email that
 * says only "Hello" tells you nothing about why it exists or whether what you
 * are looking at is correct; one that lists its own assertions can be checked
 * by eye, which is the whole point of delivering to a real client.
 *
 * Returned as MJML-safe HTML — the caller drops it into a template body.
 */
export function describeChecks(opts: {
  title: string
  checks: string[]
  token: string
}): string {
  const items = opts.checks.map((c) => `<li>${escapeHtml(c)}</li>`).join('')
  return [
    `<p><strong>mailery live test — ${escapeHtml(opts.title)}</strong></p>`,
    '<p>This message was sent by mailery&rsquo;s automated live test suite. ',
    'It verifies that the following survive a real trip through SendGrid ',
    'and into this inbox:</p>',
    `<ul>${items}</ul>`,
    `<p style="color:#666;font-size:12px">Correlation token: ${escapeHtml(opts.token)}<br />`,
    'If you are reading this in a real inbox, nothing is wrong &mdash; these ',
    'are expected whenever the live tier runs.</p>',
  ].join('')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** `user+<token>@gmail.com` for the configured account. */
export function taggedAddress(token: string): string {
  const user = required(gmailUser(), 'GMAIL_USERNAME')
  const [local, domain] = user.split('@')
  if (!local || !domain) throw new Error(`GMAIL_USERNAME is not an email address: ${user}`)
  return `${local}+${token}@${domain}`
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} must be set for the live tier`)
  return value
}

async function connect(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: required(gmailUser(), 'GMAIL_USERNAME'),
      pass: required(gmailPassword(), 'GMAIL_PASSWORD'),
    },
    logger: false,
  })
  await client.connect()
  return client
}

export interface WaitOptions {
  /** Give up after this long. Real delivery latency is variable; 120s is sane. */
  timeoutMs?: number
  /** Gap between polls. */
  pollMs?: number
}

/**
 * Mailboxes searched, in order. Gmail files a message into INBOX and All Mail
 * simultaneously, but a first-contact sender can land in Spam instead — and a
 * test that reports "never arrived" when the mail is actually sitting in Spam
 * sends you hunting in entirely the wrong direction.
 */
const SEARCH_MAILBOXES = ['INBOX', '[Gmail]/All Mail', '[Gmail]/Spam']

/**
 * Poll until a message whose subject contains `token` shows up.
 *
 * A fresh connection per poll, deliberately. Holding one mailbox lock open and
 * searching inside it repeatedly keeps hitting the snapshot taken when the
 * mailbox was selected, so mail arriving mid-wait is invisible and the call
 * times out while the message sits in the inbox. Reconnecting costs a second
 * per poll and is the difference between working and not.
 *
 * Throws on timeout — a silent null would turn every downstream assertion into
 * a confusing "undefined" failure.
 */
export async function waitForMessage(
  token: string,
  opts: WaitOptions = {},
): Promise<ReceivedMessage> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const pollMs = opts.pollMs ?? 5_000
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const found = await findOnce(token)
      if (found) return found
    } catch (err) {
      lastError = err // transient IMAP hiccup — keep polling until the deadline
    }
    await sleep(pollMs)
  }

  throw new Error(
    `no message with token "${token}" arrived within ${timeoutMs}ms. ` +
      'Check SendGrid activity — sandbox mode never delivers, and a suppressed ' +
      'or unverified sender is silently dropped.' +
      (lastError ? ` Last IMAP error: ${(lastError as Error).message}` : ''),
  )
}

/** One connect → search every mailbox → disconnect cycle. */
async function findOnce(token: string): Promise<ReceivedMessage | null> {
  const client = await connect()
  try {
    for (const mailbox of SEARCH_MAILBOXES) {
      let lock
      try {
        lock = await client.getMailboxLock(mailbox)
      } catch {
        continue // mailbox not present on this account
      }
      try {
        const found = await searchOpenMailbox(client, token)
        if (found) return found
      } finally {
        lock.release()
      }
    }
    return null
  } finally {
    await client.logout().catch(() => {})
  }
}

async function searchOpenMailbox(client: ImapFlow, token: string): Promise<ReceivedMessage | null> {
  // Primary: server-side subject search. Secondary: scan recent envelopes for
  // the token in the subject OR the plus-tagged recipient — a subject carrying
  // non-ASCII is RFC 2047 encoded on the wire, which can defeat a raw
  // substring search that the To header still satisfies.
  let uids = await client.search({ header: { subject: token } }, { uid: true }).catch(() => [])

  if (!uids || uids.length === 0) {
    const recent = await client
      .search({ since: new Date(Date.now() - 60 * 60_000) }, { uid: true })
      .catch(() => [])
    const matches: number[] = []
    for (const uid of (recent || []).slice(-40)) {
      const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true }).catch(() => null)
      // fetchOne resolves to `false` when the uid is gone; `!msg` covers it.
      if (!msg || !msg.envelope) continue
      const subject = decodeHeaderValue(msg.envelope.subject ?? '')
      const to = (msg.envelope.to ?? []).map((a: { address?: string }) => a.address ?? '').join(',')
      if (subject.includes(token) || to.includes(token)) matches.push(uid)
    }
    uids = matches
  }

  if (!uids || uids.length === 0) return null

  // Newest wins if a retry ever produced two.
  const uid = uids[uids.length - 1]!
  const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true })
  if (!msg || !msg.source) return null

  return parseRaw(msg.source.toString('utf8'))
}

/**
 * Minimal MIME parse — enough to assert on the two body parts and the headers.
 * A full parser (mailparser) would be another dependency for no extra signal
 * at this scale; if the live tier ever needs attachments or nested multiparts,
 * swap this out rather than growing it.
 */
export function parseRaw(raw: string): ReceivedMessage {
  const { headers, body } = splitHeaders(raw)
  const contentType = headers['content-type'] ?? ''
  const boundary = /boundary="?([^";\s]+)"?/i.exec(contentType)?.[1]

  let html = ''
  let text = ''

  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const trimmed = part.trim()
      if (!trimmed || trimmed === '--') continue
      const parsed = splitHeaders(trimmed + '\r\n')
      const partType = parsed.headers['content-type'] ?? ''
      const decoded = decodeBody(parsed.body, parsed.headers['content-transfer-encoding'])
      if (/text\/html/i.test(partType)) html = decoded
      else if (/text\/plain/i.test(partType)) text = decoded
    }
  } else {
    const decoded = decodeBody(body, headers['content-transfer-encoding'])
    if (/text\/html/i.test(contentType)) html = decoded
    else text = decoded
  }

  return {
    subject: decodeHeaderValue(headers.subject ?? ''),
    from: headers.from ?? '',
    to: headers.to ?? '',
    html,
    text,
    headers,
    isMultipartAlternative: html.length > 0 && text.length > 0,
  }
}

function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const separator = /\r?\n\r?\n/.exec(raw)
  const headerBlock = separator ? raw.slice(0, separator.index) : raw
  const body = separator ? raw.slice(separator.index + separator[0].length) : ''

  const headers: Record<string, string> = {}
  // Unfold continuation lines before splitting on ':'.
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  return { headers, body }
}

function decodeBody(body: string, encoding?: string): string {
  const enc = (encoding ?? '').toLowerCase()
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (enc === 'quoted-printable') {
    // Decode to BYTES first, then interpret as UTF-8. Mapping each =XX escape
    // straight to a JS char code yields latin1 and turns every multi-byte
    // character into mojibake ("Ã¼" for "ü"), which is exactly the kind of
    // corruption a delivered-mail test exists to catch.
    const unfolded = body.replace(/=\r?\n/g, '') // soft line breaks
    const bytes: number[] = []
    for (let i = 0; i < unfolded.length; i++) {
      const ch = unfolded[i]!
      if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
        bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16))
        i += 2
      } else {
        // Non-escaped characters are 7-bit ASCII by definition of QP.
        bytes.push(ch.charCodeAt(0) & 0xff)
      }
    }
    return Buffer.from(bytes).toString('utf8')
  }
  return body
}

/** Decode RFC 2047 encoded-words, so a unicode subject compares as written. */
export function decodeHeaderValue(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, kind, payload) => {
    const buf =
      kind.toUpperCase() === 'B'
        ? Buffer.from(payload, 'base64')
        : Buffer.from(payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          ), 'binary')
    try {
      return new TextDecoder(String(charset)).decode(buf)
    } catch {
      return buf.toString('utf8')
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
