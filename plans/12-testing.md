# 12 — Testing

A small library with this much state needs a serious test strategy. Lays out what gets tested at which layer.

## Three layers

### 1. Unit tests

Per-module pure-function tests. No I/O. Run in milliseconds.

Target areas:
- Predicate evaluation (`evalCondition.ts`)
- Step navigation (locate step by `currentBranchPath`)
- Token signing + verification (unsubscribe, DOI)
- Template rendering (MJML → HTML, Handlebars substitution, plain-text derivation)
- Provider webhook normalizers (input fixture per provider → expected `NormalizedEvent[]`)
- HMAC, hashing, dedupeKey generation

Tooling: Vitest. Coverage gate: 85% lines on `src/runner/`, `src/compliance/`, `src/templates/`.

### 2. Integration tests (in-memory infrastructure)

Test the runner end-to-end without real Mongo/Redis/SendGrid.

- **Mongo**: `mongodb-memory-server` (spins up actual mongod in-process — slow first start, fast after)
- **Redis**: `ioredis-mock`
- **Adapter**: a `MemoryContactAdapter` that holds a Map of contacts
- **Provider**: the `NullProvider` from `05-providers.md`

Scenarios:

- Fire an event → flow_run is created → wait step delays → condition evaluates → send executes → NullProvider receives the args
- Trigger flow with `once: true`, fire same event twice → only one flow_run
- Concurrent runner workers → no double-sends, no double-step-advances
- Suppress an email mid-flow → next send is skipped, marked `suppressed`
- Hard bounce webhook → contact suppressed, future sends skip
- Circuit breaker trip → marketing send queued, transactional send proceeds
- DOI flow: subscribe → pending → confirm → subscribed; subscribe without confirm → stays pending
- Outbox flow: fire from session → transaction commits → event drains
- Outbox flow: fire from session → transaction aborts → event never drains

These run in a few seconds total — fast enough to gate on every PR.

### 3. Acceptance / smoke tests (real infrastructure)

Run against a real MongoDB, Redis, and provider sandbox (SendGrid's sandbox mode).

Scenarios:

- Send a real email via SendGrid sandbox → verify webhook fires within N seconds, send status transitions
- Send to an invalid address → bounce webhook fires, suppression added
- Click a tracking link → click recorded, redirect works, click count increments
- Render a template with custom Handlebars helpers → output matches expected
- Sign and verify an unsubscribe token → roundtrip works

Run on a schedule (nightly + on release) rather than per-PR — they hit external services.

## Per-PR test plan

```
1. Unit tests pass.
2. Integration tests pass.
3. Type check (tsc --noEmit).
4. Lint (eslint, prettier).
5. Coverage threshold met.
```

CI fails on any of these.

## Test fixtures

Each provider ships fixture webhook payloads:

```
src/providers/__fixtures__/sendgrid/
  delivered.json
  open.json
  click.json
  bounce-hard.json
  bounce-soft.json
  complaint.json
  unsubscribe.json
```

Used by:
- Unit tests for `parseWebhookEvents()`
- Integration tests for the full webhook → applyEvent pipeline

Adding a new provider requires adding the fixture set.

## Determinism

Tests must be deterministic. No real-clock dependencies — use a fake clock (Vitest's `vi.useFakeTimers()`).

The runner's `tick` runs the same way under fake-clock:

```ts
test('wait step delays send by 24 hours', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-12T00:00:00Z'))

  await mailer.fire('Imported', 'user1', {}, 'k1')

  await runner.tick()  // creates flow_run, immediately runs wait step → advances pointer, sets nextActionAt = +24h

  vi.setSystemTime(new Date('2026-05-13T00:01:00Z'))
  await runner.tick()  // processes wait completion → next step is send

  const sends = await db.collection('mailer_sends').find().toArray()
  expect(sends).toHaveLength(1)
  expect(sends[0].status).toBe('sent')
  expect(provider.sent).toHaveLength(1)
})
```

No `setTimeout` in tests. No real waits.

## Concurrency tests

A specific category: ensure idempotency holds under concurrent workers.

```ts
test('two workers advancing same flow_run only send once', async () => {
  await mailer.fire('Imported', 'user1', {}, 'k1')
  await runner.tick()                              // creates flow_run

  // Two workers race to advance the same step
  const [a, b] = await Promise.all([
    runner.advanceOneRunStep(runId),
    runner.advanceOneRunStep(runId),
  ])

  const sends = await db.collection('mailer_sends').find().toArray()
  expect(sends).toHaveLength(1)                    // dedupeKey enforces this
})
```

## Migration / upgrade tests

The library will evolve. Index changes, schema additions, etc. A migration test pattern:

```
1. Insert documents in the "previous version" shape into a memory Mongo
2. Run the migration script
3. Assert the new shape
4. Run the runner against the migrated data — it works
```

Migrations live in `src/migrations/<version>.ts` with up + down. Migration tests run on every PR.

## Load test (V2)

For V1 the target is "works correctly," not "scales to N." Once we have real production data:

- Generate 100K contacts in memory Mongo
- 10K flow_runs in flight
- 1K sends/minute peak
- Verify tick completes in <30s, send queue doesn't back up beyond M

This isn't a per-PR test — run quarterly or before major releases.

## What we don't test

- Real email deliverability (we trust the provider)
- Spam scoring (out of scope — that's the content author's job, with tooling like Mail-Tester they run manually)
- Cross-client rendering (we rely on MJML's reputation here; no Litmus integration shipped)
- Provider API availability (we trust the provider; circuit breaker handles outages)

## Test-only helpers

```ts
import { createTestMailer } from '@your-org/mailer/testing'

const { mailer, db, redis, provider, adapter } = await createTestMailer({
  // Optional overrides; defaults to in-memory everything
})

// Use throughout your tests, then:
await mailer.stop()
```

Saves boilerplate in host-app tests that touch mailer indirectly.

## Host-side testing patterns

Host apps using mailer often want to assert "this user-action triggered the expected email." Pattern:

```ts
test('importing a video fires the Imported event', async () => {
  const { mailer, provider } = await createTestMailer()
  await mailer.fire('Imported', user._id.toString(), {}, `${user._id}:Imported`)

  expect(await db.collection('mailer_events').findOne({ name: 'Imported' })).toBeTruthy()
})
```

For end-to-end "did the right email send?" assertions:

```ts
test('Imported fires Activation Welcome email', async () => {
  await mailer.fire('Imported', externalId, {}, dedupeKey)
  await runner.tick()
  expect(provider.sent).toContainEqual(expect.objectContaining({
    to: 'user@example.com',
    subject: expect.stringContaining('Welcome'),
  }))
})
```
