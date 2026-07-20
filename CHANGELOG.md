# Changelog

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
