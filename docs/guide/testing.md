# Testing

mailery ships a test harness at `mailery/testing` that spins up an in-memory MongoDB + a `NullProvider` + a `MemoryContactAdapter`, so your host-app tests can assert on what mailery would have done without hitting real infrastructure.

## Setup

```ts
import { createTestMailer } from 'mailery/testing'

const { mailer, db, provider, adapter, stop } = await createTestMailer({
  seedContacts: [
    { externalId: 'u1', email: 'alice@example.com', tags: [], fields: { firstName: 'Alice' } },
  ],
})

// ...run your test
expect(provider.sent[0]?.to).toBe('alice@example.com')

await stop()
```

## What the harness provides

| | |
|---|---|
| `mailer` | A real `Mailer` instance — call all the normal methods (`fire`, `upsertSubscription`, etc.). |
| `db` | Live `mongodb.Db` backed by `mongodb-memory-server`. Insert templates / flows directly to set up scenarios. |
| `provider` | `NullProvider`. Inspect `.sent` to assert on dispatched sends. Call `.reset()` between tests. |
| `adapter` | `MemoryContactAdapter` (unless you passed your own). Has helper methods `.upsert(contact)` and `.delete(externalId)`. |
| `memoryAdapter` | Same reference as `adapter` if mailery created it for you; `null` if you provided your own. |
| `stop()` | Tears down Mongo and queue state. Call in `afterAll`. |

## Driving the runner

The harness runs in **queueless mode** (`queue: { driver: 'noop' }`). All four queues are no-ops. Tests drive the runner directly:

```ts
import { runTick, processOneRunStep, dispatchSend } from 'mailery'

const ctx = mailer.getRunnerContext()

// Process newly-fired events → create flow_runs
await runTick(ctx)

// Advance one specific run
const run = await mailer.collections.flowRuns.findOne({ externalId: 'u1' })
await processOneRunStep(run!._id!, ctx)

// Dispatch a specific send
const send = await mailer.collections.sends.findOne({ flowRunId: run!._id })
await dispatchSend(send!._id!, ctx)
```

This gives you tight control over what advances when — useful for asserting state at specific points in a flow.

## Example: full end-to-end test

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestMailer, type TestMailerHarness } from 'mailery/testing'
import { compileTemplate, runTick, processOneRunStep, dispatchSend } from 'mailery'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [{ externalId: 'u1', email: 'a@example.com', tags: [], fields: { firstName: 'Ana' } }],
  })

  const compiled = await compileTemplate(`<mjml><mj-body><mj-text>Hi {{contact.fields.firstName}}</mj-text></mj-body></mjml>`)
  await H.db.collection('mailer_templates').insertOne({
    slug: 'welcome',
    name: 'Welcome',
    kind: 'marketing',
    fromName: 'Test',
    fromEmail: 't@example.com',
    subject: 'Hi {{contact.fields.firstName}}',
    body: { mjml: '', html: compiled.html, plainText: compiled.plainText, compiledAt: new Date() },
    // ...other required fields
  })

  await H.db.collection('mailer_flows').insertOne({
    slug: 'welcome',
    trigger: { type: 'event', eventName: 'Created', once: true },
    enabled: true,
    steps: [{ type: 'send', templateSlug: 'welcome' }],
    version: 1,
    // ...
  })
}, 60_000)

afterAll(async () => { await H.stop() })

it('fires welcome on Created', async () => {
  const { mailer, provider } = H
  const ctx = mailer.getRunnerContext()

  await mailer.upsertSubscription({ externalId: 'u1', source: 'test' })
  mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
  await mailer.fire('Created', 'u1')

  await runTick(ctx)
  const run = await mailer.collections.flowRuns.findOne({ externalId: 'u1' })
  await processOneRunStep(run!._id!, ctx)

  const send = await mailer.collections.sends.findOne({ flowRunId: run!._id })
  await dispatchSend(send!._id!, ctx)

  expect(provider.sent[0]?.subject).toBe('Hi Ana')
})
```

## Custom providers in tests

```ts
import { NullProvider } from 'mailery/testing'

class CapturingProvider extends NullProvider {
  async send(args) {
    const result = await super.send(args)
    console.log('sent', args.subject)
    return result
  }
}

const { mailer } = await createTestMailer({ provider: new CapturingProvider() })
```

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
