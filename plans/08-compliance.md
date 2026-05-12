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

```ts
app.post('/m/unsub/:token', async (req, res) => {
  const decoded = verifyToken(req.params.token)
  if (!decoded) return res.status(400).end()

  // Always 200 fast — providers retry aggressively on 5xx
  res.status(200).end()

  try {
    await applyUnsubscribe(decoded.email, decoded.scope)
  } catch (err) {
    // Fallback: write to local disk for later drain
    fs.appendFileSync(
      pendingUnsubsPath,
      JSON.stringify({ email: decoded.email, scope: decoded.scope, at: Date.now() }) + '\n',
    )
    metrics.increment('unsub.fallback_to_disk')
  }
})
```

On the next tick, the drain reads `pendingUnsubsPath`, replays each unsub through the normal path, and truncates the file on success. Disk-write failure is the last line of defense — at that point we've returned 200 to the client, and SendGrid (or the provider) still has the unsubscribe in their own queue as redundancy.

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

## Audit trail for compliance investigations

If you're audited (or a contact asks "did you send me this?"), the trail is:

```
mailer_subscriptions       → consent timestamp + IP + source
mailer_events              → behavioral history
mailer_sends               → every send to this contact, when, what, status
mailer_audit_log           → every admin action that affected this contact
```

Combined into the GDPR export view, this gives a complete answer for any contact-related inquiry.
