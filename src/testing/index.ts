/**
 * Test helpers — `import { ... } from 'mailery/testing'`.
 *
 *   const harness = await createTestMailer({ seedContacts: [...] })
 *   await harness.mailer.upsertSubscription({ externalId: 'u1', source: 'test' })
 *   await harness.mailer.fire('Created', 'u1')
 *   // drive the runner directly:
 *   const { runTick, processOneRunStep, dispatchSend } = await import('mailery')
 *   await runTick(harness.mailer.getRunnerContext())
 *   expect(harness.provider.sent.length).toBe(1)
 *   await harness.stop()
 *
 * Backed by mongodb-memory-server + ioredis-mock + NullProvider.
 */

import { MongoClient, type Db } from 'mongodb'

import type { ContactAdapter, Contact } from '../shared/types.js'
import { NullProvider } from '../server/providers/null.js'
import { Mailer } from '../server/mailer.js'
import { MemoryContactAdapter } from './memory-adapter.js'

export { NullProvider, MemoryContactAdapter }

export interface TestMailerOptions {
  adapter?: ContactAdapter
  seedContacts?: Contact[]
  provider?: NullProvider
  /** Override Mailer config (excluding required fields the harness fills in). */
  config?: Partial<Omit<Parameters<typeof Mailer.init>[0], 'db' | 'adapter' | 'queue' | 'providers' | 'defaultProvider'>>
}

export interface TestMailerHarness {
  mailer: Mailer
  db: Db
  provider: NullProvider
  adapter: ContactAdapter
  memoryAdapter: MemoryContactAdapter | null
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
  const provider = opts.provider ?? new NullProvider()

  // No background worker in tests. The runner's queue.add calls become no-ops;
  // tests call runTick / processOneRunStep / dispatchSend directly.
  const mailer = await Mailer.init({
    db,
    adapter,
    queue: { driver: 'noop' },
    providers: { null: provider },
    defaultProvider: 'null',
    publicUrl: 'http://localhost:3000',
    unsubscribeSecret: 'test-unsub-secret-32-bytes-or-more-please',
    senderAddress: '1 Test St, Brooklyn NY 11201',
    fromDefaults: { name: 'Test', email: 'test@example.com' },
    workerless: true,
    ...(opts.config ?? {}),
  })

  const stop = async () => {
    await mailer.stop().catch(() => {})
    await client.close().catch(() => {})
    await mongo.stop().catch(() => {})
  }

  return { mailer, db, provider, adapter, memoryAdapter, stop }
}
