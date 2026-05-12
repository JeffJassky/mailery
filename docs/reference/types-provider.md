# MailProvider

```ts
import type { MailProvider, SendArgs, SendResult, NormalizedEvent } from 'mailery'
```

The interface every provider implements. Roughly 80-150 lines per implementation.

## MailProvider

```ts
interface MailProvider {
  readonly name: string

  /** Per-provider send-rate cap. Used by the BullMQ group limiter. */
  readonly sendRatePerSecond?: number

  send(args: SendArgs): Promise<SendResult>

  /** Verify an inbound webhook is authentically from this provider. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<boolean>

  /** Normalize a verified webhook payload into our shared event shape. */
  parseWebhookEvents(payload: unknown, headers: Record<string, string>): NormalizedEvent[]
}
```

## SendArgs

```ts
interface SendArgs {
  to: string
  fromName: string
  fromEmail: string
  replyTo?: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>             // e.g. List-Unsubscribe
  messageMeta?: Record<string, string>          // e.g. { sendId: '...' } — surfaced in webhook events for correlation
}
```

## SendResult

```ts
interface SendResult {
  providerId: string                            // provider's message ID, used to correlate webhook events
  status: 'accepted' | 'rejected'
  raw?: unknown                                 // for debugging
}
```

## NormalizedEvent

```ts
interface NormalizedEvent {
  type: 'delivered' | 'open' | 'click' | 'bounce' | 'complaint' | 'unsubscribe' | 'spam_report'
  providerEventId: string                       // for dedupe (provider's unique id)
  providerMessageId: string                     // ties event back to a SendResult.providerId
  email: string                                 // recipient
  occurredAt: Date
  details: {
    bounceType?: 'hard' | 'soft'
    bounceReason?: string
    clickedUrl?: string
    userAgent?: string
    ipAddress?: string
  }
}
```

## Implementing a new provider

```ts
import type { MailProvider, SendArgs, SendResult, NormalizedEvent } from 'mailery'

export class MyProvider implements MailProvider {
  readonly name = 'myprovider'
  readonly sendRatePerSecond = 25

  constructor(private apiKey: string) {}

  async send(args: SendArgs): Promise<SendResult> {
    const res = await fetch('https://api.myprovider.com/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${args.fromName} <${args.fromEmail}>`,
        to: args.to,
        replyTo: args.replyTo,
        subject: args.subject,
        html: args.html,
        text: args.text,
        headers: args.headers,
        metadata: args.messageMeta,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`myprovider ${res.status}: ${body}`)
    }

    const body = await res.json()
    return {
      providerId: body.message_id,
      status: 'accepted',
      raw: body,
    }
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<boolean> {
    const sig = headers['x-myprovider-signature']
    if (!sig) return false
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex')
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  }

  parseWebhookEvents(payload: any): NormalizedEvent[] {
    const events: any[] = Array.isArray(payload) ? payload : payload.events ?? []
    return events
      .map((e) => normalize(e))
      .filter((e): e is NormalizedEvent => e !== null)
  }
}

function normalize(e: any): NormalizedEvent | null {
  const typeMap: Record<string, NormalizedEvent['type']> = {
    delivered: 'delivered',
    opened: 'open',
    clicked: 'click',
    hardbounced: 'bounce',
    softbounced: 'bounce',
    complained: 'complaint',
    unsubscribed: 'unsubscribe',
  }
  const type = typeMap[e.event]
  if (!type) return null
  return {
    type,
    providerEventId: String(e.id),
    providerMessageId: String(e.message_id),
    email: String(e.recipient).toLowerCase(),
    occurredAt: new Date(e.timestamp),
    details: {
      bounceType: e.event === 'hardbounced' ? 'hard' : e.event === 'softbounced' ? 'soft' : undefined,
      bounceReason: e.reason,
      clickedUrl: e.url,
      userAgent: e.user_agent,
      ipAddress: e.ip,
    },
  }
}
```

Then plug it in:

```ts
const mailer = await Mailer.init({
  providers: { myprovider: new MyProvider(API_KEY) },
  defaultProvider: 'myprovider',
  // ...
})
```

## Provider responsibilities

- **`send()`**: don't add tracking — mailery does that itself before calling you. Pass `args.html` / `args.text` verbatim. Surface `args.messageMeta` to the provider's metadata/custom-args mechanism so webhook events can be correlated.
- **Provider-side tracking**: disable it. mailery handles open pixels + click rewrites itself.
- **`verifyWebhook`**: return `false` for any malformed / unsigned input. Never throw — the public router treats a thrown error as a 500.
- **`parseWebhookEvents`**: drop unknown event types (return `[]` for unrecognized payloads). Don't throw.

## Rate limiting

`sendRatePerSecond` is consulted by the BullMQ send worker's group limiter. Set it conservatively for your provider's plan — going over their rate limit tanks reputation.

If the provider rate-limits per-account vs per-domain, mailery's per-provider rate limit is per-account (one provider instance = one cap). To split caps across domains, use multiple provider instances with distinct names.

## Built-in providers

- [`SendGridProvider`](/reference/providers#sendgridprovider)
- [`NullProvider`](/reference/providers#nullprovider)

Postmark / SES / Resend are designed in `plans/05-providers.md` but not yet implemented.
