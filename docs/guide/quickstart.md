# Quickstart

This walks through wiring mailery into an existing Express + MongoDB app and sending your first email. Assumes you have:

- Node 20+
- A running MongoDB (any version 4.4+; we test against 7.x)
- A running Redis instance (any version 6+)
- A SendGrid API key — or skip this and use the bundled `NullProvider` for local testing

## 1. Install

```bash
yarn add mailery
# or
npm install mailery
```

Peer dependency: `express ^4 || ^5`. mailery brings in `mongodb`, `bullmq`, `ioredis`, `mjml`, `handlebars`, `@sendgrid/mail`, and `zod`.

## 2. Initialize

In your server entry point:

```ts
import express from 'express'
import { MongoClient } from 'mongodb'
import {
  Mailer,
  MongoContactAdapter,
  SendGridProvider,
  createAdminRouter,
  createPublicRouter,
} from 'mailery'

const mongo = await MongoClient.connect(process.env.MONGODB_URI!)
const db = mongo.db()

const mailer = await Mailer.init({
  db,
  adapter: new MongoContactAdapter({
    db,
    collection: 'users',     // YOUR existing collection
    emailField: 'email',
    idField: '_id',
    tagsField: 'tags',
    tagsWritable: true,
  }),
  redis: { url: process.env.REDIS_URL! },
  providers: {
    sendgrid: new SendGridProvider({
      apiKey: process.env.SENDGRID_API_KEY!,
      webhookVerificationKey: process.env.SENDGRID_WEBHOOK_KEY,
    }),
  },
  defaultProvider: 'sendgrid',
  publicUrl: 'https://yourdomain.com',           // base URL for /m/* endpoints
  unsubscribeSecret: process.env.MAILER_UNSUB_SECRET!,
  senderAddress: '12 Main Street, Brooklyn NY 11201, USA',
  fromDefaults: { name: 'Jeff', email: 'jeff@yourdomain.com' },
})
```

## 3. Mount the routers

```ts
const app = express()

// Admin UI + REST. Gate with your existing auth middleware.
app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))

// Tracking endpoints (open pixel, click redirect, unsubscribe, provider webhooks).
// MUST be reachable by email clients and your provider — don't gate this.
app.use('/m', createPublicRouter(mailer))
```

Visit `https://yourdomain.com/admin/mailer` and you'll see the React admin UI.

## 4. Register events

Tell mailery what events your app fires:

```ts
mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
mailer.registerEvent({ name: 'Hit Free Limit', dedupePolicy: 'once-per-day' })
mailer.registerEvent({ name: 'Cancelled', dedupePolicy: 'every-time' })
```

The dedupe policy controls how mailery deduplicates repeated `fire()` calls for the same contact + event. See [Events](./events).

## 5. Subscribe contacts and fire events

When a user signs up:

```ts
const user = await db.collection('users').insertOne({ email, name, tags: [] })
const externalId = String(user.insertedId)

// Record consent.
await mailer.upsertSubscription({ externalId, source: 'signup' })

// Fire an event — any flow triggered by 'Created' will pick this up on the next tick.
await mailer.fire('Created', externalId)
```

## 6. Run a worker process

The web process you just set up handles HTTP. A **second** process needs to run BullMQ workers — this is what actually advances flow state and dispatches sends:

```ts
// worker.ts (run alongside server.ts)
const mailer = await Mailer.init({ /* same config as web */ })
await mailer.startWorkers()
```

You can also run a single combined process during development (don't set `workerless: true`).

## 7. Author a flow + template

Two ways:

1. **Admin UI** — visit `/admin/mailer/templates`, create a template, then go to `/admin/mailer/flows` and create a flow that sends it on the `Created` event.
2. **Directly in MongoDB** — insert documents into `mailer_templates` and `mailer_flows`. See [Direct DB](https://github.com/JeffJassky/mailery/blob/main/plans/DIRECT_DB.md) for full cookbooks.

## 8. Test locally

Skip the SendGrid step and use the bundled `NullProvider` to see what would be sent without actually delivering anything:

```ts
import { NullProvider } from 'mailery'

const provider = new NullProvider()
// ...
const mailer = await Mailer.init({ providers: { null: provider }, defaultProvider: 'null', /* ... */ })

// In tests:
expect(provider.sent[0]?.subject).toContain('Welcome')
```

For a complete working example, see [`examples/express-mongo`](https://github.com/JeffJassky/mailery/tree/main/examples/express-mongo) in the repo.
