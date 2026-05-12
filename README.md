# mailery

> Embedded, MongoDB-backed email automation for Node.js. Triggered flows, broadcasts, tracking, suppression, compliance, and a React admin UI you mount inside your Express app.

[![npm](https://img.shields.io/npm/v/mailery.svg)](https://www.npmjs.com/package/mailery)

**Status:** v0.1.x — Phase 0 spike. Core engine working end-to-end (flow runner, send pipeline, tracking, unsubscribe, admin UI). Single-host production deployments next. Spec in [`plans/`](./plans).

## Install

```bash
yarn add mailery
# or
npm install mailery
```

Peer-dependencies (host-provided): `express ^4 || ^5`. Runtime deps brought in by mailery: `mongodb`, `bullmq`, `ioredis`, `mjml`, `handlebars`, `@sendgrid/mail`, `zod`.

## Quickstart

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
  redis: { url: process.env.REDIS_URL! },
  providers: {
    sendgrid: new SendGridProvider({
      apiKey: process.env.SENDGRID_API_KEY!,
      webhookVerificationKey: process.env.SENDGRID_WEBHOOK_KEY!,
    }),
  },
  defaultProvider: 'sendgrid',
  publicUrl: 'https://yourdomain.com',
  unsubscribeSecret: process.env.MAILER_UNSUB_SECRET!,
  senderAddress: '12 Main Street, Brooklyn NY 11201, USA',
  fromDefaults: { name: 'Jeff', email: 'jeff@yourdomain.com' },
})

mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })

const app = express()
app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))   // SPA + REST
app.use('/m', createPublicRouter(mailer))                            // tracking + unsub + webhooks

// Then from your business logic:
await mailer.upsertSubscription({ externalId: user._id.toString(), source: 'signup' })
await mailer.fire('Created', user._id.toString())
```

Run a separate worker process for queue jobs:

```ts
const mailer = await Mailer.init({ /* same config */ })
await mailer.startWorkers()  // BullMQ consumers
```

See [`examples/express-mongo/`](./examples/express-mongo) for a complete working example.

## What it is

A self-hosted library you `npm install` into your Express + MongoDB app. Fire events from your code, define flows + templates as documents in MongoDB, mount the admin UI on a route gated by your existing auth.

- **Embedded, not external.** No third-party sync, no per-contact pricing.
- **Both transactional and marketing in one engine.** Right defaults per kind (suppression scope, sender identity, circuit-breaker behavior).
- **Provider-agnostic.** SendGrid + NullProvider ship; Postmark / SES / Resend pluggable.
- **BullMQ + Redis** for queue + delayed-job scheduling.
- **MJML** templates with click + open tracking, plain-text auto-derivation, scope-aware suppression at send time.
- **React admin SPA** (Vite-bundled, served as static assets — no build step in your app).

## Status & roadmap

V0.1 ships:
- Mailer class with `fire`, `upsertSubscription`, `unsubscribe`, `tag`, `suppress`, `forget`, `sendOneOff`, `audit`.
- Flow runner state machine (`wait`, `condition`, `branch`, `send`, `tag`, `fire_event`, `webhook`, `exit`).
- SendGrid provider with webhook signature verification, NullProvider for tests.
- MongoContactAdapter with read methods + optional narrow tag writes.
- Tracking endpoints (open pixel, click redirect), HMAC-signed unsubscribe tokens with disk fallback.
- React admin SPA + REST API surface (`14-admin-api.md`).
- Test harness (`mailery/testing`): MemoryContactAdapter, NullProvider, createTestMailer().

Phase 1+ (in roadmap, not yet shipped):
- Daily webhook reconciliation, soft→hard bounce promotion, circuit-breaker auto-tripping.
- Broadcast streaming dispatch + rate-limit shaping.
- Double opt-in flow, lead promotion.
- Maily WYSIWYG editor in the template editor.
- Domain auth verification.

See [`plans/13-roadmap.md`](./plans/13-roadmap.md).

## Docs

- [`plans/`](./plans) — full design spec (start with [`plans/README.md`](./plans/README.md))
- [`plans/INVARIANTS.md`](./plans/INVARIANTS.md) — non-negotiable rules every PR checks against
- [`plans/DIRECT_DB.md`](./plans/DIRECT_DB.md) — configuring flows/templates via direct MongoDB writes
- [`plans/14-admin-api.md`](./plans/14-admin-api.md) — REST surface the admin SPA consumes

## License

[MIT](./LICENSE) © Jeff Jassky
