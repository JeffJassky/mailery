# 01 — Architecture

## System diagram

```
                    Your Express App (the host)
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   ┌────────────────────┐                                                │
│   │ host's users coll. │  ◄── read via ContactAdapter ──────┐          │
│   │ (identity, fields, │                                     │          │
│   │  optionally tags)  │                                     │          │
│   └────────────────────┘                                     │          │
│                                                              │          │
│   Your business logic                                        │          │
│   ┌────────────────────┐                                     │          │
│   │ user.addTag()      │  ─── mailer.fire('Imported', user._id) ──┐    │
│   │ webhook handlers   │                                            │    │
│   │ signup flows       │                                            │    │
│                                                                      ▼   │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │                          mailer                                  │  │
│   │                                                                  │  │
│   │  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐    │  │
│   │  │  public-api  │   │   runner     │   │     admin        │    │  │
│   │  │              │   │              │   │                  │    │  │
│   │  │  fire()      │   │  tick job    │   │  Express router  │    │  │
│   │  │  upsertCt()  │   │  state mach. │   │  (htmx UI)       │    │  │
│   │  │  ingest evt  │   │  send dispatch│  │                  │    │  │
│   │  └──────┬───────┘   └──────┬───────┘   └──────────────────┘    │  │
│   │         │                  │                                    │  │
│   │         ▼                  ▼                                    │  │
│   │  ┌───────────────────────────────────────────────────────────┐ │  │
│   │  │       MongoDB (native driver — Db, not Mongoose)          │ │  │
│   │  │                                                           │ │  │
│   │  │   subscriptions  events    flows         flow_runs       │ │  │
│   │  │   templates      sends     suppressions  broadcasts      │ │  │
│   │  │   leads          outbox    audit_log     webhook_events  │ │  │
│   │  │   health         tags (defs only; values via adapter)    │ │  │
│   │  └───────────────────────────────────────────────────────────┘ │  │
│   │                                                                  │  │
│   │  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐    │  │
│   │  │  BullMQ      │   │  Providers   │   │  Tracking        │    │  │
│   │  │  (requires   │   │  - SendGrid  │   │  - open pixel    │    │  │
│   │  │   Redis)     │   │  - Postmark† │   │  - click rewriter│    │  │
│   │  └──────────────┘   │  - SES†      │   │  - webhook ingest│    │  │
│   │                     │  - Resend†   │   └──────────────────┘    │  │
│   │                     │  († stubs)   │                            │  │
│   │                     └──────────────┘                            │  │
│   └──────────────────────────────────────────────────────────────────┘  │
│                                  │                                       │
│              ┌───────────────────┴───────────────────┐                  │
│              ▼                                       ▼                  │
│       HTTP(S) outbound                       HTTPS inbound              │
│       to email provider                      from email provider        │
│       (transactional API)                    (webhook callbacks)        │
└──────────────────────────────────────────────────────────────────────────┘
```

## Component responsibilities

### `public-api`

The surface your app code calls into. Three methods do 95% of integrations:

```ts
await mailer.fire(eventName: string, contactRef: ContactRef, props?: object)
await mailer.upsertContact({ email, externalId, fields, tags })
await mailer.unsubscribe(email, listOrGlobal)
```

Plus a few admin-style methods exposed for completeness (`addSuppression`, `sendBroadcast`, etc.) — these are the same operations the admin UI calls. See [`10-public-api.md`](./10-public-api.md).

### `runner`

A single Agenda/BullMQ job (`mailer:tick`) runs every minute and is the heart of the system. On each tick it:

1. Finds new event firings that should trigger flows (and aren't already in those flows for the relevant contacts)
2. Creates `flow_runs` for those contacts
3. Advances any active `flow_runs` whose `nextActionAt` has passed
4. Evaluates the current step type:
   - `wait` → set `nextActionAt = now + duration`, advance step pointer
   - `condition` → evaluate predicate, branch (advance step pointer) or exit
   - `send` → render template, check suppression, dispatch through provider, log to `sends`, advance step pointer
   - `branch` → evaluate condition, follow chosen sub-path
   - `tag` → mutate contact tags
   - `webhook` → POST to URL (rare, but useful for cross-system triggers)
5. Marks runs `completed` when steps are exhausted

The runner is **idempotent**. Each step advance is gated on `currentStepIndex`. If a tick crashes mid-step, the next tick re-evaluates that step — and the send step itself has a deduplication key based on `flow_run_id × step_index` so the same send never happens twice.

Full details in [`03-runner.md`](./03-runner.md).

### `queues`

Thin abstraction over Agenda or BullMQ. The runner doesn't know which is in use. Three methods:

```ts
interface Queue {
  schedule(name: string, runAt: Date, data: object): Promise<string>
  cancel(jobId: string): Promise<void>
  every(name: string, cron: string, handler: (data) => Promise<void>): void
  on(name: string, handler: (data) => Promise<void>): void
}
```

See [`04-queues.md`](./04-queues.md).

### `providers`

Pluggable abstraction for the actual SMTP+API delivery. Each provider implements:

```ts
interface MailProvider {
  name: string
  send(args: SendArgs): Promise<SendResult>
  verifyWebhook(req: Request): boolean
  parseWebhookEvents(payload: unknown): NormalizedEvent[]
}
```

V1 ships with SendGrid. Stubs for Postmark / SES / Resend will be designed but not implemented until needed.

See [`05-providers.md`](./05-providers.md).

### `tracking`

Three mechanisms work together to track engagement:

1. **Open pixel**: 1×1 PNG served from `/m/open/<sendId>.png`, written into the email body at render time. When fetched, marks the send as opened.
2. **Click rewriter**: At render time, every `<a href="X">` becomes `<a href="https://yourdomain.com/m/click/<sendId>/<linkId>">` which 302-redirects to `X` after logging.
3. **Webhook ingestion**: SendGrid (and other providers) POST events to `/m/webhooks/<provider>`. The provider's `parseWebhookEvents` normalizes them and we update `sends` accordingly.

Tracking is **optional per template** (transactional templates can disable it to reduce link cruft).

See [`07-tracking.md`](./07-tracking.md).

### `compliance`

Handles the legally-mandated and deliverability-protecting bits:

- One-click unsubscribe endpoint at `/m/unsub/<token>` (HMAC-signed; `List-Unsubscribe-Post` header support)
- Preference center at `/m/preferences/<token>` (optional, contact-scoped)
- Suppression list checked before every send
- GDPR right-to-erasure + data export via API
- Double opt-in tracking (consent timestamps on contact records)

See [`08-compliance.md`](./08-compliance.md).

### `admin`

A mountable Express router serving server-rendered HTML pages + htmx for interactivity. No SPA bundle. No build step in consuming apps.

Views:
- Dashboard (active flows, recent sends, recent deliverability stats)
- Flows list + detail (with live run log and metrics per step)
- Templates list + edit (MJML preview + send-test)
- Contacts search + detail
- Sends log (filter by template, contact, status)
- Suppressions list + manual add/remove
- Broadcasts list + scheduling

The admin UI **reads** everything and supports targeted **mutations** (pause/unpause flow, send test email, manually add suppression, promote template draft to published). Bigger structural changes (adding steps to flows, designing new templates) happen via direct database writes from an agent or developer.

See [`09-admin-ui.md`](./09-admin-ui.md).

## Request lifecycles

### Lifecycle 1: An event fires, a flow runs

1. App code calls `await mailer.fire('Downloaded app', contactRef)`
2. `public-api.fire()` writes a document to `events` collection
3. Returns immediately (non-blocking on flow evaluation)
4. Next `mailer:tick` (within 60s) finds the new event
5. Looks up flows triggered by `'Downloaded app'`
6. For each, checks if this contact already has an active flow_run for it
7. If not, creates a flow_run with `currentStepIndex: 0` and `nextActionAt: now`
8. Processes the run's current step

### Lifecycle 2: A wait step delays a send

1. Flow_run reaches a `wait` step (e.g. `{ value: 24, unit: 'hours' }`)
2. Runner sets `nextActionAt: now + 24h`, advances `currentStepIndex`
3. Run sleeps in Mongo (no queue job per run — the tick handles all sleeping runs)
4. 24 hours later, the next tick picks up runs where `nextActionAt <= now`
5. Processes the next step (which is usually a condition or send)

### Lifecycle 3: A send happens

1. Runner reaches a `send` step in some flow_run
2. Loads the referenced template
3. Renders MJML → HTML, substitutes variables from contact fields
4. Auto-derives plain text
5. Rewrites all links for click tracking
6. Appends open pixel
7. Adds `List-Unsubscribe` + `List-Unsubscribe-Post` headers
8. Checks suppression list (skip + log if present)
9. Calls `provider.send(...)` (SendGrid API)
10. Writes a `sends` document with `status: 'queued'`
11. Updates flow_run history + advances step

### Lifecycle 4: Provider webhook arrives

1. SendGrid POSTs delivery/open/click/bounce events to `/m/webhooks/sendgrid`
2. Webhook handler validates the signature via `provider.verifyWebhook()`
3. `provider.parseWebhookEvents()` normalizes to `NormalizedEvent[]`
4. Each event updates the corresponding `sends` document (`deliveredAt`, `openedAt`, `bouncedAt`, etc.)
5. Hard bounces and complaints also add the email to `suppressions`
6. Unsubscribes mark the contact `status: 'unsubscribed'`

### Lifecycle 5: An agent reconfigures a flow

1. Agent reads `flows` collection to see current setup
2. Agent reads `templates` collection to find a template to insert
3. Agent updates `flows.draft.steps`: pushes a new `{ type: 'send', templateSlug: 'new-template' }` step
4. Agent (or a human via admin UI) publishes: `db.collection('flows').updateOne({ _id }, { $set: { steps: draft.steps, publishedAt: new Date() } })`
5. Next runner tick uses the new step list for newly-entering flow_runs
6. **In-flight flow_runs continue on their original `flowVersion`** (see [`03-runner.md`](./03-runner.md) for versioning details)

## Trust boundaries

- The library trusts MongoDB. If your DB is compromised, the library can be made to send anything.
- The library trusts the consuming app. The host gates `/admin/mailer` with its own auth. No identity story shipped.
- The library does NOT trust inbound webhooks. Every provider webhook is signature-verified before processing.
- The library does NOT trust user input. Unsubscribe tokens are HMAC-signed. Open/click URLs encode the send ID + a fresh signature on each link rewrite.

## Performance envelope

V1 targets:

- **Up to 100K contacts per deployment** — well below MongoDB's natural scale ceiling
- **Up to 10K sends per day** — comfortable on Agenda; trivial on BullMQ
- **Sub-minute trigger latency** — events fire flows on the next tick (≤60s)
- **Linear-time tick complexity** in active flow_runs (`nextActionAt` indexed)

Above these, BullMQ + a queue worker fleet + sharded events collection. Out of scope for V1.

## Failure modes

- **Provider outage**: send step fails → `sends.status = 'failed'`, retry with exponential backoff up to N times, then alert via configured webhook
- **Runner crashes mid-tick**: next tick re-evaluates same flow_runs; idempotency via deduplication keys
- **MongoDB unavailable**: library fails open; events buffer in app-level queue if configured, else are dropped (logged)
- **Webhook signature invalid**: log, drop, alert; do not update sends
- **Render error (bad MJML/Handlebars)**: send marked `failed`, flow_run continues to next step (does not block subsequent steps)
- **Contact unsubscribed mid-flow**: skip remaining send steps in any active flow_runs; flow_run marked `exited` with reason `unsubscribed`
