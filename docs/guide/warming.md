# Deliverability & domain warming — what to worry about, when, and how much

This document explains how inbox providers decide whether to deliver your mail, what numbers they actually look at, where the cliffs are, and the operational playbook for getting a new domain or new IP from cold to trusted.

It is written specifically for someone running mailery: where the levers are in this codebase, what's already wired up, and what's still on the operator to handle externally.

---

## 1. The mental model

A receiver (Gmail, Yahoo, Microsoft, Apple, corporate filters like Mimecast/Proofpoint) makes one decision per message: **inbox**, **spam folder**, or **reject**. They make that decision in ~50 ms using a model whose inputs fall into four buckets:

1. **Identity & authentication** — can we cryptographically tie this message to a sender we have a reputation history on?
2. **Sender reputation** — how has mail from that identity behaved historically?
3. **Recipient engagement signals** — what do *this recipient* and *recipients like them* tend to do with mail from this sender?
4. **Content & infrastructure signals** — does the message itself look like spam, phishing, or malware?

Warming is the process of building up bucket #2 (reputation) from zero. You cannot fake it, you cannot buy it, and you cannot rush it past a certain rate. The receiver wants to see a consistent pattern of well-engaged, low-complaint mail at increasing volume before they trust you with the inbox.

---

## 2. Identity & authentication — the gate

These are not warming-dependent. They are pass/fail. Get them wrong and *no amount of warming will help.*

### 2.1 SPF (Sender Policy Framework)
- DNS TXT record on your sending domain listing which IPs/services are allowed to send as you.
- For SendGrid: `v=spf1 include:sendgrid.net ~all` (or stricter `-all`).
- **What providers want:** SPF must pass AND align with the visible `From:` domain ("SPF alignment" for DMARC).
- **Failure mode:** subdomain mismatch (`From: hello@example.com` but `Return-Path: bounces@sendgrid.net`) breaks alignment. Fix with custom domain authentication (CNAMEs that put bounces under `em1234.example.com`).

### 2.2 DKIM (DomainKeys Identified Mail)
- Cryptographic signature in a header, verified against a public key in DNS.
- For SendGrid: two CNAMEs (`s1._domainkey`, `s2._domainkey`) pointing at SendGrid-managed keys.
- **What providers want:** DKIM passes AND signing domain aligns with `From:` domain.
- **Failure mode:** key rotated without DNS updated; CNAME points at deprecated host. Set up monitoring on the CNAME targets.

### 2.3 DMARC (Domain-based Message Authentication, Reporting, and Conformance)
- DNS TXT at `_dmarc.example.com` declaring your policy: `none`, `quarantine`, or `reject` for mail that fails SPF+DKIM alignment.
- **What providers want (Gmail/Yahoo Feb 2024 bulk-sender rules):** at minimum a published policy of `p=none` with a `rua=` reporting address. Mail without DMARC at >5k/day to Gmail is rejected.
- **Recommended progression:** `p=none` (monitor) → `p=quarantine; pct=10` → ramp `pct` → `p=quarantine` → `p=reject`. Takes weeks; do it AFTER you've fixed all alignment issues using `rua` reports.

### 2.4 BIMI (Brand Indicators for Message Identification)
- Optional. Puts your logo next to mail in the inbox.
- Requires DMARC at `p=quarantine` or `p=reject`, an SVG Tiny PS logo, and (for Gmail) a Verified Mark Certificate (~$1.5k/year from Entrust or DigiCert).
- **Marginal deliverability impact.** Mostly brand recognition + click-through lift. Skip until volume justifies it.

### 2.5 PTR / reverse DNS
- The sending IP must have a PTR record that resolves back to a hostname under your control (or your ESP's).
- Handled by SendGrid for shared IPs; for dedicated IPs you ask SendGrid support to set it.

### 2.6 List-Unsubscribe headers (RFC 8058)
- Two headers required by Gmail/Yahoo bulk-sender for marketing mail:
  - `List-Unsubscribe: <https://example.com/unsub?t=...>, <mailto:unsubscribe@example.com>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- **One-click means literally one click — no confirmation page, no login, no captcha.** Gmail/Yahoo POST to the URL and expect a 200.
- mailery's tracking module emits these on marketing mail. Confirm by inspecting raw headers of a test send.

### 2.7 TLS
- Receiver-to-sender TLS should be opportunistic STARTTLS minimum. SendGrid handles this.
- For higher-end deliverability, MTA-STS + TLS-RPT at the *receiving* domain — but that's about *you* receiving mail safely, not sending.

**Bottom line on auth:** if SPF/DKIM/DMARC are not all passing AND aligned, stop reading this doc and fix that first. It's the single biggest cause of "we tried warming and it didn't work."

---

## 3. The reputation signals — what they actually measure

Reputation is tracked separately at three levels, and you need to understand which signals attach to which:

| Level | Tied to | Survives | Resets when |
|-------|---------|----------|------------|
| **IP reputation** | The sending IP address | Months. Slow to build, slow to lose. | You change IPs. |
| **Domain reputation** | The `From:` domain (and signing subdomain) | Years. Sticks even if you change ESPs. | Domain abandoned for ~6+ months. |
| **Subdomain reputation** | Specific subdomain like `marketing.example.com` | Years. | Subdomain abandoned. |

**The dominant signal in 2024+ is domain reputation, not IP.** Gmail in particular has been deprioritizing IP rep since ~2019. This is why subdomain segmentation matters (see §7).

### 3.1 Engagement signals — positive

These tell the receiver "real humans want this mail":

- **Open rate** (declining usefulness — Apple Mail Privacy Protection pre-fetches every image, which fakes an open). Still tracked by Gmail/Outlook because they can fingerprint MPP and discount it.
- **Click rate** — much stronger signal than opens since MPP. >2% on marketing is healthy.
- **Reply rate** — extremely strong positive. Even a few % materially helps reputation. Transactional mail benefits enormously here.
- **Move to inbox** / **Not spam** — nuclear positive. One of these from an engaged user can offset many complaints.
- **Add to address book** / **Mark as important** — strong positive.
- **Forward** — moderate positive.
- **Read time** — Gmail tracks roughly how long the message was open in the preview pane. Long reads = good signal.

### 3.2 Engagement signals — negative

- **Spam complaints** ("Mark as spam" or "Junk") — the single most damaging signal. Treated as ~100x more weighted than a positive engagement.
- **Delete without open** — moderate negative. Pile up enough and you trip.
- **Disable images** for this sender — moderate negative.
- **Unsubscribe** — *neutral to slightly negative.* Counterintuitively, easy unsubscribes are PROTECTIVE because they prevent the recipient from hitting "spam" instead. Always make unsubscribe trivial.

### 3.3 List-health signals

- **Hard bounce rate** — the address doesn't exist (5xx SMTP). Indicates list-buying, neglect, or no list-hygiene.
- **Soft bounce rate** — temporary (mailbox full, server down). Less reputation-damaging if you stop retrying.
- **Spam trap hits** — addresses owned by Spamhaus/Validity/inbox providers, used to detect spammers. Two types:
  - **Pristine traps** — addresses that have never been signed up anywhere. Hitting one means you bought or scraped a list. Catastrophic.
  - **Recycled traps** — addresses that used to be real, were abandoned, and have been repurposed. Hitting these means your hygiene is bad. Bad but recoverable.

### 3.4 Volume signals

- **Volume consistency** — daily volume that doesn't fluctuate wildly is good. Going from 1k/day to 100k/day in one send is suspicious.
- **Volume-engagement ratio** — sudden volume increase with same engagement rate is OK; volume increase with declining engagement is a fast track to spam folder.
- **Sending cadence** — sending at predictable times that match recipient timezones outperforms midnight bursts.

---

## 4. Thresholds — where the cliffs are

These are the numbers that matter. Stay below the negatives; aim for the positives.

### 4.1 Hard limits (you will get throttled or blocked)

| Signal | Threshold | Source |
|--------|-----------|--------|
| Spam complaint rate | **>0.3%** | Gmail/Yahoo bulk-sender Feb 2024 — *hard limit*. |
| Spam complaint rate | **>0.1%** | Where Gmail "starts noticing." Aim to stay below this. |
| Hard bounce rate | **>2%** | Industry rule of thumb; mailery's default `hardBounceRatePctTrip: 2`. |
| Combined bounce rate | **>5%** | mailery's default `combinedBounceRatePctTrip: 5`. |
| DMARC missing | any | Gmail rejects >5k/day to Gmail addresses without DMARC. |
| One-click unsubscribe | missing | Gmail/Yahoo bulk-sender requirement. |

### 4.2 Health targets (you want to be here)

| Signal | Healthy range | Comment |
|--------|--------------|---------|
| Open rate, marketing | 20-35% | Heavily skewed by MPP — treat directionally. |
| Open rate, transactional | 40-70% | If transactional is <30% you've probably got an inbox-placement problem. |
| Click rate, marketing | 2-5% | Much more trustworthy than open rate. |
| Reply rate | >0.5% if you ask for replies | Hard signal that recipients are real and engaged. |
| Unsubscribe rate | 0.1-0.5% | Below 0.1% on cold lists is suspicious (unsubscribe broken?). |
| Hard bounce rate | <0.5% | Above this you have list-hygiene problems. |
| Spam complaint rate | <0.05% | At this level Gmail considers you trustworthy. |

### 4.3 Google Postmaster Tools — the ground truth

If you send any meaningful volume to Gmail, set up [Postmaster Tools](https://postmaster.google.com). It exposes Gmail's actual reputation buckets:

- **Domain reputation:** `High` / `Medium` / `Low` / `Bad`. Below `High` is concerning; `Bad` means most mail goes to spam.
- **IP reputation:** same scale (only meaningful for dedicated IPs).
- **Spam rate:** Gmail's own measurement of complaints. Cross-reference with your internal numbers.
- **Authentication pass rates:** % of mail passing SPF/DKIM/DMARC. Should be 99%+.
- **Encryption rate:** % using TLS. Should be 100%.
- **Delivery errors:** counts of throttling and reject reasons.

Postmaster data is delayed 1-2 days and only shows up if you send >100/day to Gmail. Don't expect it to work for your first warming sends — it's a tool for *monitoring* warmed domains, not for warming them.

### 4.4 Microsoft SNDS / JMRP

- **SNDS** (Smart Network Data Services) — Microsoft's equivalent of Postmaster for IPs. Free, requires IP ownership proof. Shows complaint rate, trap hits, filter results for Outlook.com / Hotmail / Live.
- **JMRP** (Junk Mail Reporting Program) — feedback loop that emails you when an Outlook user marks your mail as junk. Essential for triggering automatic suppression on complaint.

### 4.5 Apple / iCloud

- No postmaster equivalent. Reputation is opaque.
- Apple Mail Privacy Protection means open rates are nearly worthless for iCloud recipients.
- Apple's filter is unforgiving and recovery from being marked spam is slow (weeks to months).
- **Watch:** ratio of `firstClickAt` to `openedAt` on iCloud domains — if opens are very high and clicks are very low, you're in spam folder.

---

## 5. The warming playbook — domain & IP

Goal: build positive engagement signal at small volume, then double or triple weekly until you reach steady-state volume.

### 5.1 Pre-warm checklist
1. SPF, DKIM, DMARC published and passing (DMARC `p=none` initially, with `rua=` reporting).
2. Custom domain authentication configured at the ESP (no shared `sendgrid.net` Return-Path).
3. List-Unsubscribe (one-click) headers in place.
4. Bounce + complaint webhooks wired in. **In mailery, this is the SendGrid event webhook configured by `mailery setup-sendgrid`.** Verify by checking `mailer_webhook_events`.
5. Suppression list import — pre-load any known unsubscribes, bounces, complaints from previous systems. *Sending to a known-bounced address during warming is reputation suicide.*
6. Pick the engagement-seed audience: your most active 1-10% of users (recent app usage, recent purchase, replied to your last email, etc.). These are who you send to first.

### 5.2 Domain warming schedule — 4-6 weeks

Volumes are **per day**, sent to **engaged recipients only**, ideally spread across morning hours in the recipient timezone:

| Week | Day | Volume | Notes |
|------|-----|--------|-------|
| 1 | 1 | 50 | Highest-engaged users only. Real, useful content. |
| 1 | 2 | 100 | Same audience filter. |
| 1 | 3 | 200 | |
| 1 | 4 | 400 | |
| 1 | 5-7 | 800 | Pause increases if complaint rate climbs. |
| 2 | | 1500 → 3000 → 5000 | Daily doubling, same engaged audience. |
| 3 | | 5000 → 10000 → 15000 | Begin including second-tier engagement. |
| 4 | | 20000 → 30000 → 50000 | Approaching steady state. |
| 5-6 | | Push to full volume | Increase by 50-100% per day, not more. |

If at any point complaint rate >0.1% or Postmaster reputation drops to Medium, **stop increasing** for a week and figure out why.

### 5.3 IP warming (only if you have a dedicated IP)

Same shape as domain warming but volumes can ramp faster *if* the domain is already warmed. New-IP-with-new-domain is the hardest case and needs the full 6-week schedule. New-IP-with-warm-domain is more like 2-3 weeks.

Dedicated IPs are only worth it above ~100k sends/month per ESP guidance. Below that, shared IP reputation is usually better than you'd build alone.

### 5.4 Content during warming

- Send mail people actually want — your most useful, most opened content type. Welcome series and order receipts are ideal because engagement is naturally high.
- Avoid: heavy images, lots of links, "promotional" tone, URL shorteners (bit.ly etc — strongly correlated with spam), attachments.
- Plain-text alternative: always present and meaningful (don't auto-strip to empty).
- From-name and From-address consistency: don't change them mid-warm.

### 5.5 What kills a warm

In order of severity:
1. Buying a list and sending to it.
2. Importing an old list you haven't mailed in >6 months.
3. Sending to inactive users to "re-engage" before you're warmed.
4. A single big volume spike (5x daily volume in one send).
5. A content change that triggers content filters (mass-marketing tone, "FREE", excessive caps, image-heavy).
6. Bounce-back from a misconfigured DNS change (DKIM rotation that breaks signing).

---

## 6. Recovery — when reputation has tanked

If you're in spam folder and Postmaster says Low/Bad:

1. **Stop sending immediately to anyone but your most engaged segment** — top 1% by clicks in last 30 days.
2. **Re-verify auth** — SPF/DKIM/DMARC alignment, in case DNS drifted.
3. **Audit complaints + bounces** — what segment is generating them? Suppress aggressively.
4. **Reduce volume by ~80%** for 2-3 weeks while sending only useful content to engaged users.
5. **Wait.** Recovery takes 2-6 weeks of consistent positive signal. There is no shortcut.

If you're tempted to switch domains to "reset" — don't. New-domain warming is also weeks of pain, and you've abandoned whatever positive history exists. Repair beats restart.

---

## 7. Subdomain strategy

**Send marketing and transactional from different subdomains under the same root.**

Example: `txn.example.com` and `marketing.example.com`, both with their own DKIM, both authenticated under `example.com` for DMARC alignment.

Why:
- Transactional mail (receipts, password resets) has naturally high engagement and ~0% complaint rate. Keep it pristine.
- Marketing mail has higher complaints by nature. Isolate it so its reputation doesn't poison transactional.
- If marketing reputation crashes, password resets keep landing.
- You can warm them independently — usually transactional doesn't need warming because volume is low and engagement is high.

**In mailery:** the `senderDomains` config + `senderDomain.ts` validator already enforces a per-kind From-address registry. Use it. Set `marketing` and `transactional` to different subdomains and refuse to start if a template's From doesn't match its kind.

---

## 8. What mailery already does

These are wired in code today; you don't need to add them.

- **Auth setup helpers:** `mailery setup-sendgrid` and `mailery setup-dmarc` provision domain authentication, event webhooks, and DMARC TXT records. Optional Cloudflare DNS publish via API. Run for every new sending domain.
- **Bounce + complaint suppression:** `webhook.ts` processes SendGrid events, suppressions collection auto-grows, future sends to suppressed addresses fail closed.
- **Per-(sender domain × kind) circuit breaker:** `health.ts` watches `bounceRate`, `hardBounceRate`, `complaintRate` per bucket across a rolling window. Trips at the thresholds in §4.1 (configurable per `circuitBreaker` config). One subdomain tanking doesn't hold mail for others. Manual resume via `/admin/mailer/api/health/resume` (whole-system or single-bucket).
- **Default trip thresholds:**
  - `hardBounceRatePctTrip: 2`
  - `complaintRatePctTrip: 0.3`
  - `combinedBounceRatePctTrip: 5`
- **Per-kind sender-domain validation:** templates can't be published if their From-address doesn't match the registered domain for that kind.
- **One-click unsubscribe:** marketing sends emit RFC 8058 List-Unsubscribe-Post headers; mailery's `/m/unsub/:token` route handles the POST.
- **Setup status check suite:** `setup-status.ts` surfaces auth, webhook, suppression, DNSBL, Postmaster, SNDS, DMARC, and circuit-breaker configuration health on the admin dashboard.
- **DNSBL monitoring:** daily DNS scans of every configured sender domain (and any dedicated IPs) against Spamhaus / SURBL / URIBL / Barracuda / SORBS / SpamCop. Listings surface in setup-status and on the admin Health screen.
- **Google Postmaster Tools puller:** daily ingest of reputation tier + spam ratio + auth pass rates per domain. Auto-trips the (domain × allowed-kind) bucket on `BAD` reputation.
- **Microsoft SNDS puller:** for operators on dedicated IPs, daily ingest of per-IP filter verdict (GREEN/YELLOW/RED), complaint rate, trap counts.
- **DMARC RUA report ingestion:** upload `.zip`/`.gz` aggregate reports via the admin UI; mailery parses RFC 7489 XML, persists per-source-IP alignment failures, and ships a policy-progression suggestion when the data justifies advancing.
- **Content linter (publish gate + live editor):** catches missing plain-text, image-only bodies, URL shorteners, missing `{{unsubscribeUrl}}` on marketing, all-caps subjects, subjects >60 chars, >10 links. Live results in the template editor sidebar; publish refused on errors.
- **List-hygiene report:** engagement breakdown over 30/60/90/180-day windows + sunset-impact projection (recent bounce / complaint rates split into cohort vs remainder). Visibility-only.
- **Mail-Tester integration (optional):** when configured, the template editor can send a draft to Mail-Tester, fetch a 0-10 score with per-rule feedback, and gate publish below the configured threshold (default 8.0).

---

## 11. The TL;DR

- Auth (SPF + DKIM + DMARC, aligned) is non-negotiable. Get it right before anything else.
- Below **0.3% spam complaint, 2% hard bounce, 5% combined bounce.** mailery trips a circuit breaker at exactly these defaults — they're not arbitrary.
- New domain: 4-6 week warm, doubling daily volume on engaged users only. New IP if you bought one: similar ramp.
- Separate subdomains for marketing vs transactional. Mailery's `senderDomains` registry enforces this if you configure it.
- Watch Google Postmaster Tools weekly. It's the only ground-truth instrument you have for Gmail.
- The most damaging single mistake is sending to a stale/imported list. The most damaging *ongoing* practice is mailing inactive users to "wake them up."
- Mailery's circuit breaker is your safety net, not your strategy. Don't rely on it tripping; you should never get close.
