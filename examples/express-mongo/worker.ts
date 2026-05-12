/**
 * Mailer worker process. Run this alongside server.ts in production — it
 * handles BullMQ jobs (flow runner advancements, send dispatches, webhook
 * processing). The web process should set `workerless: true` and skip
 * `startWorkers()`.
 *
 *   node --experimental-strip-types worker.ts
 */

import { MongoClient } from 'mongodb'

import {
  Mailer,
  MongoContactAdapter,
  SendGridProvider,
  NullProvider,
} from 'mailery'

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mailery-example'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

async function main() {
  const mongo = await MongoClient.connect(MONGODB_URI)
  const db = mongo.db()

  const provider = process.env.SENDGRID_API_KEY
    ? new SendGridProvider({
        apiKey: process.env.SENDGRID_API_KEY,
        webhookVerificationKey: process.env.SENDGRID_WEBHOOK_KEY,
      })
    : new NullProvider()

  const adapter = new MongoContactAdapter({
    db,
    collection: 'users',
    tagsField: 'tags',
    tagsWritable: true,
  })

  const mailer = await Mailer.init({
    db,
    adapter,
    queue: { driver: 'bull', redis: { url: REDIS_URL } },
    providers: { [provider.name]: provider },
    defaultProvider: provider.name,
    publicUrl: process.env.MAILER_PUBLIC_URL ?? 'http://localhost:3000',
    unsubscribeSecret: process.env.MAILER_UNSUB_SECRET ?? 'change-me-in-production',
    senderAddress: '12 Main Street, Brooklyn NY 11201, USA',
    fromDefaults: { name: 'Jeff at Mailery', email: 'hello@example.com' },
  })

  await mailer.startWorkers()
  console.log('Mailery worker running — Ctrl+C to stop')

  const shutdown = async () => {
    console.log('Shutting down...')
    await mailer.stop()
    await mongo.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
