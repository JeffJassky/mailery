# Deliverability

Email deliverability is mostly DNS. mailery handles tracking, suppression, compliance, and unsubscribe — but if your sender domain isn't authenticated, your emails go to spam (or get bounced outright by recipient servers).

This guide walks through the single biggest deliverability lever: **authenticating your sender domain** with SendGrid (SPF + DKIM + DMARC).

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
