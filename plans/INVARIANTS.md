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

The filter must actually filter. Through v0.14 it did not: the `opened` branch of `openOrClickCount` incremented unconditionally, so `hasOpenedExcludingBots` was identical to `hasOpened`, and nothing ever wrote `clickedLinks[].userAgent`, so every click scored human too. An API that promises bot exclusion and delivers none is worse than not offering one — someone builds a re-engagement flow on it and wonders why everyone looks engaged. Both endpoints now record the requesting User-Agent (`opens[]`, `clickedLinks[].userAgent`) and both predicate paths apply the same pattern.

The classification rules, which are behaviour and not implementation detail:

- A send counts if **any** of its recorded opens (or clicks) looks human. One scanner prefetch does not disqualify a send the recipient also read.
- A **missing** User-Agent counts as human, not bot. Image fetches frequently carry none, so the alternative silently discards real engagement — and would retroactively zero flows branching on sends recorded before User-Agents were stored.
- The pattern and an optional timing signal (`minOpenDelayMs`, off by default) are configurable via `botFilter`; the built-in pattern is the default.

## 7a. Tracking URLs are signed

`/m/open` and `/m/click` are unauthenticated and their only identifier is a Mongo ObjectId — 4 bytes of timestamp, 5 bytes constant per process, 3 bytes of sequential counter. One tracking URL from one received email therefore predicts its neighbours, and forged opens are an automation input, not just a chart. Every generated tracking URL carries a truncated HMAC over its own path components, keyed with `unsubscribeSecret` and scoped to `open` or `click` so neither can be replayed as the other.

Compatibility is part of the invariant, because mail already delivered will keep being opened for years:

- A signature that is present and **wrong** is rejected in every mode. Grace covers "this URL predates signing", never "this URL was signed by someone without the key".
- A **missing** signature is accepted while `requireSignedTrackingUrls` is false (the default) and logged at `info`, so an operator can watch legacy traffic decay before flipping it.
- Rejections are invisible to the caller: the pixel still returns a 200 PNG and a bad click 404s exactly like an unknown send. Any distinguishable response is an enumeration oracle.
- Tracking URLs do not expire by default (`trackingUrlLifetimeDays: 0`). A legitimate open a year later is real data; the signature, not a deadline, is what proves possession.

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
- Never requires re-authentication
- **Never returns 200 for an unsubscribe it did not durably record**

That last clause is the invariant; everything below is how it is kept.

`POST /m/unsub/<token>` awaits the Mongo write, bounded by `unsubscribeWriteTimeoutMs` (default 5s):

| outcome | response |
|---|---|
| write succeeds (the normal case, sub-millisecond) | 200 |
| write fails or exceeds the budget, and a journal is configured | append to the journal, then 200 |
| no journal configured, or the journal write also fails | **503** + `Retry-After` |

The endpoint is still fast — the budget is only ever spent during an outage — but "fast" is subordinate to "true". Through v0.14 the route answered 200 unconditionally *before* attempting either write, which made the 503 branch unreachable and turned every failed write into a recipient who had been told they were unsubscribed and would keep receiving mail. That is a compliance failure, not a dropped metric.

### The journal

`MailerConfig.pendingUnsubsPath` — one JSON object per line, file 0600 inside a 0700 directory, opened `O_NOFOLLOW`.

It is **opt-in and has no default**. The old default was `/tmp/mailery-pending-unsubs.jsonl`: world-writable, wiped on reboot, and — because the drain was never written — never read back. There is no safe replacement default: a library mounted into an unknown host cannot pick a directory that is at once writable, durable and private, and the file holds recipient addresses in plaintext outside the database, so its location is the operator's decision. Unset means the 503 row above, which is a worse experience and a better outcome than the silent loss it replaces.

### The drain

`drainPendingUnsubscribes` runs from `mailer:tick` (`src/server/runner/pending-unsubs.ts`) and is exported for hosts that don't run the tick. It replays each entry through the same `applyUnsubscribe` the live route uses.

- **Idempotent** — the suppression write is a `$setOnInsert` upsert, the subscription write a `$set` to a terminal state. Applying twice is applying once.
- **Crash-safe** — a pass claims a batch by renaming the journal aside; a pass that dies leaves its claim file behind and a later pass adopts it. Entries that could not be applied are appended back to the live journal *before* the claim is unlinked, so the crash window duplicates rather than drops.
- **Concurrency-safe** — claiming and adopting are `rename`, atomic within a directory, so two processes can drain the same journal without owning the same batch. (Consequence: the journal must be on a local filesystem, not NFS.)
- **Tolerant** — an absent, empty, truncated or hand-mangled file never crashes the drain and never causes a valid neighbouring entry to be skipped. Unusable lines are logged and dropped; entries that fail to *apply* are retried forever and get louder, never discarded.

### What the provider does not do for us

An earlier version of this invariant said a 503 was safe because "SendGrid (or the provider) will queue the unsubscribe internally as a fallback." That is false and was worth removing. The `List-Unsubscribe` URL points at *us*; the one-click POST comes from the recipient's mail client, and the sending provider never sees the request and has nothing to queue. Our journal is the only fallback there is, which is why it had to be finished rather than deleted.

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

## 16. Webhook step URLs are never templated

`step.url` on a `webhook` flow step is passed to `fetch` verbatim (`src/server/runner/step.ts`). It is never rendered through Handlebars, and it must stay that way.

The URL is authored only through the admin flow routes, so the reachable destinations are fixed by a privileged system admin. Under that constraint "the server can POST to an arbitrary URL" is an intended admin capability, not a hole.

Templating it would invert that. `POST to {{contact.callbackUrl}}` is a natural request, but it hands the destination of a server-side fetch — originating inside the deployment's network, past the perimeter — to whoever controls the template data (contact fields, event properties, adapter vars). That is SSRF: cloud metadata endpoints, internal admin services, localhost. If templated webhook URLs are ever genuinely needed they require a destination allowlist plus DNS/redirect-aware egress filtering, not a render call.

The zod schema (`url: z.string().url()`, `src/shared/schemas.ts`) validates shape only and grants no protection here.

Every call is attributable: the `webhook_called` audit entry records the resolved URL and the response status (or the error, on the exhausted-retry path).

## 17. Providers fail closed on webhook verification

`verifyWebhook` returns `false` for anything it cannot positively authenticate — malformed input, missing headers, no signing key configured — and never throws (the public router treats a thrown error as a 500).

This binds every provider including the no-op ones. `NullProvider.verifyWebhook()` returns `false`: it holds no signing key, so it can never establish authenticity, and answering "yes" would mean unsigned payloads are accepted as genuine in exactly the dev/staging configurations where that is easiest to miss.
