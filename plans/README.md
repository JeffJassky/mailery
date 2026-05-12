# `mailer` — Embedded Email Automation for Node.js + MongoDB

A self-hosted, embeddable email automation library. Drop it into any Express app, point it at MongoDB, give it a provider API key, and you have triggered flows, broadcasts, segmentation, tracking, suppression, and a built-in admin UI. Designed from the ground up to be **configured by AI agents** as well as humans — every piece of state is a plain MongoDB document, with a well-documented schema serving as the contract.

This document is the **full design spec**. It precedes any implementation. The package will live at `packages/mailer/` (single-repo while incubating; extracted to its own repo once stable).

---

## Table of contents

| # | Doc | Purpose |
|---|---|---|
| — | [`README.md`](./README.md) | This file. Entry, overview, index. |
| 00 | [`vision.md`](./00-vision.md) | Goals, non-goals, market positioning, what we will and won't build. |
| 01 | [`architecture.md`](./01-architecture.md) | High-level system diagram, component responsibilities, request lifecycles. |
| 02 | [`data-model.md`](./02-data-model.md) | **Every Mongo collection, every field, every index.** The contract. |
| 03 | [`runner.md`](./03-runner.md) | Flow runner state machine. The engine. |
| 04 | [`queues.md`](./04-queues.md) | Queue abstraction. Agenda + BullMQ adapters. |
| 05 | [`providers.md`](./05-providers.md) | Send-provider abstraction. SendGrid first, others pluggable. |
| 06 | [`templates.md`](./06-templates.md) | MJML + Handlebars templating, rendering pipeline. |
| 07 | [`tracking.md`](./07-tracking.md) | Open pixel, click rewriting, inbound webhook normalization. |
| 08 | [`compliance.md`](./08-compliance.md) | Unsubscribe, suppression, GDPR, double opt-in. |
| 09 | [`admin-ui.md`](./09-admin-ui.md) | Server-rendered + htmx admin interface. |
| 10 | [`public-api.md`](./10-public-api.md) | The API consumer apps call (`mailer.fire`, `mailer.upsertContact`, etc.). |
| 11 | [`configuration.md`](./11-configuration.md) | Initialization options, env vars, mounting. |
| 12 | [`testing.md`](./12-testing.md) | Test strategy, fixtures, CI. |
| 13 | [`roadmap.md`](./13-roadmap.md) | Four-week build plan + post-MVP roadmap. |
| ★ | [`INVARIANTS.md`](./INVARIANTS.md) | **Non-negotiable rules.** Every implementation, every PR, every agent action checks against these. |
| ★ | [`AGENT_GUIDE.md`](./AGENT_GUIDE.md) | **LLM-facing schema reference + common operations.** Read this if you're an AI agent. |

---

## Reading order

- **If you're approving the design:** read in order 00 → 01 → 02 → 13. The rest is implementation detail.
- **If you're implementing:** read 01 → 02 → 03 → then the subsystem you're working on.
- **If you're an AI agent configuring flows:** read **only** [`AGENT_GUIDE.md`](./AGENT_GUIDE.md). It is self-contained.

---

## At a glance

```
┌────────────────────────────────────────────────────────────────────┐
│                       Your Express App                              │
│                                                                     │
│  ┌──────────────────┐         ┌──────────────────────────┐        │
│  │ Your business    │ fire()  │  mailer                  │        │
│  │ logic            ├────────►│   - runner (queue jobs)  │        │
│  │ (signup, import, │         │   - providers            │        │
│  │  cancel, etc.)   │         │   - tracking endpoints   │        │
│  └──────────────────┘         │   - admin UI router      │        │
│                               │   - public-api           │        │
│                               └──────────┬───────────────┘        │
│                                          │                         │
│                                          ▼                         │
│                              ┌────────────────────────┐            │
│                              │  MongoDB (shared with  │            │
│                              │  your app's DB or own) │            │
│                              │                        │            │
│                              │  mailer_contacts       │            │
│                              │  mailer_events         │            │
│                              │  mailer_flows  ◄───────┼─── agent   │
│                              │  mailer_flow_runs      │   reads &  │
│                              │  mailer_templates ◄────┼─── writes  │
│                              │  mailer_sends          │   directly │
│                              │  mailer_suppressions   │            │
│                              │  mailer_broadcasts     │            │
│                              └────────────────────────┘            │
│                                          │                         │
│                                          ▼                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Queue (Agenda or BullMQ) — runner tick every minute      │    │
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
const { Mailer, AgendaQueue, SendGridProvider } = require('@your-org/mailer')

const app = express()

const mailer = await Mailer.init({
  db: mongoose.connection,
  queue: new AgendaQueue({ mongo: process.env.MONGODB_URI }),
  providers: {
    sendgrid: new SendGridProvider({ apiKey: process.env.SENDGRID_API_KEY }),
  },
  defaultProvider: 'sendgrid',
  publicUrl: 'https://storyfolder.com',
  unsubscribeSecret: process.env.MAILER_UNSUB_SECRET,
  fromDefaults: {
    name: 'Jeff Jassky',
    email: 'jeff@jeffjassky.com',
  },
})

// Mount the admin UI
app.use('/admin/mailer', requireAdmin, mailer.adminRouter())

// Mount tracking + compliance endpoints
app.use('/m', mailer.publicRouter())   // /m/open/:id.png, /m/click/:id/:link, /m/unsub/:token, /m/webhooks/:provider

// In your app code:
await mailer.upsertContact({ email, externalId: user._id, fields: { firstName, jobTitle } })
await mailer.fire('Downloaded app', user._id)
```

That's the whole integration. Everything else happens via the database and the admin UI.

---

## Status

This is a **design spec only**. No code has been written. The spec is the deliverable for review before implementation begins.

See [`roadmap.md`](./13-roadmap.md) for the build plan.
