/**
 * Minimal Express + MongoDB host using mailery.
 *
 * To run:
 *   1. From the repo root: `yarn build` (compiles the lib + SPA into dist/)
 *   2. cd examples/express-mongo && yarn install
 *   3. MONGODB_URI=mongodb://localhost:27017/mailery-example \
 *      REDIS_URL=redis://localhost:6379 \
 *      SENDGRID_API_KEY=... \
 *      node --experimental-strip-types server.ts
 *
 * Then:
 *   curl -X POST http://localhost:3000/users -d '{"email":"alice@example.com","name":"Alice"}' -H 'Content-Type: application/json'
 *   open http://localhost:3000/admin/mailer
 */

import express from 'express'
import { MongoClient, ObjectId } from 'mongodb'

import {
  Mailer,
  MongoContactAdapter,
  SendGridProvider,
  NullProvider,
  createAdminRouter,
  createPublicRouter,
} from 'mailery'

const PORT = Number(process.env.PORT ?? 3000)
const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mailery-example'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

async function main() {
  const mongo = await MongoClient.connect(MONGODB_URI)
  const db = mongo.db()

  // Pick a provider. Use SendGrid in prod, NullProvider for local dev.
  const provider = process.env.SENDGRID_API_KEY
    ? new SendGridProvider({
        apiKey: process.env.SENDGRID_API_KEY,
        webhookVerificationKey: process.env.SENDGRID_WEBHOOK_KEY,
        sandbox: process.env.NODE_ENV !== 'production',
      })
    : new NullProvider()

  const adapter = new MongoContactAdapter({
    db,
    collection: 'users',
    emailField: 'email',
    idField: '_id',
    tagsField: 'tags',
    tagsWritable: true,
  })

  const mailer = await Mailer.init({
    db,
    adapter,
    queue: { driver: 'bull', redis: { url: REDIS_URL } },
    providers: { [provider.name]: provider },
    defaultProvider: provider.name,
    publicUrl: `http://localhost:${PORT}`,
    unsubscribeSecret: process.env.MAILER_UNSUB_SECRET ?? 'change-me-in-production',
    senderAddress: '12 Main Street, Brooklyn NY 11201, USA',
    fromDefaults: { name: 'Jeff at Mailery', email: 'hello@example.com' },
    // The web process runs the routers; a separate `worker.ts` calls
    // `mailer.startWorkers()` in production.
    workerless: true,
  })

  // Register the events the host will fire.
  mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
  mailer.registerEvent({ name: 'Downloaded app', dedupePolicy: 'once-per-contact' })
  mailer.registerEvent({ name: 'Viewed Storyboard', dedupePolicy: 'once-per-day' })

  // ---------------------------------------------------------------------------
  // Express wiring
  // ---------------------------------------------------------------------------
  const app = express()
  app.use(express.json())

  // Demo auth — replace with your own.
  const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    ;(req as any).user = { email: req.header('x-user-email') ?? 'demo@example.com', isAdmin: true }
    next()
  }

  // Admin UI + REST (gate with your auth).
  app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))

  // Tracking + unsubscribe + webhook endpoints (reachable by recipients + provider).
  app.use('/m', createPublicRouter(mailer))

  // ---------------------------------------------------------------------------
  // Sample host routes
  // ---------------------------------------------------------------------------
  app.get('/', (_req, res) => res.json({ ok: true, mailer: { provider: provider.name } }))

  app.post('/users', async (req, res) => {
    const { email, name } = req.body ?? {}
    if (!email) return res.status(400).json({ error: 'email_required' })

    const result = await db.collection('users').insertOne({
      email: String(email).toLowerCase(),
      name: String(name ?? ''),
      tags: [],
      createdAt: new Date(),
    })
    const externalId = String(result.insertedId)

    await mailer.upsertSubscription({ externalId, source: 'signup' })
    await mailer.fire('Created', externalId)

    return res.json({ externalId })
  })

  app.post('/users/:externalId/event', async (req, res) => {
    const { name, properties } = req.body ?? {}
    if (!name) return res.status(400).json({ error: 'event_name_required' })
    if (!ObjectId.isValid(req.params.externalId)) return res.status(400).json({ error: 'bad_id' })
    await mailer.fire(name, req.params.externalId, properties ?? {})
    return res.json({ ok: true })
  })

  app.listen(PORT, () => {
    console.log(`Mailery example listening on http://localhost:${PORT}`)
    console.log(`  Admin:    http://localhost:${PORT}/admin/mailer`)
    console.log(`  Tracking: http://localhost:${PORT}/m/...`)
    console.log(`  Provider: ${provider.name}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
