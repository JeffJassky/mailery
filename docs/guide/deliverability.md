# Deliverability

Email deliverability is mostly DNS. mailery handles tracking, suppression, compliance, and unsubscribe — but if your sender domain isn't authenticated, your emails go to spam (or get bounced outright by recipient servers).

This guide walks through the single biggest deliverability lever: **authenticating your sender domain** with SendGrid (SPF + DKIM + DMARC).

::: tip Skip the manual DNS dance
If your DNS is on Cloudflare, you can run `npx mailery setup-sendgrid` and the entire walkthrough below (domain auth, DNS records, Signed Event Webhook, Event Webhook URL) becomes a single command. See [Automated setup](#automated-setup-cloudflare) at the bottom of this page.
:::

## What "authenticating a domain" means

Three DNS records prove to recipient servers that you are who you say you are:

| Record | Purpose | Failure mode |
|---|---|---|
| **SPF** (TXT) | Lists which servers may send mail "from" your domain | Recipients reject as "unauthorized origin" |
| **DKIM** (TXT) | Cryptographic signature on each outbound message | Recipients can't verify message integrity → spam folder |
| **DMARC** (TXT) | Policy telling recipients what to do if SPF + DKIM fail | Without it: ambiguous handling. With `p=reject`: protects against spoofing |

Without DKIM specifically, expect <10% inbox placement at Gmail. With DKIM properly set, expect 90%+. The lift from adding DKIM is the biggest single-step improvement you can make.

## SendGrid setup

### 1. Authenticate the domain

SendGrid dashboard → **Settings → Sender Authentication → Domain Authentication** → "Authenticate Your Domain":

1. Enter your sender domain (e.g. `yourdomain.com`).
2. Choose whether to use a **dedicated link branding subdomain** (recommended). SendGrid will give you a CNAME for it (e.g. `mail._domainkey.yourdomain.com`).
3. SendGrid shows you 3-5 DNS records to add. **Copy these.**

### 2. Add the DNS records

Go to your DNS provider (Cloudflare, Route53, Google Domains, etc.):

```
Type      Host                            Value
CNAME     em1234.yourdomain.com           u1234.wl.sendgrid.net
CNAME     s1._domainkey.yourdomain.com    s1.domainkey.u1234.wl.sendgrid.net
CNAME     s2._domainkey.yourdomain.com    s2.domainkey.u1234.wl.sendgrid.net
```

Hosts and values are specific to your SendGrid account — use what SendGrid generates.

### 3. Verify in SendGrid

Back in SendGrid → click "Verify". DNS propagation can take a few minutes to a few hours. Once green, your domain is authenticated.

### 4. Add SPF

If you already have an SPF record for your domain, add SendGrid's `include`:

```
yourdomain.com.   TXT   "v=spf1 include:sendgrid.net include:_spf.google.com ~all"
```

If you don't have one yet:

```
yourdomain.com.   TXT   "v=spf1 include:sendgrid.net ~all"
```

The `~all` is "softfail" — recommended starting point. Move to `-all` (hardfail) only after you're confident SendGrid is the only sender for the domain.

### 5. Add DMARC

DMARC tells recipient servers what to do when SPF or DKIM fail. Start with monitor-only:

```
_dmarc.yourdomain.com.   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com; ruf=mailto:dmarc@yourdomain.com; fo=1"
```

- `p=none` — monitor only, no enforcement
- `rua` — aggregate reports email
- `ruf` — failure reports email (some providers ignore this)

Watch reports for 2-4 weeks. If your authenticated mail is passing consistently, move to:

```
_dmarc.yourdomain.com.   TXT   "v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc@yourdomain.com"
```

`p=quarantine; pct=10` — 10% of failing mail goes to spam. Bump to 25%, 50%, 100% as you gain confidence, then move to `p=reject`.

## Verify it's working

After 24-48 hours of sending:

1. **Use mail-tester.com**. Send a test email from your app to the address it shows, then check the score. 8+ / 10 is healthy.
2. **Use Gmail's "Show original"**. In a delivered Gmail message, click ⋮ → "Show original". You should see:
   ```
   SPF: PASS with IP ...
   DKIM: PASS with domain yourdomain.com
   DMARC: PASS
   ```
3. **MXToolbox** has free SPF + DKIM + DMARC lookups. Search "MXToolbox SPF Check" or "DKIM Lookup".

## Common pitfalls

- **Multiple SPF records.** Only one `v=spf1` record per domain. If you have multiple, merge their includes into a single record.
- **`include:` chain limit.** SPF has a 10-lookup limit per query. Each `include:` counts. If you `include:` 11+ providers (mailgun, sendgrid, gsuite, …), the SPF record breaks silently. Tools like `dmarcian.com` show your current depth.
- **CNAME flattening at the apex.** Some DNS providers don't allow CNAME at the apex (`yourdomain.com`) — you can only use it on subdomains. SendGrid's records are typically on subdomains, but watch for this.
- **Missing the subdomain.** SendGrid's CNAMEs use specific subdomains like `em1234.yourdomain.com`. Make sure you create them at the exact subdomain SendGrid specified, not at the apex.
- **Cloudflare proxy on the CNAMEs.** Disable the orange-cloud proxy for SendGrid CNAMEs — proxying breaks DKIM validation.

## Other levers

After domain auth, the next deliverability levers in order of impact:

1. **Sender reputation warmup.** New SendGrid IPs / accounts send small volumes first. Ramp up over weeks. SendGrid handles this for you on shared IPs; on dedicated IPs you have to warm them yourself.
2. **List hygiene.** mailery's suppression + soft→hard bounce promotion (`softBouncePromotionThreshold`) keeps the list clean automatically. Re-import old lists at your peril — they're full of dead addresses.
3. **Engagement.** Recipient interaction (opens, replies, archiving) signals "wanted mail" to Gmail's filters. The Apple MPP problem makes opens noisy, but reply rate is gold.
4. **Content quality.** Avoid spammy words ("free!!!", excessive caps), broken links, image-only emails. mailery's MJML templates + plain-text auto-derivation handle the structural part.
5. **One-click unsubscribe.** mailery includes the RFC 8058 headers automatically on marketing sends. Gmail/Yahoo/Apple Mail show in-inbox unsubscribe buttons. Users prefer this to "report as spam" — and spam reports tank reputation.
6. **Complaint rate < 0.3%.** Mailery's circuit breaker trips above this. If yours is climbing, your audience is wrong, not your domain. Stop sending until you fix the audience.

## What mailery does automatically

| | |
|---|---|
| **List-Unsubscribe** + **List-Unsubscribe-Post** headers on marketing sends | ✓ |
| **Suppression check at every send** (hard bounce → permanent block) | ✓ |
| **Soft→hard bounce promotion** (configurable threshold) | ✓ |
| **Complaint cascade** (FBL webhook → suppression + subscription marked) | ✓ |
| **Circuit breaker** auto-trip on high bounce / complaint rates | ✓ |
| **GDPR-forget hashed suppression** so re-imports don't email deleted users | ✓ |
| **Plain-text auto-derivation** sent alongside HTML (spam filters check both) | ✓ |
| **CAN-SPAM postal address** Handlebars helper | ✓ |

You handle: DNS records, sender reputation, content, segmentation.

## Reputation isolation: separate domains for marketing vs transactional

The single most damaging deliverability mistake is sending both kinds of email from the same domain. Marketing emails attract complaints and soft bounces. Transactional emails (password resets, OTP codes, receipts) need to land in the inbox every single time. Share a domain, and a bad newsletter takes your password resets down with it.

The fix is to use separate verified sender domains:

- `news.yourapp.com` — marketing / newsletters / lifecycle drips
- `mail.yourapp.com` — transactional (auth, billing, security)

Each domain gets its own DKIM key, its own SPF record, and its own reputation at mailbox providers. A complaint on `news.yourapp.com` doesn't touch `mail.yourapp.com`'s standing at Gmail.

Wire both into mailery and let it enforce the split:

```ts
await Mailer.init({
  // ...
  fromDefaults: { name: 'YourApp Newsletter', email: 'hello@news.yourapp.com' },
  transactionalFromDefaults: { name: 'YourApp', email: 'noreply@mail.yourapp.com' },
  senderDomains: {
    'news.yourapp.com': { kind: 'marketing' },
    'mail.yourapp.com': { kind: 'transactional' },
  },
})
```

With this registry set, a `kind: 'marketing'` template can't be published with a `fromEmail` on `mail.yourapp.com`, and vice versa. See [Configuration → Sender domains](./configuration#sender-domains-reputation-isolation).

Optional but recommended: route the two kinds through different providers as well (`defaultTransactionalProvider: 'postmark'` with `defaultProvider: 'sendgrid'` is a common pairing). Postmark's IP pools are optimized for transactional inbox placement; SendGrid handles marketing volume well.

## Automated setup (Cloudflare)

If your DNS is hosted on Cloudflare, mailery ships a one-shot CLI that wires up everything covered above — domain authentication, DNS records, Signed Event Webhook key, Event Webhook URL — without clicking through dashboards.

```bash
npx mailery setup-sendgrid \
  --domain news.example.com \
  --webhook-url https://example.com/m/webhooks/sendgrid \
  --cloudflare
```

Or run it with no args for an interactive walkthrough that asks for each value:

```bash
npx mailery setup-sendgrid
```

The wizard prompts for domains (one line, comma-separated for multiple), webhook URL (defaulting to `https://<apex>/m/webhooks/sendgrid`), whether to use Cloudflare, the API tokens themselves if missing from your environment, and the force flag. It echoes back a summary and asks to confirm before any API call. Pass `--no-interactive` to suppress the prompts (CI / scripts).

### What it does

| Step | Source → target |
|---|---|
| Look up the Cloudflare Zone ID | Cloudflare `GET /zones?name=...` |
| Create or reuse the SendGrid domain authentication | SendGrid `POST /whitelabel/domains` (or finds an existing one with the same domain) |
| Publish each CNAME to Cloudflare DNS | Cloudflare `POST /zones/:id/dns_records` (with `proxied: false` — critical, DKIM breaks otherwise) |
| Trigger SendGrid's validation check | SendGrid `POST /whitelabel/domains/:id/validate` |
| Enable Signed Event Webhook + fetch the ECDSA public key | SendGrid `PATCH /user/webhooks/event/settings/signed` + `GET` |
| Configure Event Webhook URL + event toggles (delivered, open, click, bounce, dropped, spamreport, unsubscribe) | SendGrid `PATCH /user/webhooks/event/settings` |
| Print the env-var line to copy into your `.env` or secret manager | stdout |

### Setup credentials

The script reads two env vars. Put them in your shell rc (e.g. `~/.zshrc`) so they're available wherever you run the script:

```bash
# ~/.zshrc
export SENDGRID_API_KEY="SG.xxx"          # full access, or at least Sender Authentication + Mail Settings
export CLOUDFLARE_API_TOKEN="cf-xxx"      # see below for the exact permissions
```

The Cloudflare token needs **Zone:Read** + **DNS:Edit** for the zone you're publishing into. Generate one in the Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit zone DNS" template → restrict to the specific zone (e.g. `example.com`).

### Idempotency

Both the SendGrid and Cloudflare halves are fully idempotent. The script:

- **Reads before it writes.** Domain auth: fetched first; only created when missing. Signed webhook: only PATCHes if signing is off. Event webhook: only PATCHes if URL or toggle values differ. Cloudflare records: only POSTs if no matching record exists, only PUTs if content drifted.
- **Errors before it overwrites destructive state.** If a different webhook URL is already configured, the script refuses to clobber it without `--force`.
- **Is safe to re-run.** A second invocation against a fully-configured install issues only GET requests and exits 0.

Use the same command in a deploy script, a Makefile, or just whenever DNS / SendGrid setup feels off — re-running converges to the desired state without surprises.

### Multiple sender domains in one run

If you isolate marketing from transactional (recommended — see [Reputation isolation](#reputation-isolation-separate-domains-for-marketing-vs-transactional)), pass `--domain` more than once and the script handles all of them in a single invocation. Domain auth + DNS publish runs per-domain; the Event Webhook itself is an account-level setting and is only configured once at the end.

```bash
npx mailery setup-sendgrid \
  --domain news.example.com \
  --domain mail.example.com \
  --webhook-url https://example.com/m/webhooks/sendgrid \
  --cloudflare
```

You can also comma-separate: `--domain news.example.com,mail.example.com`.

### Flags reference

| Flag | Default | Purpose |
|---|---|---|
| `--domain` | required | The domain to authenticate (e.g. `news.example.com`). Repeat or comma-separate to authenticate multiple. |
| `--subdomain` | `em` | The sub-label SendGrid uses for the link branding CNAME. |
| `--webhook-url` | required | Public URL where SendGrid POSTs event webhooks. Account-level, configured once. |
| `--cloudflare` | off | Publish DNS records via the Cloudflare API. Requires `CLOUDFLARE_API_TOKEN`. |
| `--cloudflare-zone` | inferred per domain | Override the parent zone (for multi-label public suffixes like `.co.uk`). |
| `--force` | off | Allow overwriting an existing event webhook URL. |

### Without Cloudflare

Drop the `--cloudflare` flag and the script still does the SendGrid half — it prints the CNAMEs you need to publish to your DNS provider, then enables the webhook on the SendGrid side. Once your DNS is up, re-run the same command and it'll detect the records and trigger SendGrid's validation step.

```bash
npx mailery setup-sendgrid \
  --domain news.example.com \
  --webhook-url https://example.com/m/webhooks/sendgrid
```
