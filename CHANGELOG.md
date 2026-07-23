# Changelog

## 0.10.1 — Waits hold

### Fixed

- **A flow whose first step is a `wait` could skip it.** The schedule was
  enforced only by the callers — the sweep's `nextActionAt <= now` filter and
  the advance job's delay — so the sweep could select a run while it was due,
  have the run's own advance job park it on a wait in the meantime, and then
  process the step AFTER the wait. This was reachable on every tick: a freshly
  triggered run is inserted with `nextActionAt = now`, and `runTick` runs the
  trigger scan and the sweep back to back. A win-back flow opening with
  "wait 4 days" would send its first mail immediately on entry.
  `processOneRunStep` now refuses to act on a run parked in the future
  (1s skew tolerance), so the schedule holds regardless of caller.

## 0.10.0 — Per-scope flow runs

One contact, several of the same thing (accounts, workspaces, orders), one
series each. Fire the trigger with a scope-qualified `dedupeKey` and
`once: false`, and each scope gets its own run; the additions below let those
runs be cancelled independently and branch on their own context.

### Changed

- **`fire_event` steps now inherit the triggering event's properties.** A
  step's `properties` are authored once in the flow definition, so a fired
  event could previously only say "this contact" — it lost whatever scope the
  originating event carried, leaving the receiving flow with nothing to
  resolve variables against. The run's `triggerEvent.properties` are now
  merged in underneath; explicit `step.properties` still win on conflict.

  This applies to **every** flow, not only scoped ones. Downstream flows and
  any host matching on fired-event properties will see additional keys. If a
  host depends on fired events carrying exactly the authored properties,
  review those handlers before upgrading.

### Added

- **`abortFlow(..., { matchTriggerProperties })`.** Restricts an abort to runs
  whose trigger event carried the given properties, so a host whose subject is
  an account but whose contact is a user can end one account's series while
  that person's other accounts keep running:

  ```ts
  await mailer.abortFlow('trial-onboarding', userId, {
    reason: 'upgraded',
    matchTriggerProperties: { accountId },
  })
  ```

  Omitting it keeps the previous behaviour (abort every active run for the
  contact on that flow). Keys must match `^[A-Za-z0-9_]+$` and values must be
  primitives — these go into a Mongo query, and an object value such as
  `{ $ne: null }` would otherwise reach it as an operator and match every
  scoped run. The scope is recorded in the audit log so a scoped abort is
  distinguishable from an abort-all.

- **`triggerPropertyEquals` / `triggerPropertyTruthy` predicates.** Gate a
  condition or branch on a property of the event that started the run rather
  than on contact state:

  ```ts
  { type: 'condition', test: { triggerPropertyTruthy: 'wasReferred' }, ifFalse: 'continue' }
  ```

  Use these when the gate depends on what the run is *about* instead of a
  durable trait of the person. A tag is shared by every concurrent run for
  that contact, so the last writer wins and branching silently changes in runs
  already in flight; a trigger property is fixed per run.

  The flow editor's value inputs for `triggerPropertyEquals` and `fieldEquals`
  now coerce `true`/`false`/`null`/numeric text to typed values — the
  evaluator compares with strict `===`, so a string-only input could never
  match a typed property like `isPremium: true`. The literal string `"true"`
  is still authorable via the raw JSON editor.

## 0.9.0 — Redis queue prefix

### Added

- **`queue.prefix` for the Bull driver.** All mailery Redis keys (queues,
  workers, the repeating tick scheduler) are namespaced under the prefix, so
  multiple mailery instances can share one Redis cluster without seeing each
  other's jobs — typically one prefix per environment
  (`mailery-dev` / `mailery-prod`):

  ```ts
  queue: { driver: 'bull', redis: { url }, prefix: 'mailery-prod' }
  ```

  `Mailer.fromEnv` reads it from `MAILER_QUEUE_PREFIX`. Prefixes containing
  `:` (BullMQ's key separator) are rejected at init. Changing an instance's
  prefix orphans jobs under the old one — drain first, as with a driver swap.

## 0.8.1 — Queue and scheduling correctness

A full review of the queue drivers and runner turned up a set of scheduling and
concurrency defects. All are fixed here; no API changes.

### Fixed

- **Event triggers could be skipped permanently.** The trigger scan
  watermarked on `occurredAt`, so an event committed "in the past" — an
  outbox-drained `fireFromSession` event carrying its host-transaction
  timestamp, or a `fire()` racing an in-flight scan — fell behind the watermark
  and never started its flow. The scan now watermarks on `createdAt` with a
  30-second overlap window, deduped by a unique partial
  `(flowId, triggerDedupeKey)` index on flow runs.
- **Webhook events could be applied more than once.** Concurrent webhook
  workers scanned the same unprocessed batch, double-counting opens, clicks,
  bounces and complaints — inflated bounce rates could trip the circuit
  breaker. Workers now claim each event atomically before applying.
- **Crash recovery could deliver an email twice.** The stranded-send sweep and
  the queue's stalled-job retry can both fire a job for the same send, and the
  status check was read-then-act. `dispatchSend` now claims the send
  atomically; exactly one dispatcher proceeds.
- **A large broadcast froze the tick for its whole duration.** Recipient
  enqueue ran inline in the single-concurrency tick, starving trigger scans and
  sweeps for hours on big segments. Dispatch now runs as a queue job (inline
  under the `noop` driver, which has no workers), heartbeats progress, and a
  new tick-side sweep resumes broadcasts whose dispatcher died — resumption is
  idempotent via per-recipient dedupe keys.
- **Agenda driver: ticks could be silently swallowed.** `Mailer.init` started
  Agenda with a placeholder no-op tick handler; a process that never called
  `startWorkers` (an API-only process in a web/worker split) locked and
  completed real tick jobs doing nothing. Agenda now starts only in
  `startWorkers`, after the real handlers are defined.
- **BullMQ: completed and failed jobs accumulated in Redis forever.** Queues
  now set bounded retention (`removeOnComplete`: 24 h / 1000 jobs,
  `removeOnFail`: 7 days). This also un-poisons jobId-based idempotent re-adds
  that were dropped against stale completed jobs.
- **Delayed wake-ups could collide across branches.** Advance jobIds used
  `(runId, stepIndex)`, but `currentStepIndex` resets to 0 on branch entry, so
  a wait step inside a branch could be deduped against an earlier step's
  completed job and stall until the sweep rescued it. JobIds now include the
  branch path.
- **Agenda driver: a custom `collectionName` broke queue counts and dedupe.**
  Internal reads hardcoded `_mailerJobs` regardless of the configured name,
  so `getWaitingCount` returned 0 (disabling broadcast backpressure) and
  jobId dedupe never matched.
- **Stranded webhook events are now drained by the tick.** If the queue add
  failed at ingest, webhook events sat unprocessed until the next webhook
  happened to arrive. The tick now applies rows older than 5 minutes.
- **`sendOneOff` no longer throws on a concurrent duplicate.** Two calls
  racing on the same `dedupeKey` returned E11000 to one caller; it now returns
  the winner's `sendId`.
- **Tracked link URLs with HTML entities decode correctly.**

### Changed

- **`respectRecipientTimezone` broadcasts: recipients east of the schedule
  timezone now get the next occurrence of the wall-clock slot** (same time
  next day) instead of a mistimed immediate send — delays can only push
  forward, and their local slot has already passed when dispatch starts.
  Per-recipient delays also anchor to `scheduledAt`, so backpressure pauses no
  longer drift later batches.
- **`bullmq` peer range narrowed to `^5.16.0`.** The driver has always called
  `upsertJobScheduler` (added in 5.16); the old `^5.0.0` range admitted
  versions that crashed at init.
- Two Mongo indexes are added automatically at init: `(name, createdAt)` on
  events and the unique partial `(flowId, triggerDedupeKey)` on flow runs.
  The unique index only applies to new runs (legacy docs lack the field), so
  existing deployments upgrade without migration.

## 0.8.0 — Test system, Mail-Tester `requireScore`

### Added

#### Three-tier end-to-end test system
- **Fast matrix** (`test/matrix`) — offline, real in-memory MongoDB, frozen clock. Systematic coverage of variable rendering (contact fields, `{{event.*}}`, step vars, `varsAdapter` root keys, `unsubscribeUrl`, built-in and host helpers), the html/plain-text pair and tracking rewrites, delivery windows (time-of-day slots and grace, weekday gating, contact-timezone resolution and fallback chain, DST edges), and the full flow lifecycle (every step type, abort, mid-flow unsubscribe, suppression, idempotency).
- **Real-clock gating** (`test/longhorizon`) — the same delivery gating with no fake clock, deriving expectations from the day it runs on.
- **Live SendGrid tier** (`test/live`) — provider-adapter axes against the real API, gated on `MAILERY_LIVE_E2E`. Sandbox by default (real auth and payload validation, nothing delivered); the deliver path reads the message back over Gmail IMAP to confirm the multipart/alternative, headers, unicode subject and link handling survive.
- **Scheduled workflow** (`.github/workflows/live-e2e.yml`) — hourly and weekend crons so the real calendar supplies the axes that cannot be compressed, plus a `libfaketime` job for multi-day waits.

#### `mailery/testing` additions
- `buildTemplate(spec)` / `buildFlow(spec)` and the `step` shorthands — every required document field defaulted, so a fixture states only what it asserts on.
- `drain(ctx, opts?)` and `harness.drain()` — run the runner to quiescence instead of hand-sequencing `runTick` / `processOneRunStep` / `dispatchSend`.
- `RecordingProvider` — wraps any provider, records every `SendArgs`; the harness always applies it, so `provider.sent` works whether you run against `NullProvider` or real SendGrid.
- Harness helpers `seedContact`, `seedTemplate`, `seedFlow`, `ctx`, plus `provider: 'null' | 'sendgrid' | MailProvider`, `queue` and `startWorkers` options.

#### Mail-Tester `requireScore`
- `mailTester.requireScore` (default `false`) — when `true`, publishing content that has never been scored is blocked, not just content already known to score below `minScore`. Without it, any edit changed the content key, missed the cache and published freely.
- The `mail_tester_blocked` response carries a `code` distinguishing "scored too low" from "never scored", with the matching next step in `hint`.
- `GET /api/templates/:slug/mail-tester-status` returns `requireScore`; the editor warns when publish is gated on an unscored body.

### Changed
- **`List-Unsubscribe` is sent on marketing mail only.** The unsubscribe token is scoped `marketing`, so advertising one-click unsubscribe on a transactional send misrepresented the header and offered an opt-out that would not stop the mail in question.
- Admin client errors now surface the server's `message` and `hint` instead of the bare status line, so a refused publish explains itself.

## 0.7.0 — Flow abort primitives

### Added
- `mailer.abortFlow(flowSlug, externalId, { reason })` and `mailer.abortAllFlows(externalId, { reason })` — exit active runs immediately, including runs parked in a `wait`, and cancel the flow's queued or retrying sends so an abort means no further mail rather than just no further steps. Both are no-ops when nothing is active, and a dispatch-time guard closes the race where a send was enqueued between the cancellation sweep and dispatch.

### Fixed
- Linter no longer reports a false `missing_plain_text` on script-seeded templates.

## 0.6.0 — Host variables, delivery windows, event-scoped flows

### Added

#### Host variables (`varsAdapter`)
- `defineVars({ schema, resolve })` — declare a zod schema + resolver in `Mailer.init({ varsAdapter })`; resolved keys land at the template-context root (`{{user.name}}`, `{{firstActiveTopic.title}}`). Return type checked against `z.infer<schema>`.
- Resolver runs at dispatch time per send; a throw marks the send `failed` and lets the queue retry — a half-rendered email never goes out.
- `GET /api/vars-schema` — the schema as JSON Schema + built-in context keys.
- Linter rule `unknown_variable` (warning) — `{{paths}}` in subject/preheader/MJML/editorJson checked against the schema; helper args validated, `{{#each}}`-relative paths and open shapes skipped.
- Admin editor: `{{` autocomplete in subject/preheader, Variables sidebar card (click-to-copy), both driven by the schema.
- Reserved keys (`contact`, `vars`, `event`, `unsubscribeUrl`, …) rejected at `Mailer.init`.

#### Real-contact preview + test sends
- `POST /api/templates/:slug/preview` accepts `contactId` — renders as a real contact through the adapter with resolved host vars; preview modal cycles contacts with ←/→.
- `POST /api/templates/:slug/send-test` accepts `contactId` — renders with that contact's data, delivers to the typed address.
- Both accept `eventProperties` to simulate a trigger event.

#### Delivery windows
- `delivery` on flow `send` steps: `weekdaysOnly` (Sat/Sun slot → Monday), `timeOfDay: 'HH:mm'` (next local slot, 1-hour grace for tick jitter), `useContactTimezone` + IANA `timezone` fallback (default UTC). Pure Intl math, no new dependency.
- Runner parks the run (`send_deferred` history action) and re-fires when the window opens; suppression/breaker/subscription still checked at actual send time.
- Flow editor UI for the window fields.

#### Event-scoped flows
- Flow runs snapshot the triggering event (`triggerEvent: { name, properties, occurredAt }`).
- Templates read `{{event.*}}`; `varsAdapter.resolve` receives `info.eventName` / `info.eventProperties` / `info.flowSlug` to scope lookups (account/topic flows for users in many accounts).

### Fixed
- Live lint no longer reports `missing_plain_text` (and friends) for script-seeded / MJML templates: the editor stops sending its placeholder empty Maily doc for non-Maily templates, and the lint endpoint falls back to the stored `body.html` / `body.plainText` when the draft has no compilable source.
- Save-draft/publish on a non-Maily template no longer risks clobbering the body with an empty Maily doc — the draft carries the MJML source forward instead.

### Docs
- New guide sections: Templates → Host variables, Flows → Event parameters, Flows → Delivery windows; reference updates for the new endpoints and step fields.

## 0.1.0 — Phase 0 spike

**First working release.** End-to-end pipeline from `mailer.fire()` to a delivered email is functional.

### Added

#### Public API
- `Mailer` class with `init()` / `fromEnv()` / `startWorkers()` / `stop()`.
- `mailer.fire()` + `mailer.fireFromSession()` (outbox-based for Mongo transactions).
- `mailer.registerEvent()` + auto-derived `dedupeKey` from policy (`once-per-contact`, `once-per-day`, `every-time`).
- `mailer.upsertSubscription()`, `mailer.unsubscribe()`, `mailer.tag()` / `untag()`, `mailer.suppress()`.
- `mailer.forget()` (GDPR right-to-erasure with hashed-suppression retention).
- `mailer.exportContactData()` (GDPR data export).
- `mailer.sendOneOff()` for ad-hoc transactional sends.
- `mailer.audit()` helper for direct-DB scripts.

#### Adapters / providers
- `MongoContactAdapter` (reads + optional narrow tag writes).
- `MemoryContactAdapter` (test-only, in-process).
- `SendGridProvider` with webhook signature verification + event normalization.
- `NullProvider` for tests.

#### Templates
- `compileTemplate()` (MJML → HTML), `derivePlaintext()`, `renderTemplate()` (Handlebars).
- `applyTracking()` rewrites `<a href>` to `/m/click/:sendId/:linkId` + appends open pixel.
- Handlebars helpers: `eq`/`ne`/`gt`/`lt`/`and`/`or`/`not`, `formatDate`, `formatNumber`, `formatCurrency`, `pluralize`.

#### Runner
- Flow state machine with all `FlowStep` types (`wait`, `condition`, `branch`, `send`, `tag`, `fire_event`, `webhook`, `exit`).
- Trigger scan (event-only V1), recovery sweep, outbox drain.
- Predicate evaluator covering `hasTag`, `fieldEquals`, `hasFiredEvent`, `subscriptionStatus`, `hasOpened` / `hasClicked` (with bot-filtered variants), `all`/`any`/`not`.
- Send pipeline: idempotent (dedupeKey-gated) Send row creation → BullMQ enqueue → `dispatchSend` re-checks suppression + circuit breaker + applies tracking + calls provider.
- Optimistic-concurrency on `currentStepIndex` — two workers racing the same flow_run advance only one wins.
- Webhook event applier with hard-bounce / complaint / unsubscribe cascades into suppressions + subscription status.

#### HTTP routers
- `createPublicRouter(mailer)`: open pixel, click redirect, RFC 8058 one-click unsub (GET + POST, disk fallback for compliance even when Mongo is degraded), provider webhook ingest (signature-verified + deduped).
- `createAdminRouter(mailer)`: serves the prebuilt React SPA + REST endpoints (`/api/dashboard`, `/api/flows`, `/api/templates`, `/api/broadcasts`, `/api/contacts`, `/api/sends`, `/api/suppressions`, `/api/audit`, `/api/health`, `/api/me`).
- HMAC-signed unsubscribe tokens with 90-day default lifetime.

#### Client
- React 18 admin SPA, Vite-built, served as static assets from `dist/admin/spa/`. ~232 KB JS / 63 KB gzipped.
- 14 screens: dashboard, flows list/detail, templates list/editor, broadcasts list/composer, contacts list/detail, sends list/detail, suppressions, audit log, health.
- `src/client/lib/api.ts` + `useLive` hook ready for live-data wiring.

#### Storage
- TypeScript interfaces + `getCollections()` factory + `ensureIndexes()` across all 16 mailer-owned collections.
- Zod schemas for every public-API input.

#### Queue
- BullMQ + ioredis wiring for `mailer-tick`, `mailer-advance`, `mailer-send`, `mailer-webhook` queues.
- Per-provider rate limiter on the send worker (BullMQ group limiter).
- `redis: null` opt-out for queueless / test mode.

#### Tests
- 36 tests across 5 unit + 5 integration suites.
- `mailery/testing` exports `createTestMailer` (mongodb-memory-server-backed), `NullProvider`, `MemoryContactAdapter`.

### Known gaps (Phase 1+ roadmap)

- Circuit-breaker counters / auto-trip (manual override works).
- Soft → hard bounce promotion job.
- Broadcast streaming dispatch.
- Daily webhook reconciliation.
- Domain auth verification UI.
- Double opt-in flow.
- Maily WYSIWYG editor in the template editor.
- SPA screens still consume mock data; REST endpoints exist and `api.ts` is ready.

### Internals

- Build pipeline: tsup (ESM + CJS + .d.ts) + Vite (React SPA) → single `dist/` shipped in the npm tarball.
- Trusted-publishing release workflow on GitHub Actions (OIDC, no NPM_TOKEN).

## 0.0.1

Initial trusted-publish smoke release. Layout-only.

## 0.0.0

Hand-published smoke release.
