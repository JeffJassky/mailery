/**
 * Inbound DMARC aggregate-report webhook.
 *
 * DMARC RUA reports arrive as email. The usual way to turn that email into an
 * HTTP request is SendGrid Inbound Parse, and until v0.15 the documented setup
 * pointed Inbound Parse at `/admin/mailer/api/dmarc/upload` — a route behind
 * the host's `requireAdmin` guard, which Inbound Parse cannot satisfy. So the
 * documented setup either did not work, or worked because somebody removed the
 * guard from an admin router. This route replaces that advice.
 *
 * ## Read this before enabling it
 *
 * **Inbound Parse does not sign its payloads.** The SendGrid *Event Webhook*
 * does — see `providers/sendgrid.ts`, where signature verification and the
 * replay window live — but Inbound Parse is a different product and offers no
 * signature, no HMAC and no verifiable identity. There is nothing to verify.
 *
 * So this is, structurally, an unauthenticated file-accepting endpoint on a
 * public router, and the design has to own that rather than dress it up:
 *
 * 1. **Off unless configured.** No `dmarcInbound.secret`, no route — not a
 *    404 handler, no route registered at all. An endpoint like this appearing
 *    on an upgrade because someone shipped a default would be indefensible.
 * 2. **A shared secret, checked first.** The secret is compared with
 *    `timingSafeEqual` before multer is allowed to read a single byte of the
 *    body, so an unauthenticated caller cannot make us buffer 10MB.
 * 3. **Hard size and count limits**, matching the admin upload's shape.
 * 4. **A domain cross-check.** A report whose `<policy_published><domain>` is
 *    not a domain this deployment sends from is rejected. If the secret leaks,
 *    the attacker gets to inject rows about *your* domains, which is bounded
 *    and visible, instead of arbitrary garbage.
 * 5. **The existing parser.** `runner/dmarc.ts` already caps decompressed
 *    bytes, validates declared-vs-actual sizes, checks compression ratio and
 *    guards zip-slip. This route does not parse anything itself.
 *
 * ## Why a shared secret, and where it goes
 *
 * The three options that don't need a signature:
 *
 * - **Source IP allowlist.** Rejected as the primary control. SendGrid does
 *   not publish a stable Inbound Parse egress range, and behind a proxy
 *   `req.ip` is the proxy's address unless the host has set `trust proxy`
 *   correctly — which this library cannot verify and must not assume. An
 *   allowlist that silently matches the wrong address either locks out the
 *   real sender or admits everyone. Put an allowlist in your ingress if you
 *   want one; it is a good second layer and a bad only layer.
 * - **Secret in the path.** Works, and is the fallback, but a URL path is
 *   logged by every proxy, load balancer and access log between SendGrid and
 *   you. Supported implicitly: nothing stops you making `path` unguessable.
 * - **Secret in the `Authorization` header.** The default and the
 *   recommendation. Inbound Parse cannot set custom headers, but its
 *   destination URL accepts embedded basic-auth credentials
 *   (`https://mailery:SECRET@example.com/m/inbound/dmarc`), which travel as an
 *   `Authorization` header rather than in the request line. `Bearer` is
 *   accepted too, for hosts forwarding from something other than SendGrid.
 *
 * A leaked secret gets an attacker exactly one capability: inserting DMARC
 * report rows for domains you already send from. No mail is sent, no contact
 * data is touched, nothing is deleted. Rotate it by changing the config value
 * and the Inbound Parse destination URL.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request, Response, Router } from 'express'
import multer from 'multer'

import { ingestDmarcAttachment } from '../runner/dmarc.js'
import type { Mailer } from '../mailer.js'
import { wrap, type RouteLogger } from './wrap.js'

/** One attachment lifted off an inbound request by a `parseInbound` seam. */
export interface InboundAttachment {
  filename: string
  buffer: Buffer
}

/**
 * Pull DMARC attachments out of a provider's inbound-email payload.
 *
 * The seam exists so Mailgun's and Postmark's inbound routes can be added
 * without touching this route's auth, limits or ingest path. Only the SendGrid
 * shape is implemented today.
 */
export type InboundParser = (req: Request) => InboundAttachment[]

export interface DmarcInboundOptions {
  /**
   * Shared secret the caller must present. **Absent or empty → the route is
   * not mounted at all.**
   *
   * Accepted as HTTP Basic (any username; the password is compared) or as
   * `Authorization: Bearer <secret>`. Basic is the one to use with SendGrid
   * Inbound Parse, since it can be embedded in the destination URL and so
   * stays out of access logs.
   */
  secret?: string
  /** Sub-path on the public router. Default `/inbound/dmarc`. */
  path?: string
  /** Per-file cap. Default 10MB, matching the admin upload. */
  maxFileSizeBytes?: number
  /** Attachments accepted per request. Default 10. */
  maxFiles?: number
  /**
   * Domains whose reports are accepted. Defaults to every domain in
   * `senderDomains` plus the `fromDefaults` / `transactionalFromDefaults`
   * addresses. Reports for anything else are rejected.
   *
   * If none of those are configured there is nothing to check against, and the
   * route mounts with the domain gate disabled and a warning — configure
   * `senderDomains` to get it back.
   */
  allowedDomains?: string[]
  /** Override the inbound payload shape. Defaults to SendGrid Inbound Parse. */
  parseInbound?: InboundParser
}

/** Extensions a DMARC receiver actually sends. */
const ALLOWED_EXTENSIONS = ['.zip', '.gz', '.xml']

const DEFAULT_PATH = '/inbound/dmarc'
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_FILES = 10

/**
 * Mount the inbound route, if it is configured. Returns the mounted path, or
 * null when nothing was mounted — which is the default.
 */
export function mountDmarcInbound(
  router: Router,
  mailer: Mailer,
  opts: DmarcInboundOptions | undefined,
  logger: RouteLogger,
): string | null {
  const secret = opts?.secret
  if (!opts || typeof secret !== 'string' || secret.length === 0) return null

  const routePath = opts.path ?? DEFAULT_PATH
  const parseInbound = opts.parseInbound ?? sendgridInboundParser
  const allowedDomains = normalizeDomains(opts.allowedDomains ?? deriveSenderDomains(mailer))

  if (allowedDomains.size === 0) {
    logger.warn?.(
      { path: routePath },
      'mailery: DMARC inbound route mounted without a domain allowlist — set senderDomains (or dmarcInbound.allowedDomains) so a leaked secret cannot inject reports for arbitrary domains',
    )
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: opts.maxFileSizeBytes ?? DEFAULT_MAX_FILE_BYTES,
      files: opts.maxFiles ?? DEFAULT_MAX_FILES,
      // Inbound Parse sends the whole email as form fields (headers, text,
      // html, ...). We read none of them, but they still have to be bounded.
      fields: 40,
      fieldSize: 1024 * 1024,
    },
  })

  // Order is the security control: authenticate, *then* let multer read the
  // body. Reversed, an anonymous caller could make the process buffer the full
  // upload limit per request.
  router.post(
    routePath,
    wrap(logger, (req: Request, res: Response, next) => {
      if (!isAuthorized(req, secret)) {
        logger.warn?.(
          { path: routePath, ip: req.ip },
          'mailery: DMARC inbound request rejected — bad or missing shared secret',
        )
        // 401 with no WWW-Authenticate challenge: this is a machine endpoint,
        // and prompting a browser for credentials helps nobody.
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      next()
    }),
    (req: Request, res: Response, next: (err?: unknown) => void) => {
      upload.any()(req, res, (err: unknown) => {
        if (!err) return next()
        const code = (err as { code?: string })?.code
        const status = code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_FILE_COUNT' ? 413 : 400
        logger.warn?.({ err, path: routePath }, 'mailery: DMARC inbound upload rejected')
        res.status(status).json({ error: 'upload_rejected', message: String(code ?? 'malformed_multipart') })
      })
    },
    wrap(logger, async (req: Request, res: Response) => {
      let attachments: InboundAttachment[]
      try {
        attachments = parseInbound(req)
      } catch (err) {
        logger.warn?.({ err, path: routePath }, 'mailery: DMARC inbound payload unreadable')
        return res.status(400).json({ error: 'bad_payload' })
      }

      const candidates = attachments.filter((a) => hasAllowedExtension(a.filename))
      if (candidates.length === 0) {
        // A RUA mailbox also receives ordinary mail — auto-replies, a human
        // asking a question. Nothing to ingest is not an error, and answering
        // 4xx would make the provider retry it.
        logger.info?.(
          { path: routePath, attachments: attachments.length },
          'mailery: DMARC inbound message carried no report attachment — ignored',
        )
        return res.status(200).json({ ok: true, ingested: 0, ignored: attachments.length })
      }

      const ctx = mailer.getRunnerContext()
      const allowDomain =
        allowedDomains.size === 0 ? undefined : (d: string) => allowedDomains.has(d.toLowerCase())

      const ingested: Array<{ reportId: string; domain: string; duplicate: boolean }> = []
      const rejected: Array<{ filename: string; message: string }> = []

      for (const file of candidates) {
        try {
          const result = await ingestDmarcAttachment(ctx, file.buffer, file.filename, { allowDomain })
          ingested.push({ reportId: result.reportId, domain: result.domain, duplicate: result.duplicate })
        } catch (err: unknown) {
          const message = String((err as Error)?.message ?? err)
          rejected.push({ filename: file.filename, message })
          logger.warn?.(
            { path: routePath, filename: file.filename, err },
            'mailery: DMARC inbound attachment rejected',
          )
        }
      }

      if (ingested.length === 0) {
        // Nothing usable in a message that claimed to carry a report. 400 so
        // the failure is visible in the provider's activity log rather than
        // disappearing into a 200.
        return res.status(400).json({ error: 'ingest_failed', rejected })
      }
      return res.status(200).json({ ok: true, ingested, rejected })
    }),
  )

  return routePath
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Constant-time shared-secret check over the `Authorization` header.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * secret's length, so both sides are hashed to a fixed width first — the same
 * shape the token helpers use.
 */
export function isAuthorized(req: Request, secret: string): boolean {
  const presented = extractPresentedSecret(req)
  if (presented === null) return false
  return constantTimeEquals(presented, secret)
}

function extractPresentedSecret(req: Request): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null

  const [scheme, ...rest] = header.split(' ')
  const value = rest.join(' ').trim()
  if (!scheme || value === '') return null

  switch (scheme.toLowerCase()) {
    case 'basic': {
      let decoded: string
      try {
        decoded = Buffer.from(value, 'base64').toString('utf8')
      } catch {
        return null
      }
      const sep = decoded.indexOf(':')
      // The username is deliberately ignored: SendGrid's destination URL needs
      // *a* username, and pinning one only adds a way to misconfigure it.
      return sep === -1 ? null : decoded.slice(sep + 1)
    }
    case 'bearer':
      return value
    default:
      return null
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  // sha256 both sides so the comparison is over equal-length buffers no matter
  // what was presented.
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

// ---------------------------------------------------------------------------
// Provider payload shapes
// ---------------------------------------------------------------------------

/**
 * SendGrid Inbound Parse: `multipart/form-data` with the message's fields
 * (`headers`, `from`, `subject`, `text`, ...) plus one file part per
 * attachment, named `attachment1`, `attachment2`, and so on.
 *
 * Read through `multer.any()`, so the field names are not trusted — every file
 * part is a candidate and the extension gate below decides.
 */
export const sendgridInboundParser: InboundParser = (req) => {
  const files = (req as unknown as { files?: unknown }).files
  if (!Array.isArray(files)) return []
  return files
    .filter((f): f is Express.Multer.File => Boolean(f) && Buffer.isBuffer((f as Express.Multer.File).buffer))
    .map((f) => ({ filename: safeFilename(f.originalname), buffer: f.buffer }))
}

/**
 * A provider-supplied filename only ever reaches `extractDmarcXmls`, which
 * reads its extension and nothing else — but it is also logged, so strip path
 * separators and control characters before it goes anywhere.
 */
function safeFilename(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').slice(0, 255)
}

function hasAllowedExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

// ---------------------------------------------------------------------------
// Domain allowlist
// ---------------------------------------------------------------------------

function normalizeDomains(domains: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const d of domains) {
    if (typeof d !== 'string') continue
    const trimmed = d.trim().toLowerCase().replace(/^\.+/, '')
    if (trimmed) out.add(trimmed)
  }
  return out
}

/**
 * Domains this deployment sends from: the `senderDomains` registry plus the
 * From defaults. DMARC reports are published per organizational domain, so a
 * deployment sending from `news.example.com` receives reports whose
 * `policy_published.domain` may be either that or `example.com` — both are
 * included.
 */
function deriveSenderDomains(mailer: Mailer): string[] {
  const out: string[] = []
  const push = (domain: string | undefined) => {
    if (!domain) return
    out.push(domain)
    // The organizational domain the subdomain's DMARC policy is inherited
    // from. Approximated as the last two labels, which is right for
    // `example.com` and over-permissive for a multi-label public suffix like
    // `example.co.uk` — set `dmarcInbound.allowedDomains` explicitly there.
    const labels = domain.split('.')
    if (labels.length > 2) out.push(labels.slice(-2).join('.'))
  }

  for (const domain of Object.keys(mailer.config.senderDomains ?? {})) push(domain.toLowerCase())
  push(emailDomain(mailer.config.fromDefaults?.email))
  push(emailDomain(mailer.config.transactionalFromDefaults?.email))
  push(emailDomain(mailer.config.senderAddress))
  return out
}

function emailDomain(email: string | undefined): string | undefined {
  if (typeof email !== 'string') return undefined
  const at = email.lastIndexOf('@')
  if (at === -1) return undefined
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domain || undefined
}
