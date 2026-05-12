# Changelog

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
