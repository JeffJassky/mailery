# 08 — Compliance

Email is one of the most regulated forms of digital communication. This document covers what the library does to keep host apps compliant.

## What the library handles

| Concern | How |
|---|---|
| **CAN-SPAM** (US) | Mandatory unsubscribe link in marketing emails; honored within 10 days (we honor within seconds) |
| **GDPR / UK GDPR** | Consent tracking on subscriptions, data export, right-to-erasure with hashed-suppression invariant |
| **CASL** (Canada) | Same as GDPR; explicit consent tracking |
| **CCPA / CPRA** (California) | Per-contact opt-out, right-to-know exports |
| **Gmail / Yahoo bulk-sender requirements** (2024+) | One-click unsubscribe (RFC 8058), DMARC alignment guidance, complaint rate monitoring |
| **List-Unsubscribe header** | Automatically injected on every marketing send |
| **Footer requirements** (physical address) | Configurable footer block on every marketing template, enforced via template lint |

## What the library does NOT handle (and what the host must do)

- Lawful basis for processing (you decide: legitimate interest, consent, contract)
- Privacy policy disclosure of email automation + tracking
- Cookie banners (unrelated to email)
- Geographic data-residency requirements (Mongo location is your call)
- Marketing consent on signup forms (you build the UI; mailer records what you tell it)
- Spam filters in inboxes (provider's job)

## Unsubscribe

The endpoint:

```
GET  /m/unsub/:token    → renders confirmation page; one-click POST link
POST /m/unsub/:token    → records unsubscribe, returns 200 immediately
```

### Token format

Tokens are HMAC-signed:

```
token = base64url(
  email + '|' + scope + '|' + expiresAt +
  '|' + hmac_sha256(secret, email + '|' + scope + '|' + expiresAt)
)
```

Where:
- `email` = recipient email
- `scope` = `'all'` or `'marketing'` or `'transactional'` (typically marketing)
- `expiresAt` = ISO timestamp (e.g. 90 days from send)
- `secret` = `config.unsubscribeSecret` (env-supplied)

Tokens expire because long-lived signed URLs are a liability. Re-clicking an expired link still surfaces the confirmation page; the user can re-confirm with email + reCAPTCHA fallback.

### One-click (RFC 8058)

Marketing sends include both headers:

```
List-Unsubscribe: <https://yourdomain.com/m/unsub/abc123...>, <mailto:unsub@yourdomain.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

When Gmail (and most modern clients) see `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, they show a one-click unsub button in the inbox UI. Clicking it sends a POST to the URL with body `List-Unsubscribe=One-Click`.

Our endpoint handles both GET (browser visit) and POST (one-click). POST never shows a confirmation page — it must complete the unsubscribe and return 200 instantly. Failing to do so causes Gmail to mark future sends as spam.

### Bulletproof unsubscribe (`INVARIANTS.md` rule 8)

The endpoint must succeed even if mailer's Mongo is degraded. Implementation:

The endpoint never returns 200 for an unsubscribe it has not durably
recorded somewhere. Three outcomes, in order of preference:

```ts
app.post('/m/unsub/:token', async (req, res) => {
  const decoded = verifyToken(req.params.token)
  if (!decoded) return res.status(400).end()

  // Bounded so a hung Mongo cannot hold the client open past the
  // provider's patience. Not unbounded, and not fire-and-forget.
  try {
    await withTimeout(applyUnsubscribe(collections, decoded), unsubscribeWriteTimeoutMs)
    return res.status(200).end()
  } catch {
    // Fallback: append to the journal for the tick drain to replay.
    if (await journal.append(decoded)) return res.status(200).end()
    // Nothing durable happened. Say so.
    res.setHeader('Retry-After', '300')
    return res.status(503).end()
  }
})
```

The tension with "return 200 instantly" is real — providers do retry on
5xx, and Gmail does penalise a slow or failing unsubscribe. It is
resolved with a bounded wait rather than by answering before doing the
work: a 200 that precedes the write is not fast, it is wrong, and it made
the 503 branch unreachable.

On the next tick the drain claims the journal by renaming it, replays
each entry through the same `applyUnsubscribe` the live route uses, and
appends anything undrained back to the live journal *before* unlinking
the claim — so a crash mid-drain duplicates rather than drops, and replay
is idempotent.

If the journal write also fails there is no further fallback, which is
why the answer is 503. An earlier version of this document claimed the
provider still holds the unsubscribe in its own queue as redundancy. It
does not: the `List-Unsubscribe` URL points at us, and the one-click POST
comes from the recipient's mail client, so the sending provider never
sees the request. The journal is the only fallback there is.

### Programmatic unsubscribe

Hosts can unsubscribe a contact directly:

```ts
await mailer.unsubscribe('user@example.com', {
  scope: 'all',
  reason: 'manual',
  source: 'support-ticket:12345',
})
```

Goes through the same code path as the public endpoint. Writes to `mailer_suppressions` and updates `mailer_subscriptions.status`.

## Subscription state

`mailer_subscriptions.status` is the source of truth for "can I send to this contact?":

| Status | Marketing sends? | Transactional sends? |
|---|---|---|
| `subscribed` | ✓ | ✓ |
| `pending_doi` | ✗ (must confirm first) | ✓ |
| `unsubscribed` | ✗ | ✓ |
| `bounced` | ✗ | ✗ (their email is broken) |
| `complained` | ✗ | ✗ (avoid future spam reports) |

Transactional sends are intentionally permissive — even unsubscribed users can receive critical communications (security alerts, billing failures). Hosts who want stricter rules can configure `transactionalRespectUnsubscribe: true`.

## Double opt-in (DOI)

Optional but recommended for marketing list quality and for GDPR clarity in EU jurisdictions.

When enabled in config (`requireDoubleOptIn: true`), `upsertSubscription({externalId, source})`:

1. Creates `mailer_subscriptions` with `status: 'pending_doi'`
2. Generates a DOI token (HMAC-signed similar to unsubscribe)
3. Stores `doiTokenHash`, `doiRequestedAt`
4. Fires a special "doi-request" template send (transactional, bypasses subscription check)
5. Waits for the user to click the confirmation link

The confirmation endpoint:

```
GET /m/confirm-doi/:token
  → verifies token
  → sets status='subscribed', doiConfirmedAt=now, doiIp=req.ip
  → returns 200 with a thank-you page
  → fires 'subscription.confirmed' event so flows can pick up the activation
```

If a user doesn't confirm within 7 days (configurable), the pending row stays — no further DOI requests are auto-sent (anti-spam). The host can re-request DOI via API.

## GDPR data export

```ts
const data = await mailer.exportContactData(externalId)
```

Returns:

```ts
{
  subscription: { /* mailer_subscriptions doc */ },
  events: [ /* all mailer_events for this contact */ ],
  flowRuns: [ /* all mailer_flow_runs */ ],
  sends: [ /* all mailer_sends (with metadata but bodies summarized) */ ],
  suppressions: [ /* any mailer_suppressions matching email */ ],
  tags: [ /* current tag set */ ],
}
```

JSON-serializable. The host wraps it in its own GDPR export (which includes the user's profile, business data, etc.).

## GDPR forget (right-to-erasure)

The critical operation. Per `INVARIANTS.md` rule 9:

```ts
async function forget(externalId: string) {
  const sub = await Subscriptions.findOne({ externalId })
  if (!sub) return  // nothing to forget

  const email = sub.emailAtSubscribe
  const emailHash = sha256(email.toLowerCase())

  // 1. Delete all PII-bearing records
  await Events.deleteMany({ externalId })
  await FlowRuns.deleteMany({ externalId })
  await Sends.deleteMany({ externalId })   // body snapshots gone
  await Subscriptions.deleteMany({ externalId })
  await Leads.deleteMany({ email })

  // 2. INSERT a hashed suppression record — this is the rule that protects future-us
  await Suppressions.insertOne({
    email: null,         // blanked
    emailHash,
    scope: 'all',
    reason: 'gdpr_forget',
    source: 'gdpr_request',
    addedAt: new Date(),
  })

  // 3. Audit
  await AuditLog.insertOne({
    actor: 'system:gdpr',
    action: 'gdpr.forget',
    resource: { collection: 'mailer_subscriptions', id: sub._id },
    occurredAt: new Date(),
  })
}
```

Why the hashed suppression? If the same email re-enters the system later (legacy CSV import, OAuth replay, a partner integration), the send-time suppression check hashes the incoming email and finds the existing `emailHash`. The send is blocked before it reaches the provider — without ever needing to retain the plaintext email.

The host's own GDPR processing should call this as part of its erasure flow:

```ts
// In your delete-user route:
await User.deleteOne({ _id })
await mailer.forget(_id.toString())
```

## CAN-SPAM footer

Every marketing template must include:
1. A working unsubscribe mechanism (handled via `{{unsubscribeUrl}}`)
2. The sender's valid physical postal address
3. Clear identification of the sender

The library provides a Handlebars helper for the second:

```mjml
<mj-text>{{senderAddress}}</mj-text>
```

Configured globally:

```ts
new Mailer({
  // ...
  senderAddress: '12 Main Street, Brooklyn, NY 11201, USA',
})
```

Template lint enforces this. Publishing a marketing template without `{{senderAddress}}` (or a string matching the configured address) emits a warning. Configurable to fail-the-publish in strict mode.

## Audit log

All mutating admin actions write to `mailer_audit_log` (see `02-data-model.md`). Critical for:
- GDPR Article 30 records (proof of processing)
- Security review (who changed the suppression list?)
- Operator accountability

Retention: forever by default. Configurable archive policy.

## Spam complaint handling

Hard rule: a complaint always suppresses + marks subscription `complained`, regardless of how it arrives:

- Provider FBL (Feedback Loop) → webhook → `complaint` event
- User flags as spam in Gmail → eventually appears in provider's complaint feed
- User responds to email with "stop" → not auto-handled, but host can pipe inbound parsing here

If complaint rate exceeds 0.3% in any rolling-hour window, the circuit breaker trips and marketing sends pause until a human resumes.

## Deliverability setup

Authentication (SPF, DKIM, DMARC) is the single biggest deliverability lever and the easiest one to get wrong. The library doesn't perform DNS surgery on the host's behalf, but it surfaces verification status and warns when sending from an unauthenticated domain.

### Provider domain auth check

Each provider implements an optional `verifyDomainAuth(domain)` method:

```ts
interface MailProvider {
  // ...existing methods...
  verifyDomainAuth?(domain: string): Promise<DomainAuthStatus>
}

interface DomainAuthStatus {
  domain: string
  spf: 'pass' | 'fail' | 'unknown'
  dkim: 'pass' | 'fail' | 'unknown'
  dmarc: 'none' | 'quarantine' | 'reject' | 'unknown'
  details?: object
  checkedAt: Date
}
```

For SendGrid: hits the [Authenticated Domains API](https://docs.sendgrid.com/api-reference/domain-authentication). For Postmark: hits the [Sender Signatures API](https://postmarkapp.com/developer/api/signatures-api). Implementations cache for 1 hour.

### Admin UI surface

A "Deliverability" panel on the dashboard (`09-admin-ui.md`) shows, per configured From-domain:

- SPF / DKIM / DMARC status (✓ / ✗ / ?)
- Last check timestamp
- A "How to fix" link per failed row, deep-linking to the provider's setup docs
- DMARC policy alignment — if `p=none`, suggest moving to `p=quarantine` once the alignment looks clean for 30 days
- Bulk-sender requirements check (Gmail/Yahoo 2024+): list-unsubscribe configured ✓, complaint rate under 0.3% ✓, one-click POST supported ✓

### Startup warning

On `Mailer.init`, the library calls `verifyDomainAuth` for each configured From-domain (in the background, non-blocking). Failures log a `warn` with remediation steps. Repeat hourly until resolved or muted.

### Bounce promotion

`mailer_sends.bounceType` is normalized per provider (`INVARIANTS.md` rule 13). Soft → hard promotion runs as part of the tick:

```ts
async function promoteSoftBounces() {
  // Group soft bounces in the last `softBouncePromotionWindow` days by email.
  // Any email with >= `softBouncePromotionThreshold` soft bounces gets a hard suppression.
  // Defaults: 3 soft bounces / 30 days.
}
```

Configurable via `softBouncePromotionThreshold` and `softBouncePromotionWindowDays` in `11-configuration.md`.

### Send-rate guard

Each provider has a `sendRatePerSecond` config (default conservative — 10/sec for SendGrid shared IP). The send worker rate-limits via BullMQ's [`limiter`](https://docs.bullmq.io/guide/rate-limiting) feature, capped per provider. Going above provider limits is the second-fastest way to tank reputation (after no DKIM).

## Audit trail for compliance investigations

If you're audited (or a contact asks "did you send me this?"), the trail is:

```
mailer_subscriptions       → consent timestamp + IP + source
mailer_events              → behavioral history
mailer_sends               → every send to this contact, when, what, status
mailer_audit_log           → every admin action that affected this contact
```

Combined into the GDPR export view, this gives a complete answer for any contact-related inquiry.
