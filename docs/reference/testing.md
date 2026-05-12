# Testing helpers

Available via the `mailery/testing` subpath.

```ts
import { createTestMailer, NullProvider, MemoryContactAdapter } from 'mailery/testing'
```

## createTestMailer(opts?)

```ts
async function createTestMailer(opts?: {
  adapter?: ContactAdapter
  seedContacts?: Contact[]
  provider?: NullProvider
  config?: Partial<MailerConfig>
}): Promise<TestMailerHarness>
```

Spins up:

- **mongodb-memory-server** — real `mongod` running in a temp directory
- **`MemoryContactAdapter`** seeded with `seedContacts` (unless you pass `adapter`)
- **`NullProvider`** (unless you pass `provider`)
- **`Mailer` in queueless mode** (`redis: null`) — BullMQ calls become no-ops

```ts
const { mailer, db, provider, adapter, memoryAdapter, stop } = await createTestMailer({
  seedContacts: [
    { externalId: 'u1', email: 'alice@example.com', tags: ['vip'], fields: { firstName: 'Alice' } },
  ],
})
```

### Returned harness

| Property | Notes |
|---|---|
| `mailer` | A real `Mailer` instance. Call any public method. |
| `db` | The `mongodb.Db` for the in-memory server. Insert templates / flows directly to set up scenarios. |
| `provider` | The `NullProvider`. Inspect `.sent` to assert on dispatched sends. |
| `adapter` | The `ContactAdapter` in use. |
| `memoryAdapter` | Same as `adapter` if the default `MemoryContactAdapter` was used; `null` otherwise. |
| `stop` | Async teardown. Closes Mongo, BullMQ queues, mailer. Call in `afterAll`. |

### Driving the runner

The harness's queues are no-ops, so jobs queued by `mailer.fire()` etc. never get processed by a worker. Drive the runner manually:

```ts
import { runTick, processOneRunStep, dispatchSend } from 'mailery'

const ctx = mailer.getRunnerContext()

await mailer.fire('Created', 'u1')
await runTick(ctx)                                    // creates flow_run
await processOneRunStep(runId, ctx)                   // advances one step
await dispatchSend(sendId, ctx)                       // sends through NullProvider
```

## MemoryContactAdapter

In-process `ContactAdapter` for tests.

```ts
import { MemoryContactAdapter } from 'mailery/testing'

const adapter = new MemoryContactAdapter([
  { externalId: 'u1', email: 'a@x.com', tags: ['vip'], fields: {} },
])

adapter.upsert({ externalId: 'u2', email: 'b@x.com', tags: [], fields: {} })
adapter.delete('u1')
```

### Methods

| Method | Notes |
|---|---|
| `upsert(contact)` | Add or replace |
| `delete(externalId)` | Remove |
| `getById(externalId)` | Returns the contact or null |
| `getByEmail(email)` | Returns the first match |
| `getBatch(externalIds)` | Returns a Map |
| `query(filter, { limit, cursor })` | Filtered + paginated |
| `count(filter)` | Number of matches |
| `addTags(externalId, tags)` | Mutates the contact's tags |
| `removeTags(externalId, tags)` | Same |

## NullProvider

In-memory `MailProvider`. Re-exported from `mailery/testing` for convenience.

```ts
import { NullProvider } from 'mailery/testing'

const provider = new NullProvider()
// provider.sent === SendArgs[]
// provider.reset() to clear between tests
```

See [Providers reference](/reference/providers#nullprovider) for details.

## Example

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestMailer, type TestMailerHarness } from 'mailery/testing'
import { compileTemplate, runTick, processOneRunStep, dispatchSend } from 'mailery'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [{ externalId: 'u1', email: 'a@x.com', tags: [], fields: { firstName: 'Ana' } }],
  })

  const compiled = await compileTemplate(`<mjml><mj-body><mj-text>Hi {{contact.fields.firstName}}</mj-text></mj-body></mjml>`)
  await H.db.collection('mailer_templates').insertOne({
    slug: 'hi', name: 'Hi', kind: 'marketing',
    fromName: 'T', fromEmail: 't@x.com',
    subject: 'Hi {{contact.fields.firstName}}', preheader: '',
    body: { mjml: '', html: compiled.html, plainText: compiled.plainText, compiledAt: new Date() },
    // ...other required fields
  })

  await H.db.collection('mailer_flows').insertOne({
    slug: 'hi-flow', name: 'Hi', trigger: { type: 'event', eventName: 'Created', once: true },
    enabled: true, steps: [{ type: 'send', templateSlug: 'hi' }], version: 1,
    // ...
  })
}, 60_000)

afterAll(async () => { await H.stop() })

it('sends Hi on Created', async () => {
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

## Vitest config

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,    // mongodb-memory-server cold start
  },
})
```

mongodb-memory-server downloads the `mongod` binary on first run (~100MB). Cache the download directory in CI to avoid redownloads.
