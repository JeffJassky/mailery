/**
 * SendGridProvider — sends mail through @sendgrid/mail, verifies the Event
 * Webhook signature with the ECDSA public key configured in SendGrid, and
 * normalizes inbound event payloads into our shared shape.
 *
 * Setup steps required on the SendGrid side (one-time):
 *   1. Authenticate sender domain (SPF, DKIM, DMARC).
 *   2. Configure event webhook → POST to https://your.host/m/webhooks/sendgrid
 *   3. Enable: delivered, open, click, bounce, dropped, spamreport, unsubscribe
 *   4. Generate Signed Event Webhook key → store as webhookVerificationKey
 */

import crypto from 'node:crypto'
import sgMail from '@sendgrid/mail'

import type {
  MailProvider,
  NormalizedEvent,
  SendArgs,
  SendResult,
} from '../../shared/types.js'
import {
  isWebhookTimestampFresh,
  resolveWebhookToleranceSeconds,
  type WebhookToleranceOption,
} from './webhook-tolerance.js'

export interface SendGridProviderOptions {
  apiKey: string
  /**
   * ECDSA public key from SendGrid → Settings → Mail Settings → Signed Event
   * Webhook. Either form SendGrid hands out is accepted: the single-line
   * base64 string its dashboard shows and its API returns as `public_key`
   * (what `mailery setup-sendgrid` prints), or the same key as a PEM block.
   * A PEM whose newlines were escaped to `\n` for an .env line is unescaped.
   * Anything that does not parse as a public key throws at construction —
   * a key that silently verifies nothing is the failure this replaces.
   */
  webhookVerificationKey?: string
  /**
   * Replay window for the signed webhook timestamp, in seconds.
   * Defaults to 300 (5 minutes). A signed payload older — or more than this
   * far in the future — than the window is rejected, so a captured request
   * can't be replayed indefinitely.
   *
   * Set `0` or `false` to disable the check, for hosts whose proxy or queue
   * legitimately delays webhook delivery past the window.
   */
  webhookToleranceSeconds?: WebhookToleranceOption
  /** Send-rate cap per second (BullMQ group limiter consults this). */
  sendRatePerSecond?: number
  /** Sandbox mode bypasses actual delivery — useful in dev/test. */
  sandbox?: boolean
}

const SG_SIG_HEADER = 'x-twilio-email-event-webhook-signature'
const SG_TS_HEADER = 'x-twilio-email-event-webhook-timestamp'

const PEM_HEADER = '-----BEGIN PUBLIC KEY-----'
const PEM_FOOTER = '-----END PUBLIC KEY-----'

/**
 * Turn whatever SendGrid gave the operator into something Node's `crypto`
 * will verify with.
 *
 * SendGrid's dashboard and its `/user/webhooks/event/settings/signed` API
 * both present the verification key as a bare base64 SPKI string
 * (`MFkwEwYHKoZI…`). `crypto.verify` only reads PEM (or a KeyObject), and
 * handed the bare string it throws `DECODER routines::unsupported` — which
 * `verifyWebhook` used to catch and report as "signature invalid". The result
 * was a webhook that answered 401 to every genuine event while the key looked
 * perfectly configured. This accepts the bare string, a PEM block, and a PEM
 * block whose newlines were escaped for an env file, and refuses anything
 * else out loud.
 */
export function normalizeWebhookVerificationKey(input: string): string {
  let key = String(input ?? '').trim().replace(/^["']|["']$/g, '')
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n')
  let pem: string
  if (key.includes(PEM_HEADER)) {
    pem = key
  } else {
    const b64 = key.replace(/\s+/g, '')
    if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
      throw new Error(
        'SendGridProvider: webhookVerificationKey is neither a PEM public key nor a base64 SPKI key. ' +
          'Copy the Verification Key from SendGrid → Settings → Mail Settings → Signed Event Webhook.',
      )
    }
    pem = `${PEM_HEADER}\n${b64.match(/.{1,64}/g)!.join('\n')}\n${PEM_FOOTER}\n`
  }
  try {
    crypto.createPublicKey(pem)
  } catch (err: any) {
    throw new Error(
      `SendGridProvider: webhookVerificationKey did not parse as a public key (${String(err?.message ?? err)}). ` +
        'Copy the Verification Key from SendGrid → Settings → Mail Settings → Signed Event Webhook.',
    )
  }
  return pem
}

export class SendGridProvider implements MailProvider {
  readonly name = 'sendgrid'
  readonly sendRatePerSecond: number
  /** Resolved replay window in seconds; `0` means the check is disabled. */
  readonly webhookToleranceSeconds: number
  /** The verification key as PEM, whatever shape it was configured in. */
  private readonly verificationKeyPem: string | null

  constructor(private readonly opts: SendGridProviderOptions) {
    sgMail.setApiKey(opts.apiKey)
    this.sendRatePerSecond = opts.sendRatePerSecond ?? 10
    this.webhookToleranceSeconds = resolveWebhookToleranceSeconds(opts.webhookToleranceSeconds)
    this.verificationKeyPem = opts.webhookVerificationKey
      ? normalizeWebhookVerificationKey(opts.webhookVerificationKey)
      : null
  }

  async send(args: SendArgs): Promise<SendResult> {
    const msg: sgMail.MailDataRequired = {
      to: args.to,
      from: { name: args.fromName, email: args.fromEmail },
      replyTo: args.replyTo,
      subject: args.subject,
      text: args.text,
      // Omit the key entirely rather than sending `html: undefined` — a
      // text_only template must produce a single-part text/plain message, and
      // an explicit undefined can still serialize into an empty HTML part.
      ...(args.html ? { html: args.html } : {}),
      headers: args.headers,
      customArgs: args.messageMeta,
      trackingSettings: {
        // We do our own click/open tracking — let provider stay out of it.
        clickTracking: { enable: false, enableText: false },
        openTracking: { enable: false },
      },
      mailSettings: {
        sandboxMode: { enable: this.opts.sandbox ?? false },
      },
    }

    const [response] = await sgMail.send(msg)
    const providerId =
      (response.headers['x-message-id'] as string | undefined) ?? `sg-${Date.now()}`
    return {
      providerId,
      status: response.statusCode < 300 ? 'accepted' : 'rejected',
      raw: response,
    }
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<boolean> {
    if (!this.verificationKeyPem) return false
    const sig = headers[SG_SIG_HEADER]
    const ts = headers[SG_TS_HEADER]
    if (!sig || !ts) return false

    const payload = Buffer.concat([Buffer.from(ts, 'utf8'), rawBody])
    try {
      const verifier = crypto.createVerify('sha256')
      verifier.update(payload)
      if (!verifier.verify(this.verificationKeyPem, sig, 'base64')) return false
    } catch {
      return false
    }

    // Signature checks out, so the timestamp is authentic — but authentic is
    // not the same as current. Reject outside the replay window (both stale
    // and implausibly future) so a captured request has a five-minute life,
    // not an unbounded one. Signature first, freshness second, mirroring the
    // verify-then-expiry order in ../tokens.ts.
    return isWebhookTimestampFresh(ts, this.webhookToleranceSeconds)
  }

  parseWebhookEvents(payload: unknown): NormalizedEvent[] {
    if (!Array.isArray(payload)) return []
    return payload
      .map((raw) => normalizeSendGridEvent(raw))
      .filter((e): e is NormalizedEvent => e !== null)
  }
}

function normalizeSendGridEvent(e: any): NormalizedEvent | null {
  const type = mapEventType(e.event)
  if (!type) return null
  return {
    type,
    providerEventId: String(e.sg_event_id ?? e['smtp-id'] ?? `${e.event}-${e.timestamp}-${e.email}`),
    providerMessageId: String(e.sg_message_id ?? e['smtp-id'] ?? ''),
    email: String(e.email ?? '').toLowerCase(),
    occurredAt: new Date(Number(e.timestamp) * 1000),
    details: {
      bounceType:
        e.event === 'bounce' ? (e.type === 'bounce' ? 'hard' : 'soft') : undefined,
      bounceReason: e.reason,
      clickedUrl: e.url,
      userAgent: e.useragent,
      ipAddress: e.ip,
    },
  }
}

function mapEventType(sgEvent: string): NormalizedEvent['type'] | null {
  switch (sgEvent) {
    case 'delivered':
      return 'delivered'
    case 'open':
      return 'open'
    case 'click':
      return 'click'
    case 'bounce':
    case 'dropped':
      return 'bounce'
    case 'spamreport':
      return 'spam_report'
    case 'unsubscribe':
    case 'group_unsubscribe':
      return 'unsubscribe'
    default:
      return null
  }
}
