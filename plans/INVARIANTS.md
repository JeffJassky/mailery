# INVARIANTS

A short list of non-negotiable rules. Every part of the library — every PR, every code review — checks against these. Violations are bugs.

## 1. Every event firing is idempotent

Every event reaching `mailer_events` has a `dedupeKey`. Duplicate keys are silently dropped at insert time via a unique index. No `fire()` call ever creates two event rows.

Two paths get you a key:

- **Pass it explicitly**: `mailer.fire(name, externalId, props, dedupeKey)`. Use this when the source has a natural id (Stripe event id, webhook id) or when you need control.
- **Register a policy and let the library derive it**: `mailer.registerEvent('Created', { dedupePolicy: 'once-per-contact' })`. Then `mailer.fire('Created', externalId)` auto-derives `${externalId}:Created`. Policies: `'once-per-contact'`, `'once-per-day'`, `'every-time'` (key includes a UUID).

The library refuses `fire()` only when both: no `dedupeKey` was passed AND no policy is registered for the event name.

Recommended dedupeKey shapes when constructing by hand:
- `${externalId}:${eventName}` for events that should fire at most once per contact
- `${externalId}:${eventName}:${YYYY-MM-DD}` for once-per-contact-per-day
- `${webhookId}` or `${stripeEventId}` for external-webhook-driven events

## 2. Use `fireFromSession` inside Mongo transactions

If the host fires an event as part of a multi-document Mongo transaction, it must use `mailer.fireFromSession(session, ...)` which writes to `mailer_outbox` inside the transaction. The drain promotes it to `mailer_events` after the transaction commits — so an event never escapes a rolled-back business write.

Outside of transactions, `mailer.fire(...)` writes directly to `mailer_events`. Most hosts won't need the outbox path; it exists for those that do.

## 3. Suppression is re-checked at send time, never trusted from enqueue time

The send worker re-loads suppression state before every `provider.send(...)`. Don't precompute "this contact is sendable" at flow entry — it's stale by the time the email goes out.

## 4. Transactional and marketing have separate suppression scopes

Hard rule: suppression lists are scoped (`'marketing'`, `'transactional'`, `'all'`). A user unsubscribing from your newsletter still receives their password reset. The send-time check uses `template.kind` to decide which scopes apply.

Strong recommendation (not enforced): use a distinct From address for transactional vs marketing (e.g. `tx@yourdomain.com` vs `hello@yourdomain.com`), and ideally distinct provider accounts/subusers. This isolates reputation — a marketing complaint storm shouldn't tank password-reset deliverability. Small apps can run both off one address and one account; the library will work, but the reputation risk is theirs to carry.

Config surfaces both:

- `defaultFrom` / `transactionalFrom` in `fromDefaults` / `transactionalFromDefaults` (`11-configuration.md`).
- `defaultProvider` / `defaultTransactionalProvider`.

When the second of each pair is unset, the first is used and the library logs a warning at startup.

## 5. Webhook events are deduplicated AND reconciled

Every inbound webhook event is recorded in `mailer_webhook_events` with `unique(provider, providerEventId)`. Duplicate deliveries are silently dropped.

Additionally, a daily reconciliation job (`mailer:tick` once a day) pulls the provider's Events API for the last 24h and inserts anything missing — webhook delivery is unreliable enough that this matters.

## 6. The circuit breaker blocks marketing sends, never transactional

When `mailer_health.status === 'tripped'`:
- Marketing sends are queued and held (not failed; resume picks them up).
- Transactional sends bypass the breaker and proceed.
- An alert fires every 5 minutes until manually resumed.

Only a human (admin UI) can clear the trip. The library never auto-resumes.

## 7. Open/click predicates exist but are labeled noisy

`hasOpened` and `hasClicked` predicates are available. Apple Mail Privacy Protection pre-fetches images, and corporate link-protection services pre-fetch URLs — both inflate counts. The library surfaces this:

- Single-open / single-click predicates carry a "noisy signal" badge in the admin UI when used in a flow definition.
- A bot-filtered variant is available: `hasOpenedExcludingBots`, `hasClickedExcludingBots`, which exclude events whose User-Agent matched the bot list (`Mimecast`, `proofpoint`, `SafeLinks`, common headless browsers).
- Aggregated predicates (`openedAtLeastN`, `clickedAtLeastN` over a window) are preferred for engagement segmentation.

Recommended pattern for "resend to non-openers in 3 days":

```ts
{ type: 'wait', value: 3, unit: 'days' },
{ type: 'condition', test: { not: { hasOpenedExcludingBots: { templateSlug: 'newsletter-may', sinceFlowStart: true } } }, ifFalse: 'exit' },
{ type: 'send', templateSlug: 'newsletter-may-resend' },
```

Where a product event exists ("user clicked through and used the feature"), prefer it — it's a real engagement signal, not a deliverability signal.

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

Direct-DB scripts should also write an audit row. This is documented in `DIRECT_DB.md` but not enforced — direct DB access can bypass us. Audit log presence is a quality signal, not a security boundary.

## 11. Broadcasts to >N contacts require confirmation

The admin UI requires the operator to type the exact recipient count before scheduling a broadcast over a configurable threshold (default 1,000). Below the threshold, single-click is allowed.

This prevents the "I clicked send instead of preview" disaster that has burned every email marketer at least once.

Programmatic broadcasts (created via direct DB writes by scripts) skip this gate. The script's author is responsible for the recipient count being correct.

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
