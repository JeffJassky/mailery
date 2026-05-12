# `mailer` — Embedded Email Automation for Node.js + MongoDB

A self-hosted, embeddable email automation library. Drop it into any Express + MongoDB app, give it a provider API key, and you get triggered flows, broadcasts, segmentation, tracking, suppression, compliance, and a built-in admin UI — without standing up a separate service or syncing your user database to a third-party SaaS.

This document is the **design spec**. It precedes any implementation. The package will live at `packages/mailer/` (single-repo while incubating; extracted to its own repo once stable).

---

## What this is — and what it isn't

**Is**: a library you `npm install` into your Express app. Fire events from your code, define flows + templates as JSON/MJML in MongoDB, mount an admin UI for monitoring. Handles deliverability table stakes (suppression, bounce processing, unsubscribe, tracking, DMARC-aligned sending via a transactional provider).

**Isn't**: a hosted SaaS, a drag-and-drop campaign builder, a forms/landing-page tool, a replacement for your CRM. No visual flow builder — flows are JSON. The admin UI is for monitoring and small operations; structural changes happen by editing documents in Mongo (via code, a script, or — if you want — the UI's JSON editors).

---

## Table of contents

| # | Doc | Purpose |
|---|---|---|
| — | [`README.md`](./README.md) | This file. Entry, overview, index. |
| 00 | [`vision.md`](./00-vision.md) | Goals, non-goals, positioning. |
| 01 | [`architecture.md`](./01-architecture.md) | System diagram, components, request lifecycles. |
| 02 | [`data-model.md`](./02-data-model.md) | **Every Mongo collection, every field, every index.** The contract. |
| 03 | [`runner.md`](./03-runner.md) | Flow runner state machine. The engine. |
| 04 | [`queues.md`](./04-queues.md) | BullMQ wiring: tick + delayed-job model. |
| 05 | [`providers.md`](./05-providers.md) | Send-provider abstraction. SendGrid first, others pluggable. |
| 06 | [`templates.md`](./06-templates.md) | MJML + Handlebars templating, rendering pipeline, WYSIWYG plan. |
| 07 | [`tracking.md`](./07-tracking.md) | Open pixel, click rewriting, inbound webhook normalization. |
| 08 | [`compliance.md`](./08-compliance.md) | Unsubscribe, suppression, GDPR, double opt-in, deliverability setup. |
| 09 | [`admin-ui.md`](./09-admin-ui.md) | Server-rendered + htmx admin interface. |
| 10 | [`public-api.md`](./10-public-api.md) | The API consumer apps call (`mailer.fire`, `mailer.upsertSubscription`, etc.). |
| 11 | [`configuration.md`](./11-configuration.md) | Initialization options, env vars, mounting. |
| 12 | [`testing.md`](./12-testing.md) | Test strategy, fixtures, CI. |
| 13 | [`roadmap.md`](./13-roadmap.md) | Phased build plan. |
| 14 | [`admin-api.md`](./14-admin-api.md) | REST surface the React admin SPA consumes. |
| ★ | [`INVARIANTS.md`](./INVARIANTS.md) | **Non-negotiable rules.** Every PR checks against these. |
| ★ | [`DIRECT_DB.md`](./DIRECT_DB.md) | Advanced: configuring flows/templates via direct MongoDB writes. |

---

## Reading order

- **Approving the design:** 00 → 01 → 02 → 13. The rest is implementation detail.
- **Implementing:** 01 → 02 → 03 → then the subsystem you're working on.
- **Power-using via raw DB:** [`DIRECT_DB.md`](./DIRECT_DB.md). Self-contained reference.

---

## At a glance

```
┌────────────────────────────────────────────────────────────────────┐
│                       Your Express App                              │
│                                                                     │
│  ┌──────────────────┐         ┌──────────────────────────┐        │
│  │ Your business    │ fire()  │  mailer                  │        │
│  │ logic            ├────────►│   - runner (BullMQ)      │        │
│  │ (signup, import, │         │   - providers            │        │
│  │  cancel, etc.)   │         │   - tracking endpoints   │        │
│  └──────────────────┘         │   - admin UI router      │        │
│                               │   - public-api           │        │
│                               └──────────┬───────────────┘        │
│                                          │                         │
│                                          ▼                         │
│                              ┌────────────────────────┐            │
│                              │  MongoDB (host's DB or │            │
│                              │  a dedicated one)      │            │
│                              │                        │            │
│                              │  mailer_subscriptions  │            │
│                              │  mailer_events         │            │
│                              │  mailer_flows          │            │
│                              │  mailer_flow_runs      │            │
│                              │  mailer_templates      │            │
│                              │  mailer_sends          │            │
│                              │  mailer_suppressions   │            │
│                              │  mailer_broadcasts     │            │
│                              └────────────────────────┘            │
│                                          │                         │
│                                          ▼                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  BullMQ (Redis) — delayed jobs + tick recovery sweep      │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                          │                         │
│                                          ▼                         │
│                              ┌────────────────────────┐            │
│                              │  SendGrid / Postmark / │            │
│                              │  SES / Resend / ...    │            │
│                              └────────────────────────┘            │
└────────────────────────────────────────────────────────────────────┘
```

## Quickstart preview

What integration will look like once shipped:

```ts
// server/main.js
const express = require('express')
const { Mailer, MongoContactAdapter, SendGridProvider } = require('@your-org/mailer')

const app = express()

const mailer = await Mailer.init({
  db: mongoose.connection.db,
  adapter: new MongoContactAdapter({ db, collection: 'users', emailField: 'email', idField: '_id' }),
  redis: { url: process.env.REDIS_URL },
  providers: {
    sendgrid: new SendGridProvider({ apiKey: process.env.SENDGRID_API_KEY }),
  },
  defaultProvider: 'sendgrid',
  publicUrl: 'https://storyfolder.com',
  unsubscribeSecret: process.env.MAILER_UNSUB_SECRET,
  senderAddress: '12 Main Street, Brooklyn NY 11201, USA',
  fromDefaults: { name: 'Jeff Jassky', email: 'jeff@jeffjassky.com' },
})

// Mount the admin UI (gate with your existing auth middleware)
app.use('/admin/mailer', requireAdmin, mailer.adminRouter())

// Mount tracking + compliance endpoints (must be reachable by email clients + provider webhooks)
app.use('/m', mailer.publicRouter())

// In your app code:
await mailer.upsertSubscription({ externalId: user._id.toString(), source: 'signup' })
await mailer.fire('Downloaded app', user._id.toString())
```

That's the integration. Flows and templates live in MongoDB; the runner picks up events on the next tick (or sooner, via delayed-job wakeups).

---

## Status

**Design spec only.** No code has been written. The spec is the deliverable for review before implementation begins.

See [`roadmap.md`](./13-roadmap.md) for the build plan.
