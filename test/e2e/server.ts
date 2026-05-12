/**
 * E2E test harness server. Boots a real Express app + Mailer backed by
 * mongodb-memory-server + NullProvider + the queueless mailer-init mode.
 *
 * Playwright's webServer config starts this with tsx. Tests interact via the
 * admin UI on the configured port, and use the `/__test__/*` inspector
 * endpoints to seed state + assert on `provider.sent`.
 */

import express, { type Request, type Response } from 'express'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Mailer,
  NullProvider,
  createAdminRouter,
  createPublicRouter,
  runTick,
  processOneRunStep,
  dispatchSend,
} from '../../src/server/index.js'
import { MemoryContactAdapter } from '../../src/testing/memory-adapter.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SPA_DIR = path.resolve(__dirname, '../../dist/admin/spa')

const PORT = Number(process.env.MAILERY_E2E_PORT ?? 5174)

async function main() {
  console.log('e2e: starting mongo-memory-server (may take a moment on first run)…')
  const mongo = await MongoMemoryServer.create()
  const client = new MongoClient(mongo.getUri())
  await client.connect()
  const db = client.db('mailery-e2e')

  const adapter = new MemoryContactAdapter(seedContacts())
  const provider = new NullProvider()

  const mailer = await Mailer.init({
    db,
    adapter,
    queue: { driver: 'noop' }, // queueless — tests drive the runner directly via /__test__/tick
    providers: { null: provider },
    defaultProvider: 'null',
    publicUrl: `http://localhost:${PORT}`,
    unsubscribeSecret: 'e2e-test-secret-thirty-two-chars-please-ok',
    senderAddress: '12 Main St, Brooklyn NY 11201, USA',
    fromDefaults: { name: 'E2E', email: 'e2e@example.com' },
    workerless: true,
  })

  mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
  mailer.registerEvent({ name: 'Activated', dedupePolicy: 'once-per-contact' })

  const app = express()
  app.use(express.json())

  // Mount mailer's own routers. Point at the freshly-built SPA so the asset
  // URLs in index.html resolve against our running server.
  app.use('/admin/mailer', createAdminRouter(mailer, { spaDir: SPA_DIR }))
  app.use('/m', createPublicRouter(mailer))

  // ----- Test inspector endpoints -----------------------------------------
  app.post('/__test__/reset', async (_req: Request, res: Response) => {
    await db.dropDatabase()
    provider.sent.length = 0
    for (const c of seedContacts()) adapter.upsert(c)
    res.json({ ok: true })
  })

  app.get('/__test__/state', async (_req: Request, res: Response) => {
    const [flows, templates, sends, suppressions, broadcasts, subscriptions] = await Promise.all([
      mailer.collections.flows.countDocuments({}),
      mailer.collections.templates.countDocuments({}),
      mailer.collections.sends.countDocuments({}),
      mailer.collections.suppressions.countDocuments({}),
      mailer.collections.broadcasts.countDocuments({}),
      mailer.collections.subscriptions.countDocuments({}),
    ])
    res.json({
      sent: provider.sent,
      counts: { flows, templates, sends, suppressions, broadcasts, subscriptions },
    })
  })

  app.post('/__test__/contacts', async (req: Request, res: Response) => {
    const { externalId, email, tags, fields } = req.body ?? {}
    adapter.upsert({
      externalId: String(externalId),
      email: String(email).toLowerCase(),
      tags: Array.isArray(tags) ? tags : [],
      fields: fields ?? {},
    })
    res.json({ ok: true })
  })

  app.post('/__test__/fire', async (req: Request, res: Response) => {
    const { eventName, externalId, properties } = req.body ?? {}
    await mailer.upsertSubscription({ externalId, source: 'e2e' })
    await mailer.fire(eventName, externalId, properties ?? {})
    res.json({ ok: true })
  })

  app.post('/__test__/tick', async (_req: Request, res: Response) => {
    await runTick(mailer.getRunnerContext())
    const runs = await mailer.collections.flowRuns
      .find({ status: 'active', nextActionAt: { $lte: new Date() } })
      .limit(50)
      .toArray()
    for (const run of runs) {
      await processOneRunStep(run._id!, mailer.getRunnerContext())
    }
    const sends = await mailer.collections.sends
      .find({ status: 'queued' })
      .limit(50)
      .toArray()
    for (const s of sends) {
      await dispatchSend(s._id!, mailer.getRunnerContext())
    }
    res.json({ ok: true })
  })

  app.get('/__test__/db/:collection', async (req: Request, res: Response) => {
    const name = String(req.params.collection)
    const colMap: Record<string, any> = {
      flows: mailer.collections.flows,
      templates: mailer.collections.templates,
      sends: mailer.collections.sends,
      suppressions: mailer.collections.suppressions,
      broadcasts: mailer.collections.broadcasts,
      subscriptions: mailer.collections.subscriptions,
      flowRuns: mailer.collections.flowRuns,
      events: mailer.collections.events,
      auditLog: mailer.collections.auditLog,
    }
    const col = colMap[name]
    if (!col) return res.status(404).json({ error: 'unknown_collection' })
    const docs = await col.find({}).limit(100).toArray()
    return res.json(docs)
  })

  app.get('/__test__/ready', (_req, res) => res.json({ ok: true }))

  const server = app.listen(PORT, () => {
    console.log(`e2e: mailery harness listening on http://localhost:${PORT}`)
  })

  const stop = async () => {
    server.close()
    await mailer.stop().catch(() => {})
    await client.close().catch(() => {})
    await mongo.stop().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

function seedContacts() {
  return [
    { externalId: 'alice', email: 'alice@example.com', tags: ['vip', 'engaged'], fields: { firstName: 'Alice', tier: 'Pro' } },
    { externalId: 'bob', email: 'bob@example.com', tags: [], fields: { firstName: 'Bob', tier: 'Free' } },
    { externalId: 'charlie', email: 'charlie@example.com', tags: ['beta'], fields: { firstName: 'Charlie', tier: 'Free' } },
  ]
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
