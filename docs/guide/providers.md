# Providers

mailery never talks to SMTP directly — sends always route through a transactional email provider. Provider-specific quirks (auth, payload shape, webhook format, signature verification) are hidden behind a uniform interface.

## SendGrid (built in)

```ts
import { SendGridProvider } from 'mailery'

new SendGridProvider({
  apiKey: process.env.SENDGRID_API_KEY!,
  webhookVerificationKey: process.env.SENDGRID_WEBHOOK_KEY!,
  sendRatePerSecond: 10,           // shared IP default; raise on dedicated IP
  sandbox: process.env.NODE_ENV !== 'production',
})
```

### One-time setup on SendGrid side

::: tip Automated path (Cloudflare DNS)
The whole setup below collapses into one command if your DNS is on Cloudflare: `npx mailery setup-sendgrid --domain X --webhook-url Y --cloudflare`. It's idempotent and safe to re-run. See [Deliverability → Automated setup](./deliverability#automated-setup-cloudflare) for the full walkthrough.
:::

#### 1. Authenticate your sender domain (SPF / DKIM / DMARC)

Without DKIM, expect <10% inbox placement at Gmail. Full step-by-step is in [Deliverability → SendGrid setup](./deliverability#sendgrid-setup) — covers the dashboard path, the DNS records to add, and how to verify everything is passing.

Short version:
- SendGrid dashboard → **Settings → Sender Authentication → Authenticate Your Domain**
- Add the 3-5 CNAMEs SendGrid generates to your DNS provider
- Add an SPF TXT record (`v=spf1 include:sendgrid.net ~all` if you don't have one yet)
- Add a DMARC TXT record at `_dmarc.yourdomain.com` (start with `p=none` for monitoring)

If you're running [separate marketing and transactional domains](./deliverability#reputation-isolation-separate-domains-for-marketing-vs-transactional), authenticate each domain separately — each gets its own DKIM key and reputation.

#### 2. Configure the Event Webhook (mailery's inbound signal)

The event webhook is how SendGrid tells mailery what happened to each send (delivered, bounced, opened, clicked, complained, unsubscribed). Without it, mailery can't update send records or maintain suppression.

SendGrid dashboard → **Settings → Mail Settings → Event Webhook**:

- **HTTP Post URL**: `https://yourdomain.com/m/webhooks/sendgrid` (must be reachable from the public internet, **not** behind your admin auth)
- **Actions to be POSTed**: check **delivered**, **open**, **click**, **bounce**, **dropped**, **spamreport**, **unsubscribe**. Skip **deferred** (mailery treats it as a soft bounce; SendGrid retries internally) and **processed** (noise — every send produces one).
- Toggle **Event Webhook Status** to **Enabled**.
- Save.

#### 3. Generate the Signed Event Webhook key

Same settings page, scroll to **Signed Event Webhook**:

- Click **Enable Signing** if not already on.
- SendGrid generates an **ECDSA public verification key** (PEM format).
- Click **Test Your Integration** to confirm SendGrid can reach the URL.
- Copy the **Verification Key** (it's a multi-line PEM block starting with `-----BEGIN PUBLIC KEY-----`).
- Paste it as the `webhookVerificationKey` option (or set `SENDGRID_WEBHOOK_KEY` env var if using `Mailer.fromEnv()`).

mailery verifies every inbound webhook signature against this key. Unsigned or invalid-signature requests are rejected with `401`. Don't skip this — without verification, anyone who finds your webhook URL can fake bounce events and poison your suppression list.

#### 4. (Optional) IP allowlist

If your edge / CDN supports it, allowlist SendGrid's webhook source IPs (SendGrid publishes them at `https://api.sendgrid.com/v3/access_settings/whitelist`). Defense-in-depth over the signature check.

### Sandbox mode

When `sandbox: true`, SendGrid validates the request but doesn't deliver. Useful for CI / staging environments where you want the full send pipeline to run but never email real users.

## NullProvider (tests + local dev)

```ts
import { NullProvider } from 'mailery'

const provider = new NullProvider()
// ...
const mailer = await Mailer.init({
  providers: { null: provider },
  defaultProvider: 'null',
  // ...
})

// After a send:
expect(provider.sent[0]?.subject).toContain('Welcome')
provider.reset()  // clear between tests
```

Stores every `send()` call in `provider.sent` so tests can assert on what would have gone out. No network calls.

## Routing per template kind

If you want marketing through SendGrid (priced for volume) and transactional through Postmark (priced for inbox placement):

```ts
await Mailer.init({
  providers: {
    sendgrid: new SendGridProvider({ apiKey: SG_KEY }),
    postmark: new PostmarkProvider({ apiKey: PM_KEY }),  // when Postmark ships
  },
  defaultProvider: 'sendgrid',
  defaultTransactionalProvider: 'postmark',
})
```

The send pipeline picks a provider in this order:
1. Step override (`{ type: 'send', providerOverride: 'postmark' }`)
2. Template `providerOverride` field
3. Kind-specific default (`defaultTransactionalProvider` for kind=transactional)
4. Global `defaultProvider`

## Adding your own provider

Implement the `MailProvider` interface — see [Custom providers reference](/reference/types-provider) for the full signature.

```ts
import type { MailProvider, SendArgs, SendResult, NormalizedEvent } from 'mailery'

class MailerSendProvider implements MailProvider {
  readonly name = 'mailersend'
  readonly sendRatePerSecond = 25

  constructor(private apiKey: string) {}

  async send(args: SendArgs): Promise<SendResult> {
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: { name: args.fromName, email: args.fromEmail },
        to: [{ email: args.to }],
        subject: args.subject,
        html: args.html,
        text: args.text,
        headers: Object.entries(args.headers ?? {}).map(([k, v]) => ({ name: k, value: v })),
      }),
    })
    if (!res.ok) throw new Error(`mailersend ${res.status}`)
    const body = await res.json()
    return { providerId: body.message_id, status: 'accepted' }
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<boolean> {
    // HMAC verification specific to MailerSend
    // ...
    return true
  }

  parseWebhookEvents(payload: unknown): NormalizedEvent[] {
    // Normalize MailerSend's webhook payload into our shape
    return []
  }
}
```

Pass it to `Mailer.init({ providers: { mailersend: new MailerSendProvider(KEY) }, defaultProvider: 'mailersend' })` and you're done — the runner doesn't know or care which provider it's calling.

## Status of other providers

| Provider | Status |
|---|---|
| SendGrid | ✅ Shipped in V1 |
| Postmark | Designed, implementation in Phase 3 |
| AWS SES | Designed, implementation deferred |
| Resend | Designed, implementation deferred |
| MailerSend | Community-implementable today via the interface above |

The provider interface is intentionally tiny (`send`, `verifyWebhook`, `parseWebhookEvents`). Most implementations are 80-150 lines.
