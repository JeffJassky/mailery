/**
 * Test helpers — `import { ... } from 'mailery/testing'`.
 *
 *   const H = await createTestMailer({
 *     seedContacts: [{ externalId: 'u1', email: 'alice@example.com', tags: [], fields: {} }],
 *   })
 *   await H.seedContact({ externalId: 'u1', ... })          // adapter + subscription
 *   await H.seedTemplate({ slug: 'welcome', subject: 'Hi {{contact.fields.firstName}}' })
 *   await H.seedFlow({ slug: 'onboarding', eventName: 'Created', steps: [step.send('welcome')] })
 *
 *   H.mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
 *   await H.mailer.fire('Created', 'u1')
 *   await H.drain()                                          // run to quiescence
 *
 *   expect(H.provider.sent).toHaveLength(1)
 *   await H.stop()
 *
 * Backed by mongodb-memory-server + the `noop` queue driver, so nothing runs in
 * the background and every transition is something the test asked for. The
 * provider is always wrapped in a `RecordingProvider`, which is what allows the
 * same suite to run against `NullProvider` offline or against real SendGrid
 * (`provider: 'sendgrid'`) without changing a single assertion.
 */

import { MongoClient, type Db } from 'mongodb'

import type { ContactAdapter, Contact, MailProvider } from '../shared/types.js'
import type { QueueDriverConfig } from '../server/queues/types.js'
import type { TemplateDoc, FlowDoc } from '../server/models/index.js'
import type { RunnerContext } from '../server/runner/index.js'
import { NullProvider } from '../server/providers/null.js'
import { Mailer } from '../server/mailer.js'
import { MemoryContactAdapter } from './memory-adapter.js'
import { RecordingProvider } from './recording-provider.js'
import {
  buildTemplate,
  buildFlow,
  step,
  wrapMjml,
  type TemplateSpec,
  type FlowSpec,
} from './builders.js'
import { drain, dispatchQueued, type DrainOptions, type DrainResult } from './drive.js'

export { NullProvider, MemoryContactAdapter, RecordingProvider }
export { buildTemplate, buildFlow, step, wrapMjml }
export { drain, dispatchQueued }
export type { TemplateSpec, FlowSpec, DrainOptions, DrainResult }
export type { SendRecord } from './recording-provider.js'

/**
 * Which provider the harness sends through.
 *  - `'null'`      — in-memory, offline, the default.
 *  - `'sendgrid'`  — the real API. Needs `SENDGRID_API_KEY`. Sandbox mode
 *                    unless `MAILERY_LIVE_E2E=deliver`, so the default costs
 *                    nothing and delivers nothing while still proving that
 *                    SendGrid accepts the payload.
 *  - a `MailProvider` instance — anything else you want to record around.
 */
export type ProviderSpec = 'null' | 'sendgrid' | MailProvider

export interface TestMailerOptions {
  adapter?: ContactAdapter
  seedContacts?: Contact[]
  provider?: ProviderSpec
  /**
   * Queue driver. Defaults to `noop`, which is what makes the fast matrix
   * deterministic — nothing runs until a test calls `drain()`. The live tier
   * passes a real `bull` config to exercise job delays, retries and the send
   * rate limiter, and must then also set `startWorkers`.
   */
  queue?: QueueDriverConfig
  /** Call `mailer.startWorkers()` after init. Requires a non-noop `queue`. */
  startWorkers?: boolean
  /** Override Mailer config (excluding required fields the harness fills in). */
  config?: Partial<Omit<Parameters<typeof Mailer.init>[0], 'db' | 'adapter' | 'queue' | 'providers' | 'defaultProvider'>>
}

export interface SeedContactOptions {
  /** Also create a `subscribed` subscription row. Default true. */
  subscribe?: boolean
  source?: string
}

export interface TestMailerHarness {
  mailer: Mailer
  db: Db
  /** Recording wrapper around the configured provider. */
  provider: RecordingProvider
  adapter: ContactAdapter
  memoryAdapter: MemoryContactAdapter | null
  /** The runner context, for passing to `runTick` / `processOneRunStep` / `drain`. */
  ctx: RunnerContext
  /** Insert a contact into the adapter and (by default) subscribe it. */
  seedContact: (contact: Contact, opts?: SeedContactOptions) => Promise<Contact>
  /** Build + insert a published template. Returns the doc, `_id` included. */
  seedTemplate: (spec: TemplateSpec) => Promise<TemplateDoc>
  /** Build + insert a published flow. Returns the doc, `_id` included. */
  seedFlow: (spec: FlowSpec) => Promise<FlowDoc>
  /** Run the runner to quiescence. See `drive.ts`. */
  drain: (opts?: DrainOptions) => Promise<DrainResult>
  stop: () => Promise<void>
}

export async function createTestMailer(opts: TestMailerOptions = {}): Promise<TestMailerHarness> {
  // Lazy-load test-only deps so production bundles don't pay for them.
  const { MongoMemoryServer } = await import('mongodb-memory-server')

  const mongo = await MongoMemoryServer.create()
  const client = new MongoClient(mongo.getUri())
  await client.connect()
  const db = client.db('mailery-test')

  const memoryAdapter = opts.adapter ? null : new MemoryContactAdapter(opts.seedContacts ?? [])
  const adapter = opts.adapter ?? memoryAdapter!
  const provider = new RecordingProvider(await resolveProvider(opts.provider ?? 'null'))

  // No background worker in tests. The runner's queue.add calls become no-ops;
  // tests call drain() / runTick / processOneRunStep / dispatchSend directly.
  const mailer = await Mailer.init({
    db,
    adapter,
    queue: opts.queue ?? { driver: 'noop' },
    providers: { [provider.name]: provider },
    defaultProvider: provider.name,
    publicUrl: 'http://localhost:3000',
    unsubscribeSecret: 'test-unsub-secret-32-bytes-or-more-please',
    senderAddress: '1 Test St, Brooklyn NY 11201',
    fromDefaults: { name: 'Test', email: 'test@example.com' },
    workerless: true,
    ...(opts.config ?? {}),
  })

  if (opts.startWorkers) await mailer.startWorkers()

  const ctx = mailer.getRunnerContext()

  const harness: TestMailerHarness = {
    mailer,
    db,
    provider,
    adapter,
    memoryAdapter,
    ctx,

    async seedContact(contact, seedOpts = {}) {
      if (!memoryAdapter) {
        throw new Error('seedContact requires the built-in MemoryContactAdapter — you passed a custom `adapter`.')
      }
      memoryAdapter.upsert(contact)
      if (seedOpts.subscribe !== false) {
        await mailer.upsertSubscription({
          externalId: contact.externalId,
          source: seedOpts.source ?? 'test',
        })
      }
      return contact
    },

    async seedTemplate(spec) {
      const doc = await buildTemplate(spec)
      const res = await ctx.collections.templates.insertOne(doc)
      doc._id = res.insertedId
      return doc
    },

    async seedFlow(spec) {
      const doc = buildFlow(spec)
      const res = await ctx.collections.flows.insertOne(doc)
      doc._id = res.insertedId
      return doc
    },

    drain(drainOpts) {
      return drain(ctx, drainOpts)
    },

    stop: async () => {
      await mailer.stop().catch(() => {})
      await client.close().catch(() => {})
      await mongo.stop().catch(() => {})
    },
  }

  return harness
}

async function resolveProvider(spec: ProviderSpec): Promise<MailProvider> {
  if (typeof spec !== 'string') return spec
  if (spec === 'null') return new NullProvider()

  const apiKey = process.env.SENDGRID_API_KEY
  if (!apiKey) {
    throw new Error(
      "createTestMailer({ provider: 'sendgrid' }) requires SENDGRID_API_KEY. " +
        'Live tests should gate on it before constructing the harness.',
    )
  }
  const { SendGridProvider } = await import('../server/providers/sendgrid.js')
  return new SendGridProvider({
    apiKey,
    // Sandbox unless explicitly told to deliver: SendGrid still authenticates
    // and validates the payload, it just never puts anything in an inbox.
    sandbox: process.env.MAILERY_LIVE_E2E !== 'deliver',
  })
}
