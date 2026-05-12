# Providers

```ts
import { SendGridProvider, NullProvider } from 'mailery'
```

## SendGridProvider

### Constructor

```ts
new SendGridProvider({
  apiKey: string                            // required — SendGrid API key
  webhookVerificationKey?: string           // ECDSA public key (PEM) for event webhook signature verification
  sendRatePerSecond?: number                // default 10 (shared IP); raise for dedicated IPs
  sandbox?: boolean                         // default false; true validates without delivering
})
```

### Behavior

- Calls `@sendgrid/mail` `sgMail.send()`.
- Disables SendGrid's own click + open tracking (mailery does its own).
- Adds `customArgs: { sendId: ... }` for webhook event correlation.
- `verifyWebhook` uses HMAC-SHA256 over `${timestamp}${rawBody}` against the ECDSA public key.
- `parseWebhookEvents` normalizes SendGrid's event array into `NormalizedEvent[]`:
  - `delivered` → `delivered`
  - `open` → `open`
  - `click` → `click`
  - `bounce` (`type: 'bounce'`) → `bounce` (`bounceType: 'hard'`)
  - `bounce` (`type: 'blocked'`) → `bounce` (`bounceType: 'soft'`)
  - `dropped` → `bounce`
  - `spamreport` → `spam_report`
  - `unsubscribe`, `group_unsubscribe` → `unsubscribe`

### Properties

| | |
|---|---|
| `name` | `'sendgrid'` |
| `sendRatePerSecond` | as configured (default 10) |

### Setup checklist (SendGrid dashboard)

1. **Authenticate sender domain** — SPF, DKIM, DMARC.
2. **Configure event webhook** — POST to `https://yourdomain.com/m/webhooks/sendgrid`.
3. **Enable event types** — delivered, open, click, bounce, dropped, spamreport, unsubscribe.
4. **Generate Signed Event Webhook public key** — set as `SENDGRID_WEBHOOK_KEY` env var.

## NullProvider

In-memory provider for tests and dev. Records every `send()` call.

```ts
new NullProvider()
```

### Properties

| | |
|---|---|
| `name` | `'null'` |
| `sendRatePerSecond` | `1000` (effectively unlimited) |
| `sent` | `SendArgs[]` — every call appended |

### Methods

- `send(args)` — pushes `args` onto `sent`, returns `{ providerId: 'null-<timestamp>-<counter>', status: 'accepted' }`.
- `verifyWebhook()` — always `true`.
- `parseWebhookEvents()` — always `[]`.
- `reset()` — clears `sent`.

### Use in tests

```ts
import { createTestMailer } from 'mailery/testing'

const { mailer, provider } = await createTestMailer()
await mailer.sendOneOff({ /* ... */ })

expect(provider.sent[0]?.subject).toContain('Welcome')
expect(provider.sent[0]?.to).toBe('alice@example.com')

provider.reset()
```

## Implementing your own provider

See [MailProvider interface](/reference/types-provider) for the contract. Roughly 80-150 lines per provider.
