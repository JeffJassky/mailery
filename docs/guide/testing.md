# Testing

mailery ships a test harness at `mailery/testing` that spins up an in-memory MongoDB + a `NullProvider` + a `MemoryContactAdapter`, so your host-app tests can assert on what mailery would have done without hitting real infrastructure.

## Setup

```ts
import { createTestMailer, step } from 'mailery/testing'

const H = await createTestMailer()

await H.seedContact({ externalId: 'u1', email: 'alice@example.com', tags: [], fields: { firstName: 'Alice' } })
await H.seedTemplate({ slug: 'welcome', subject: 'Hi {{contact.fields.firstName}}' })
await H.seedFlow({ slug: 'onboarding', eventName: 'Created', steps: [step.send('welcome')] })

H.mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
await H.mailer.fire('Created', 'u1')
await H.drain()

expect(H.provider.sent[0]?.subject).toBe('Hi Alice')

await H.stop()
```

## What the harness provides

| | |
|---|---|
| `mailer` | A real `Mailer` instance — call all the normal methods (`fire`, `upsertSubscription`, etc.). |
| `db` | Live `mongodb.Db` backed by `mongodb-memory-server`. Insert documents directly if the builders don't cover your case. |
| `ctx` | The runner context, for `runTick` / `processOneRunStep` / `dispatchSend`. |
| `provider` | A `RecordingProvider`. Inspect `.sent` (`SendArgs[]`) to assert on dispatched sends, or `.records` for results and errors. Call `.reset()` between tests. |
| `adapter` | `MemoryContactAdapter` (unless you passed your own). Has helper methods `.upsert(contact)` and `.delete(externalId)`. |
| `memoryAdapter` | Same reference as `adapter` if mailery created it for you; `null` if you provided your own. |
| `seedContact(c, opts?)` | Insert a contact and (by default) subscribe it. |
| `seedTemplate(spec)` | Build + insert a published template. Only name what you're asserting on. |
| `seedFlow(spec)` | Build + insert a published flow. |
| `drain(opts?)` | Run the runner to quiescence — see below. |
| `stop()` | Tears down Mongo and queue state. Call in `afterAll`. |

### Builders

`seedTemplate` / `seedFlow` fill every required field of the underlying documents, so a fixture states only what matters:

```ts
await H.seedTemplate({
  slug: 'welcome',
  subject: 'Hi {{contact.fields.firstName}}',
  text: 'Welcome aboard, {{contact.fields.firstName}}.',  // wrapped in minimal MJML
  trackOpens: true,
})
```

Pass `mjml` or `html` instead of `text` for full control over the markup, and `plainText` to override the auto-derived text part.

The `step` shorthands keep flow definitions readable:

```ts
import { step } from 'mailery/testing'

steps: [
  step.send('welcome'),
  step.wait(2, 'days'),
  step.sendAt('nudge', { weekdaysOnly: true, timeOfDay: '09:00', useContactTimezone: true }),
  step.tag(['onboarded']),
  step.exit('done'),
]
```

## Driving the runner

The harness runs in **queueless mode** (`queue: { driver: 'noop' }`). All four queues are no-ops, so nothing advances until a test says so.

Most of the time you want `drain()`, which alternates the trigger scan, the due-run sweep and send dispatch until the system is quiescent — the state a real deployment settles into between ticks:

```ts
await H.mailer.fire('Created', 'u1')
await H.drain()
expect(H.provider.sent).toHaveLength(1)
```

"Quiescent" means no active run whose `nextActionAt` has passed and no queued send left. Runs parked in a `wait`, or held by a delivery window, are *expected* to remain — move the clock forward and drain again.

`drain({ dispatch: false })` stops before dispatch, so you can inspect `queued` send rows before they go out. The return value is `{ rounds, dispatched, errors, settled }`; `settled: false` means it hit the round cap without converging.

For tight control over a single transition, call the runner directly:

```ts
import { runTick, processOneRunStep, dispatchSend } from 'mailery'

await runTick(H.ctx)

const run = await H.mailer.collections.flowRuns.findOne({ externalId: 'u1' })
await processOneRunStep(run!._id!, H.ctx)

const send = await H.mailer.collections.sends.findOne({ flowRunId: run!._id })
await dispatchSend(send!._id!, H.ctx)
```

## Testing time-dependent behaviour

`wait` steps and delivery windows read the clock, so freeze it. Fake **only `Date`** — faking timers stalls the MongoDB driver's heartbeats and the suite hangs:

```ts
import { vi } from 'vitest'

vi.useFakeTimers({ toFake: ['Date'] })       // AFTER createTestMailer()
vi.setSystemTime(new Date('2026-03-07T10:00:00Z'))   // a Saturday

await H.mailer.fire('Created', 'u1')
await H.drain()

// weekdaysOnly held the send for the weekend
const run = await H.mailer.collections.flowRuns.findOne({ externalId: 'u1' })
expect(run!.nextActionAt.toISOString()).toBe('2026-03-09T10:00:00.000Z') // Monday

vi.setSystemTime(new Date('2026-03-09T10:00:00Z'))
await H.drain()
expect(H.provider.sent).toHaveLength(1)

vi.useRealTimers()
```

Move time with `setSystemTime`, never `advanceTimersByTime` — there are no faked timers to advance.

## Example: full end-to-end test

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestMailer, step, type TestMailerHarness } from 'mailery/testing'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer()

  await H.seedContact({ externalId: 'u1', email: 'a@example.com', tags: [], fields: { firstName: 'Ana' } })
  await H.seedTemplate({ slug: 'welcome', subject: 'Hi {{contact.fields.firstName}}' })
  await H.seedFlow({ slug: 'welcome', eventName: 'Created', steps: [step.send('welcome')] })

  H.mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
}, 60_000)

afterAll(async () => { await H.stop() })

it('fires welcome on Created', async () => {
  await H.mailer.fire('Created', 'u1')
  await H.drain()

  expect(H.provider.sent[0]?.subject).toBe('Hi Ana')
})
```

## Custom providers in tests

Whatever you pass is wrapped in a `RecordingProvider`, so `provider.sent` works the same either way:

```ts
import { NullProvider } from 'mailery/testing'

class CapturingProvider extends NullProvider {
  async send(args) {
    const result = await super.send(args)
    console.log('sent', args.subject)
    return result
  }
}

const H = await createTestMailer({ provider: new CapturingProvider() })
```

To run the same tests against real SendGrid, pass `provider: 'sendgrid'`. It reads `SENDGRID_API_KEY` and uses SendGrid's **sandbox mode** — real API call, real auth and payload validation, nothing delivered — unless `MAILERY_LIVE_E2E=deliver`. Gate such tests on the key being present so they skip cleanly for everyone else.

## Custom adapters in tests

```ts
import { MemoryContactAdapter } from 'mailery/testing'

const adapter = new MemoryContactAdapter([
  { externalId: 'u1', email: 'alice@x.com', tags: ['vip'], fields: {} },
])

// Add more during the test:
adapter.upsert({ externalId: 'u2', email: 'bob@x.com', tags: [], fields: {} })

const { mailer } = await createTestMailer({ adapter })
```

## Vitest configuration

mailery's own tests use Vitest. A reasonable host-app `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,   // mongodb-memory-server can be slow on cold start
    hookTimeout: 60_000,
  },
})
```

mongodb-memory-server downloads a Mongo binary on first run (~100MB, cached). Plan for slow CI start unless you cache the binary directory between runs.
