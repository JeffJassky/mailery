# INVARIANTS

A short list of non-negotiable rules. Every part of the library — every PR, every code review, every agent action — checks against these. Violations are bugs.

## 1. `fire()` requires a `dedupeKey`

Every call to `mailer.fire(eventName, externalId, props, dedupeKey)` must pass a `dedupeKey`. The library refuses calls without one. Idempotency is mandatory.

Recommended dedupeKey shapes:
- `${externalId}:${eventName}` for events that should fire at most once per contact
- `${externalId}:${eventName}:${YYYY-MM-DD}` for events that should fire at most once per contact per day
- `${webhookId}` or `${stripeEventId}` when the source is an external webhook (Stripe etc.)

If you genuinely need an event to fire multiple times, include a sequence number or timestamp in the key.

## 2. Outbox writes are the source of truth for events in transactions

When the host app does business writes in a Mongo session/transaction, it MUST use `mailer.fireFromSession(session, eventName, externalId, props, dedupeKey)`. That writes to `mailer_outbox` inside the transaction. The drain promotes it to `mailer_events` outside the transaction.

Calling `mailer.fire(...)` from inside a transaction is a bug — the event will be dispatched even if the transaction aborts.

## 3. Suppression is re-checked at send time, never trusted from enqueue time

The send worker re-loads suppression state before every `provider.send(...)`. Don't precompute "this contact is sendable" at flow entry — it's stale by the time the email goes out.

## 4. Transactional and marketing never share a sender identity

- Marketing sends use a marketing-scoped From address (e.g. `hello@yourdomain.com`).
- Transactional sends use a transactional-scoped From address (e.g. `tx@yourdomain.com`).
- The two domains have separate SendGrid event webhooks (or separate provider accounts).
- Suppression lists are scoped: marketing suppressions don't block transactional sends.
- Recommended: separate provider account / API key per kind for reputation isolation.

A user unsubscribing from your newsletter MUST still receive their password reset.

## 5. Webhook events are deduplicated AND reconciled

Every inbound webhook event is recorded in `mailer_webhook_events` with `unique(provider, providerEventId)`. Duplicate deliveries are silently dropped.

Additionally, a daily reconciliation job (`mailer:tick` once a day) pulls the provider's Events API for the last 24h and inserts anything missing — webhook delivery is unreliable enough that this matters.

## 6. The circuit breaker blocks marketing sends, never transactional

When `mailer_health.status === 'tripped'`:
- Marketing sends are queued and held (not failed; resume picks them up).
- Transactional sends bypass the breaker and proceed.
- An alert fires every 5 minutes until manually resumed.

Only a human (admin UI) can clear the trip. The library never auto-resumes.

## 7. Open/click events do not trigger flow branches

Apple Mail Privacy Protection pre-fetches all images on inbox arrival, marking every email as "opened" within seconds. Many corporate firewalls also pre-fetch links. A single open or click event is not a meaningful engagement signal.

Predicates `hasOpened` and `hasClicked` are intentionally absent from V1. If a flow needs engagement-based branching, use:
- A behavioral event the host fires when something product-relevant happens (e.g. user clicked through and used a feature)
- Aggregated engagement over time (e.g. opened ≥ 3 messages in last 30 days) — V2 candidate

Don't tempt agents to wire single-event branching by adding the primitive.

## 8. Unsubscribe is bulletproof

The `/m/unsub/<token>` endpoint:
- Accepts GET and POST (RFC 8058 one-click)
- Verifies HMAC-signed token
- Writes the unsubscribe even if Mongo is degraded — falls back to writing to local disk (`mailer-pending-unsubs.jsonl`) for later drain
- Returns 200 quickly (clients are impatient and providers retry aggressively otherwise)
- Never requires re-authentication

If the DB is fully down and disk is also unwritable, the endpoint returns 503 and SendGrid (or the provider) will queue the unsubscribe internally as a fallback. We don't pretend perfect availability — we make sure compliance is never silently dropped.

## 9. GDPR forget keeps a hashed suppression record forever

When a contact requests deletion:
1. Delete subscription, events, flow_runs, sends (full purge of PII for that externalId/email).
2. Insert a `mailer_suppressions` row with `reason: 'gdpr_forget'`, `scope: 'all'`, **`email` blanked**, but `emailHash` retained (sha256 of original email).
3. Future writes that touch the same hashed email are blocked before they reach the provider.

This protects against the most common bug: a deleted user re-importing through a side channel (e.g. legacy CSV import) and getting re-emailed despite their original deletion. The hashed suppression catches it.

## 10. Audit log is append-only

Every mutation to `mailer_flows`, `mailer_templates`, `mailer_broadcasts`, `mailer_suppressions`, plus every manual admin action and circuit breaker reset, writes to `mailer_audit_log`. No deletes. No updates. Forever.

If agents make direct DB writes, they should also write an audit row. This is documented in `AGENT_GUIDE.md` but not enforced — direct DB access can bypass us. Audit log presence is a quality signal, not a security boundary.

## 11. Broadcasts to >N contacts require confirmation

The admin UI requires the operator to type the exact recipient count before scheduling a broadcast over a configurable threshold (default 1,000). Below the threshold, single-click is allowed.

This prevents the "I clicked send instead of preview" disaster that has burned every email marketer at least once.

Programmatic broadcasts (created via direct DB writes by agents) skip this gate. Agents are expected to know what they're doing — but they should also create a `proposal` audit entry rather than direct-publish for cross-app broadcasts.

## 12. Times are always UTC

Every `Date` in Mongo is UTC. Display in the admin UI is in the operator's locale. Cron expressions are interpreted in UTC unless the flow specifies a timezone.

## 13. Bounce classification follows provider rules, normalized

Provider terminology differs:
- SendGrid: `bounce` (with `type: 'bounce' | 'blocked'`) + `dropped`
- Postmark: `HardBounce`, `SoftBounce`, `Transient`, `Subscribe`, etc.
- SES: `Permanent` vs `Transient`

Library normalizes to `hard | soft` per provider's documented mapping, stored on `mailer_sends.bounceType`. Mapping table maintained in each `provider.ts` file.

Hard bounces always suppress. Soft bounces never suppress; provider re-tries internally. Three soft bounces for the same address within 30 days promote to a hard bounce (suppression) — configurable.

## 14. Contact identity goes through the adapter, always

Mailer never writes to the host's user records. Mailer never duplicates email/firstName/etc. in its own storage (except `emailAtSend` and `emailAtEntry` snapshots used for compliance/diagnostics).

If a template references `{{contact.firstName}}`, that's the adapter's `Contact.fields.firstName` at render time. If the host doesn't expose `firstName` in its `toContact()` projection, the template renders the default value from `variablesSchema` (or empty).

Single source of truth, no sync.

## 15. Flow versioning protects in-flight runs

Editing a flow doesn't affect contacts already in it. Each `flow_run` pins `flowVersion` on entry. The runner uses `mailer_flow_versions` to look up the steps at that version.

If you want to forcibly re-route in-flight runs to the new definition, that's a manual operation: exit the existing runs and re-enter contacts. The library will never do it implicitly.
