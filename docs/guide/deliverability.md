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
| **Per-(sender domain × kind) circuit breaker** auto-trip on high bounce / complaint rates | ✓ |
| **GDPR-forget hashed suppression** so re-imports don't email deleted users | ✓ |
| **Plain-text auto-derivation** sent alongside HTML (spam filters check both) | ✓ |
| **CAN-SPAM postal address** `{{senderAddress}}` render variable + setup-status check | ✓ |
| **DNSBL monitoring** of sender domains + dedicated IPs (Spamhaus, SURBL, URIBL, Barracuda, SORBS, SpamCop) | ✓ |
| **Google Postmaster Tools pull** (when configured) — daily reputation tier + spam rate per domain | ✓ |
| **Microsoft SNDS pull** (when configured) — per-IP filter verdict + complaint rate | ✓ |
| **DMARC RUA aggregate-report ingestion** with per-source-IP failure breakdown + policy-progression suggestion | ✓ |
| **Content linter** at publish + live in the template editor (missing plain-text, URL shorteners, missing unsubscribe tag, etc.) | ✓ |
| **Mail-Tester deliverability gate** (when configured) — score-based publish block | ✓ |
| **List-hygiene report** — engagement-window breakdown + sunset-cohort impact projection | ✓ |

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

- **Reads before it writes.** Domain auth: fetched first; only created when missing. Signed webhook: only PATCHes if signing is off. Event webhook: matched by URL against the account's existing webhooks, then only PATCHed if toggle values differ. Cloudflare records: only POSTs if no matching record exists, only PUTs if content drifted.
- **Touches only its own webhook.** Other webhooks on the account — a second mailery install, a staging environment, an unrelated app — are listed but never modified. If none match `--webhook-url`, a new webhook is created alongside them.
- **Errors before it overwrites destructive state.** On older accounts that only expose SendGrid's single-webhook API, repointing the one webhook slot away from another consumer requires `--force`.
- **Is safe to re-run.** A second invocation against a fully-configured install issues only GET requests and exits 0.

Use the same command in a deploy script, a Makefile, or just whenever DNS / SendGrid setup feels off — re-running converges to the desired state without surprises.

### Multiple sender domains in one run

If you isolate marketing from transactional (recommended — see [Reputation isolation](#reputation-isolation-separate-domains-for-marketing-vs-transactional)), pass `--domain` more than once and the script handles all of them in a single invocation. Domain auth + DNS publish runs per-domain; one Event Webhook — the one matching `--webhook-url` — is configured once at the end.

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
| `--webhook-url` | required | Public URL where SendGrid POSTs event webhooks. Updated in place if the account already has a webhook with this URL, otherwise created alongside the existing ones. |
| `--webhook-name` | `mailery <host>` | `friendly_name` for a newly created webhook, so the SendGrid dashboard shows which app owns it. |
| `--cloudflare` | off | Publish DNS records via the Cloudflare API. Requires `CLOUDFLARE_API_TOKEN`. |
| `--cloudflare-zone` | inferred per domain | Override the parent zone (for multi-label public suffixes like `.co.uk`). |
| `--force` | off | Legacy single-webhook accounts only: repoint the account's one webhook at `--webhook-url`, stopping event delivery to whatever consumed the old URL. Ignored on accounts with the multi-webhook API. |

::: tip One SendGrid account, several apps
Running mailery for two products, or staging next to production, works without `--force`: each install matches its own `--webhook-url` and gets its own signing key from SendGrid's per-webhook endpoint. Set `SENDGRID_WEBHOOK_VERIFICATION_KEY` per environment from that run's output — keys are not interchangeable between webhooks.
:::

### Without Cloudflare

Drop the `--cloudflare` flag and the script still does the SendGrid half — it prints the CNAMEs you need to publish to your DNS provider, then enables the webhook on the SendGrid side. Once your DNS is up, re-run the same command and it'll detect the records and trigger SendGrid's validation step.

```bash
npx mailery setup-sendgrid \
  --domain news.example.com \
  --webhook-url https://example.com/m/webhooks/sendgrid
```

## Per-domain circuit breaker

The circuit breaker tracks hard-bounce, complaint, and combined-bounce rates over a rolling window. When any threshold is exceeded, marketing sends are held until manually resumed (transactional always flows through).

Rates are tracked **per (sender domain × template kind)** so one bad subdomain doesn't hold mail for the others. If `news.example.com` (marketing) trips, transactional sends from `mail.example.com` continue normally — and marketing sends from a different marketing subdomain also continue.

Defaults — see [Configuration → Circuit breaker](./configuration#circuit-breaker):

| Threshold | Default | What it means |
|---|---|---|
| `hardBounceRatePctTrip` | 2% | Hard bounces over the window |
| `complaintRatePctTrip` | 0.3% | Spam complaints — Gmail/Yahoo's actual cutoff |
| `combinedBounceRatePctTrip` | 5% | Hard + soft bounces combined |
| `failedToSendRatePctDegrade` | 10% | Provider errors — sets `degraded` state, doesn't block sends |

In the admin UI, the **Health** screen shows one row per bucket with rates colored against trip thresholds. Tripped buckets get a "Resume" button. The "Resume all" button at the top resumes every tripped bucket at once.

You can also resume programmatically:

```bash
# Resume one bucket
curl -X POST https://example.com/admin/mailer/api/health/resume \
  -H 'content-type: application/json' \
  -d '{"senderDomain": "news.example.com", "kind": "marketing"}'

# Resume all tripped buckets
curl -X POST https://example.com/admin/mailer/api/health/resume \
  -H 'content-type: application/json' \
  -d '{}'
```

## DNS block-list monitoring

Once a day mailery resolves each of your sender domains (and any dedicated IPs) against major DNS block lists. If a domain or IP shows up on a list, that signal lands in the admin Health screen and in `setup-status` as an error.

Enabled by default for any operator with sender domains configured — no extra setup. Customize the lists or interval via `MailerConfig.dnsbl`:

```ts
await Mailer.init({
  // ...
  dnsbl: {
    // Default lists if you don't override:
    domainLists: [
      { host: 'dbl.spamhaus.org', label: 'Spamhaus DBL' },
      { host: 'multi.surbl.org', label: 'SURBL' },
      { host: 'multi.uribl.com', label: 'URIBL' },
    ],
    // Only meaningful if you have a dedicated sending IP:
    dedicatedIps: ['203.0.113.5'],
    ipLists: [
      { host: 'zen.spamhaus.org', label: 'Spamhaus ZEN' },
      { host: 'b.barracudacentral.org', label: 'Barracuda' },
      { host: 'dnsbl.sorbs.net', label: 'SORBS' },
      { host: 'bl.spamcop.net', label: 'SpamCop' },
    ],
    intervalHours: 24,
  },
})
```

In the admin UI, the **Health → DNS block lists** card shows one row per (target × list) with the latest verdict and a "Recheck now" button. Each list publishes its own removal procedure — visit the list's website (linked from the list label) to start delisting.

## Google Postmaster Tools

Postmaster is Google's authoritative view of how Gmail handles your mail — reputation tier (`HIGH` / `MEDIUM` / `LOW` / `BAD`), spam rate, SPF/DKIM/DMARC pass rates per day. Only meaningful at >100 sends/day to Gmail; smaller senders see empty responses.

Setup requires an OAuth client in your own Google Cloud project + a refresh token from the consent flow with `https://www.googleapis.com/auth/postmaster.readonly` scope. Once configured, mailery pulls daily snapshots and auto-trips the (domain × marketing) breaker when a domain falls to `BAD`.

```ts
await Mailer.init({
  // ...
  postmaster: {
    clientId: process.env.GOOGLE_POSTMASTER_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_POSTMASTER_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_POSTMASTER_REFRESH_TOKEN!,
    // Defaults to senderDomains + fromDefaults domain
    domains: ['news.example.com', 'mail.example.com'],
    intervalHours: 24,
  },
})
```

The admin **Health → Google Postmaster Tools** card shows the latest snapshot per domain — reputation pill, user-reported spam %, SPF/DKIM/DMARC pass rates. Manual refresh button + auto pull daily via the tick.

## Microsoft SNDS

SNDS (Smart Network Data Services) is Microsoft's equivalent for Outlook / Hotmail / Live IP reputation. **IP-level** — only useful if you send from a dedicated IP. Visibility-only: RED filter results surface as a setup-status error but don't auto-trip the breaker.

```ts
await Mailer.init({
  // ...
  snds: {
    accessKey: process.env.SNDS_ACCESS_KEY!,
    ips: ['203.0.113.5'],  // optional — filter to your IPs
    intervalHours: 24,
  },
})
```

Get an access key by signing up at [sendersupport.olc.protection.outlook.com/snds](https://sendersupport.olc.protection.outlook.com/snds/) and enrolling each of your IPs. The same site is where you enrol in [JMRP](https://sendersupport.olc.protection.outlook.com/snds/JMRP.aspx) — the feedback loop that emails you when an Outlook user marks your mail as junk. JMRP enrolment is manual and outside mailery's scope, but the setup-status check reminds you.

The admin **Health → Microsoft SNDS** card shows per-IP filter result (GREEN / YELLOW / RED), complaint rate, trap message count, recipient count, and activity window.

## DMARC RUA report ingestion

DMARC RUA aggregate reports are the only place you can see **who is sending mail claiming to be from your domain** — legitimate sources, forgotten SaaS tools, and active spoofers. Most operators publish `rua=mailto:...` and never read the reports because the raw XML is unreadable. Mailery parses the reports, extracts non-aligned source IPs, and surfaces them in the admin UI.

### Set up the DMARC TXT record

If you ran `setup-sendgrid`, you have working SPF + DKIM but no DMARC by default. Publish a DMARC record with the CLI:

```bash
npx mailery setup-dmarc \
  --domain news.example.com \
  --rua-mailbox dmarc-reports@example.com \
  --policy none \
  --cloudflare
```

| Flag | Default | Purpose |
|---|---|---|
| `--domain` | required | The domain to publish DMARC for. |
| `--rua-mailbox` | required | Mailbox that receives RUA aggregate reports. |
| `--ruf-mailbox` | unset | Mailbox for forensic reports (rarely used). |
| `--policy` | `none` | `none` / `quarantine` / `reject`. Start with `none`. |
| `--pct` | `100` | Percent of failing mail subject to the policy. |
| `--aspf` | `r` | SPF alignment mode (`r` relaxed / `s` strict). |
| `--adkim` | `r` | DKIM alignment mode (`r` / `s`). |
| `--cloudflare` | off | Publish via the Cloudflare API. |

Without `--cloudflare` the command prints the TXT record for manual publish. Use `--policy quarantine --pct 10` after a few weeks of `p=none` data to start enforcement — see the [policy progression suggestion](#policy-progression-suggestion) below.

### Upload received reports

Receivers (Google, Yahoo, Microsoft, etc.) email one report per day per domain, attached as `.zip` or `.gz`. Open the admin **Health → DMARC RUA reports** card and use the "Upload report(s)" button. Multi-file upload supported.

Mailery decompresses, parses (RFC 7489), and persists:

- One `DmarcReportDoc` per received report — total messages, pass / fail counts, policy + pct in effect, reporting window.
- One `DmarcFailureDoc` per non-aligned source IP per report. These are the actionable rows.

Re-uploading the same report is idempotent (keyed on `reportId × orgName`).

### Receive reports automatically {#dmarc-inbound}

Uploading a file a day gets old. Point the RUA mailbox at an inbound-email webhook — SendGrid [Inbound Parse](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook), Mailgun Routes, Postmark inbound — and mailery ingests each report as it arrives.

::: danger Read this before you enable it
**SendGrid Inbound Parse does not sign its payloads.** The SendGrid *Event Webhook* does, and mailery verifies that signature (plus a replay window) on `/m/webhooks/sendgrid`. Inbound Parse is a different product with no signature, no HMAC and no verifiable identity — there is nothing to verify.

So this endpoint is authenticated by a shared secret and nothing else. It is **off unless you set that secret**, it is never mounted by default, and it will not appear on an upgrade.
:::

```ts
app.use(
  '/m',
  createPublicRouter(mailer, {
    dmarcInbound: {
      secret: process.env.MAILERY_DMARC_INBOUND_SECRET, // absent → route not mounted
      path: '/inbound/dmarc',                           // default
    },
  }),
)
```

Then set the Inbound Parse destination URL with the secret as the basic-auth password:

```
https://mailery:$MAILERY_DMARC_INBOUND_SECRET@example.com/m/inbound/dmarc
```

The username is ignored; only the password is compared, in constant time. `Authorization: Bearer <secret>` works too, for anything forwarding to this route that isn't SendGrid.

**Use basic auth rather than putting the secret in the path.** Both work — nothing stops you making `path` itself unguessable — but a URL path is written to every access log, proxy log and load-balancer log between the sender and you, and an `Authorization` header is not.

| Option | Default | Purpose |
|---|---|---|
| `secret` | — | Shared secret. **Absent or empty → the route does not exist.** |
| `path` | `/inbound/dmarc` | Sub-path on the public router. |
| `maxFileSizeBytes` | `10 * 1024 * 1024` | Per-attachment cap, matching the admin upload. |
| `maxFiles` | `10` | Attachments accepted per message. |
| `allowedDomains` | derived | Domains whose reports are accepted. Defaults to `senderDomains` + the From defaults, plus each one's parent domain. |
| `parseInbound` | SendGrid shape | Seam for other inbound-email providers. |

What the endpoint does with a request:

1. Checks the secret **before** reading a byte of the body, so an anonymous caller cannot make the process buffer an upload.
2. Enforces the size and count limits above.
3. Takes only attachments ending `.zip`, `.gz` or `.xml`; a message with none (an auto-reply, a human) is a 200 with `ingested: 0`, not a retry-inducing error.
4. Runs them through the same parser the admin upload uses — decompression caps, declared-vs-actual size checks, compression-ratio check, zip-slip guard.
5. **Rejects any report whose `policy_published.domain` is not a domain you send from.** If the secret ever leaks, that bounds the damage to "rows about your own domains".

Responses: `200` ingested (or nothing to ingest), `400` nothing usable in the message, `401` bad or missing secret, `413` over the size or count limit.

A leaked secret buys an attacker exactly one capability: inserting DMARC report rows for domains you already send from. No mail is sent, no contact data is read or written, nothing is deleted. Rotate it by changing the config value and the Inbound Parse destination URL.

::: warning Not the admin upload route
Do **not** point Inbound Parse at `/admin/mailer/api/dmarc/upload`. mailery's own docs recommended that before v0.15 and it never worked: that route sits behind your `requireAdmin` guard, which Inbound Parse cannot satisfy. If it *did* work for you, check whether the guard is actually applied to your admin router.
:::

### Tag known sources

After a week or two of reports, the **Top failing source IPs** table lists every IP sending as your domain that didn't pass DMARC alignment, sorted by message count. Click "Tag" on each row and label it:

- `SendGrid` for your transactional + marketing provider
- `Hubspot` / `Calendly` / `Stripe` for any SaaS sending as you
- Untagged rows are either misconfigured legitimate sources (fix their auth) or spoofers (ignore them)

Tags persist in the `mailer_dmarc_source_tags` collection and merge with `MailerConfig.dmarc.knownSources` at read time. **Precedence:** a DB-set tag overrides a config tag for the same IP, so an operator can re-label or ignore a source through the admin UI without redeploying. Removing a DB tag via the UI restores the config baseline for that IP.

```ts
await Mailer.init({
  // ...
  dmarc: {
    knownSources: [
      { ip: '149.72.45.10', label: 'SendGrid (transactional)' },
      { ip: '203.0.113.99', label: 'Old marketing platform', ignored: true },
    ],
    retentionDays: 90, // failures older than this are pruned (housekeeping runs hourly)
  },
})
```

### Policy progression suggestion

When enough clean data accumulates, the admin UI surfaces a per-domain suggestion to advance your DMARC policy. Every transition checks **all** of these gates — failing any one blocks the suggestion:

| From | To | All gates required |
|------|-----|---------------------|
| `p=none` | `p=quarantine pct=10` | ≥30 reports in last 30d, ≥1000 total messages, ≥99% alignment rate, **zero failing messages from untagged sources** |
| `p=quarantine pct=10` | `pct=25` | Same gates as above, plus alignment ≥99.5% |
| `p=quarantine pct=25` | `pct=50` | As above |
| `p=quarantine pct=50` | `pct=100` | As above |
| `p=quarantine pct=100` | `p=reject` | Same gates, plus alignment ≥99.9% |
| `p=reject` | — | Already at strictest |

The "no untagged failing sources" gate is the most common blocker — fix the source (deploy DKIM, or tag it as known/ignored) before the suggestion will fire.

## List hygiene

Inactive contacts disproportionately bounce, complain, or sit in spam folders harming engagement metrics. The admin **List hygiene** screen (under Audience) buckets your subscribed contacts by how recently they last opened or clicked any mail:

- Engaged (last 30 days)
- Engaged (31-60 / 61-90 / 91-180 days)
- Inactive (>180 days)
- Never engaged

For the long-inactive cohort, the report shows:

- **Lifetime metrics:** total sends to this cohort, their historical bounce / complaint rates.
- **Projected impact:** "Of the last 90 days' N sends, the cohort generated X bounces (Y% of total). Sunsetting them would drop overall bounce rate from A% to B%."

The screen is read-only — sunset decisions are explicit. To suppress an inactive cohort, add them to the suppressions collection through the existing UI or your own script. Use the bucket counts to pick a window (typically >180 days) and decide whether the projected impact justifies the action.

## Content linter

Every template is run through a content linter at publish time. Errors block publish; warnings + infos surface in the editor's Issues panel and the publish response.

| Rule | Severity | Trigger |
|------|----------|---------|
| `missing_plain_text` | error | No plain-text alternative |
| `image_only_body` | error | Rendered text < 20 chars and ≥1 image |
| `url_shortener` | error | Any link uses bit.ly / t.co / tinyurl.com / goo.gl / ow.ly |
| `missing_unsubscribe_tag` | error | Marketing template lacks `{{unsubscribeUrl}}` |
| `sender_domain_invalid` | error | `fromEmail` doesn't match the senderDomains registry |
| `bare_url` | warning | URL appears in body text without an anchor wrapper |
| `spam_phrases` | warning | Contains "FREE", "ACT NOW", "100% guaranteed", `!!!+` |
| `all_caps_subject` | warning | Subject >50% uppercase |
| `subject_too_long` | warning | Subject >60 chars (mobile truncation) |
| `too_many_links` | warning | >10 links in body |
| `offdomain_links` | warning | More than half the resolvable links point away from the `fromEmail` domain |
| `insecure_link` | warning | A link uses `http://` rather than `https://` |
| `image_missing_alt` | warning | An `<img>` has no alt text (or `alt=""`) |
| `image_only_link` | warning | A link wraps an image with no text label |
| `empty_preheader` | info | No preheader set |

`offdomain_links` compares hostnames loosely — exact match, subdomain either way, or a shared last-two-label suffix — so `mail.example.com` and `www.example.com` count as the same site. Merge-tag hrefs (`{{unsubscribeUrl}}`), `mailto:`, and relative URLs are skipped since they carry no domain to compare. `insecure_link` is a scheme check only; link liveness (200 vs 404) needs network I/O and stays out of the pure lint pass.

The template editor sidebar shows live results as you type. Saved drafts are debounced (500ms after last keystroke) and the Publish button is disabled while errors are present.

## Mail-Tester integration (optional)

For an objective deliverability score, configure [Mail-Tester](https://mail-tester.com)'s paid API. Once enabled, the template editor grows a "Run deliverability check" button:

1. Click → mailery provisions a test address from Mail-Tester, sends the rendered draft to it via your default provider, polls for the score.
2. Score (0-10) + per-rule feedback render in the editor sidebar.
3. Score is cached for `cacheHours` (default 24) keyed on `(bodyHash, subject, fromEmail)` so re-clicking publish doesn't burn credits.
4. Publish is blocked when `score < minScore` (default 8.0); override with `bypassMailTester: true` on the publish call.

```ts
await Mailer.init({
  // ...
  mailTester: {
    apiKey: process.env.MAIL_TESTER_API_KEY!,
    minScore: 8.0,
    requireScore: true,   // refuse to publish content that was never checked
    cacheHours: 24,
  },
})
```

### How strict the gate is

By default the gate only stops content already known to be bad. Because the
cache key is `(bodyHash, subject, fromEmail)`, editing a template after a
failing score produces a new key, misses the cache, and publishes — a 4.2 is
one whitespace change away from irrelevant.

Set `requireScore: true` to close that: an unchecked content revision is
refused with `422 { error: 'mail_tester_blocked', code: 'no_score' }` and the
operator must run a check first. Budget one credit per content revision you
intend to publish. A score below `minScore` still returns `code: 'low_score'`
with the cached score attached, and `bypassMailTester: true` overrides both.

Mailery never auto-triggers a check during publish — that would send real mail
as a side effect of a publish request.

Each check sends one real email through your provider — audit-logged. Skip the integration if you don't have a Mail-Tester paid plan; the publish path is silent when not configured.
