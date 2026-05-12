# 05 — Send Providers

The library never talks to SMTP directly. It always sends through a transactional email provider. Provider-specific quirks (auth, payload shape, webhook format, signature verification) are hidden behind a uniform interface.

## The interface

```ts
export interface MailProvider {
  /** Identifier, e.g. 'sendgrid'. Matches the webhook URL path. */
  readonly name: string

  /** Send a single message. */
  send(args: SendArgs): Promise<SendResult>

  /** Verify an inbound webhook is authentically from this provider. */
  verifyWebhook(req: Request): Promise<boolean>

  /** Normalize a webhook payload into our internal event shape. */
  parseWebhookEvents(payload: unknown, headers: Record<string, string>): NormalizedEvent[]
}

export interface SendArgs {
  to: string
  fromName: string
  fromEmail: string
  replyTo?: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>             // e.g. List-Unsubscribe
  messageMeta?: Record<string, string>          // tag/custom-args for tracking
  attachments?: Attachment[]                    // future; not in V1
}

export interface SendResult {
  providerId: string                            // their message ID, for webhook correlation
  status: 'accepted' | 'rejected'
  raw?: any                                     // for debugging
}

export interface NormalizedEvent {
  type: 'delivered' | 'open' | 'click' | 'bounce' | 'complaint' | 'unsubscribe' | 'spam_report'
  providerMessageId: string
  email: string
  occurredAt: Date
  details: {
    // Type-specific
    bounceType?: 'hard' | 'soft'
    bounceReason?: string
    clickedUrl?: string                          // for click events
    userAgent?: string                           // for open/click
    ipAddress?: string
  }
}
```

## Adapter 1: `SendGridProvider`

The reference implementation. SendGrid is mature, well-documented, available in most jurisdictions, has solid free + paid tiers, supports event webhooks.

```ts
import sgMail from '@sendgrid/mail'
import crypto from 'crypto'

export class SendGridProvider implements MailProvider {
  readonly name = 'sendgrid'

  constructor(private opts: {
    apiKey: string,
    webhookVerificationKey: string,         // ECDSA public key from SendGrid dashboard
  }) {
    sgMail.setApiKey(opts.apiKey)
  }

  async send(args: SendArgs): Promise<SendResult> {
    const msg = {
      to: args.to,
      from: { name: args.fromName, email: args.fromEmail },
      replyTo: args.replyTo,
      subject: args.subject,
      text: args.text,
      html: args.html,
      headers: args.headers,
      customArgs: args.messageMeta,           // surfaced in webhooks for correlation
      trackingSettings: {
        // We do our own click/open tracking. Disable SendGrid's to avoid double-rewriting.
        clickTracking: { enable: false },
        openTracking: { enable: false },
      },
      mailSettings: {
        sandboxMode: { enable: this.opts.sandbox ?? false },
      },
    }

    const [response] = await sgMail.send(msg)
    return {
      providerId: response.headers['x-message-id'] as string,
      status: response.statusCode < 300 ? 'accepted' : 'rejected',
      raw: response,
    }
  }

  async verifyWebhook(req: Request): Promise<boolean> {
    const signature = req.headers['x-twilio-email-event-webhook-signature'] as string
    const timestamp = req.headers['x-twilio-email-event-webhook-timestamp'] as string
    if (!signature || !timestamp) return false

    const payload = timestamp + (req as any).rawBody
    const verifier = crypto.createVerify('sha256')
    verifier.update(payload)
    return verifier.verify(this.opts.webhookVerificationKey, signature, 'base64')
  }

  parseWebhookEvents(payload: any[], headers: Record<string, string>): NormalizedEvent[] {
    // SendGrid sends an array of events
    return payload.map(event => ({
      type: mapEventType(event.event),
      providerMessageId: event.sg_message_id ?? event['smtp-id'],
      email: event.email,
      occurredAt: new Date(event.timestamp * 1000),
      details: {
        bounceType: event.event === 'bounce' ? (event.type === 'bounce' ? 'hard' : 'soft') : undefined,
        bounceReason: event.reason,
        clickedUrl: event.url,
        userAgent: event.useragent,
        ipAddress: event.ip,
      },
    }))
  }
}

function mapEventType(sgEvent: string): NormalizedEvent['type'] {
  switch (sgEvent) {
    case 'delivered':       return 'delivered'
    case 'open':            return 'open'
    case 'click':           return 'click'
    case 'bounce':          return 'bounce'
    case 'dropped':         return 'bounce'           // map to bounce; details.bounceReason explains
    case 'spamreport':      return 'spam_report'
    case 'unsubscribe':
    case 'group_unsubscribe':
      return 'unsubscribe'
    default: throw new Error(`unhandled SendGrid event: ${sgEvent}`)
  }
}
```

Notes on the SendGrid integration:

- **Disable SendGrid's click and open tracking.** We do our own (see [`07-tracking.md`](./07-tracking.md)) — letting SendGrid also rewrite would produce double-rewrites and break click metrics.
- **Pass `customArgs.sendId`** so when webhook events come back we know which `sends` row they belong to (cheaper than looking up by `providerMessageId`).
- **Sandbox mode** is exposed for dev/test environments — emails are validated and "sent" but not actually delivered.

## Adapter stubs (V1 design, V2 implementation)

Designed so they fit the interface but bodies are TODOs:

- `PostmarkProvider` — clean dev experience, excellent deliverability
- `SESProvider` — best for high-volume, AWS-shop apps
- `ResendProvider` — modern, dev-first, simple API
- `MailerSendProvider` — alternative if cost is a concern

V1 ships SendGrid only. The stubs ensure the interface is the right shape — we can add them when needed.

## Provider selection at send time

The mailer accepts a default provider in config:

```ts
const mailer = await Mailer.init({
  providers: {
    sendgrid: new SendGridProvider({ apiKey: '...' }),
    postmark: new PostmarkProvider({ ... }),
  },
  defaultProvider: 'sendgrid',
})
```

Individual templates may override:

```ts
// in mailer_templates
{ providerOverride: 'postmark', ... }
```

And individual send steps in flows can override further:

```ts
// in flow step
{ type: 'send', templateSlug: 'critical-receipt', providerOverride: 'postmark' }
```

Selection priority: step override > template override > default.

A typical use case: route **transactional** templates (receipts, password resets) through Postmark for the best inbox placement, route **marketing** templates through SendGrid where they're priced for volume.

## Webhook handling

Mounted at `/m/webhooks/<provider>` (e.g. `/m/webhooks/sendgrid`). Single handler:

```ts
app.post('/m/webhooks/:provider', async (req, res) => {
  const provider = providers[req.params.provider]
  if (!provider) return res.status(404).end()

  const valid = await provider.verifyWebhook(req)
  if (!valid) return res.status(401).end()

  const events = provider.parseWebhookEvents(req.body, req.headers as any)
  await Promise.all(events.map(handleNormalizedEvent))

  res.status(200).end()
})
```

`handleNormalizedEvent` looks up the relevant `sends` row by `providerMessageId` (or by `messageMeta.sendId` if present), updates status, and cascades:

- `delivered` → `sends.deliveredAt = event.occurredAt; status = 'delivered'`
- `open` → `sends.openedAt ??= event.occurredAt; sends.openCount += 1; sends.status = 'delivered'` (still considered delivered, opens are extra)
- `click` → `sends.firstClickAt ??= event.occurredAt; sends.clickCount += 1; sends.clickedLinks.push(...)`
- `bounce.hard` → suppress contact (add to `mailer_suppressions`); `contact.status = 'bounced'`
- `bounce.soft` → no suppression, just log
- `complaint` → suppress; `contact.status = 'complained'`
- `unsubscribe` → `contact.status = 'unsubscribed'`; add to suppressions; mark active flow_runs as exited

## Configuration

```ts
SendGridProvider({
  apiKey: process.env.SENDGRID_API_KEY,
  webhookVerificationKey: process.env.SENDGRID_WEBHOOK_PUBLIC_KEY,
  sandbox: process.env.NODE_ENV !== 'production',
})
```

Required setup on SendGrid side (one-time, documented in README):

1. Authenticate sender domain (SPF, DKIM, DMARC)
2. Configure event webhook → POST to `https://yourdomain.com/m/webhooks/sendgrid`
3. Enable event types: delivered, open, click, bounce, dropped, spamreport, unsubscribe
4. Generate Signed Event Webhook public key, store as `SENDGRID_WEBHOOK_PUBLIC_KEY`

Same template followed by Postmark/SES/Resend in their respective adapters.

## Testing providers

A `NullProvider` ships for tests:

```ts
export class NullProvider implements MailProvider {
  readonly name = 'null'
  public sent: SendArgs[] = []

  async send(args: SendArgs): Promise<SendResult> {
    this.sent.push(args)
    return { providerId: `null-${Date.now()}`, status: 'accepted' }
  }
  async verifyWebhook(): Promise<boolean> { return true }
  parseWebhookEvents(): NormalizedEvent[] { return [] }
}
```

Use it in unit tests by passing as `defaultProvider`. Inspect `nullProvider.sent` to assert what would have gone out.
