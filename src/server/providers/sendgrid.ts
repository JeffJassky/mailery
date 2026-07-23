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

export interface SendGridProviderOptions {
  apiKey: string
  /** ECDSA public key (PEM) from SendGrid → Settings → Mail Settings → Signed Event Webhook. */
  webhookVerificationKey?: string
  /** Send-rate cap per second (BullMQ group limiter consults this). */
  sendRatePerSecond?: number
  /** Sandbox mode bypasses actual delivery — useful in dev/test. */
  sandbox?: boolean
}

const SG_SIG_HEADER = 'x-twilio-email-event-webhook-signature'
const SG_TS_HEADER = 'x-twilio-email-event-webhook-timestamp'

export class SendGridProvider implements MailProvider {
  readonly name = 'sendgrid'
  readonly sendRatePerSecond: number

  constructor(private readonly opts: SendGridProviderOptions) {
    sgMail.setApiKey(opts.apiKey)
    this.sendRatePerSecond = opts.sendRatePerSecond ?? 10
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
    if (!this.opts.webhookVerificationKey) return false
    const sig = headers[SG_SIG_HEADER]
    const ts = headers[SG_TS_HEADER]
    if (!sig || !ts) return false

    const payload = Buffer.concat([Buffer.from(ts, 'utf8'), rawBody])
    try {
      const verifier = crypto.createVerify('sha256')
      verifier.update(payload)
      return verifier.verify(this.opts.webhookVerificationKey, sig, 'base64')
    } catch {
      return false
    }
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
