# 02 — Data Model

This is **the contract**. Every collection, every field, every index, every conventional value. Read this once to understand the system; refer back when writing migrations or direct-DB scripts.

## Ownership boundary: host vs. mailer

The single most important design decision in this library is **who owns the contact identity**.

The answer is: **the host app does.** The host app already has a `users` collection (or `customers`, or whatever it's called). Mailer never duplicates that data, never tries to sync it, never becomes a second source of truth for "what's this person's email."

Mailer owns:

| Concept | Why mailer owns it |
|---|---|
| **Subscription state** (subscribed / unsubscribed / pending-DOI / bounced) | Compliance — every app would reinvent this badly |
| **Suppression list** | Compliance + deliverability invariant |
| **Behavioral events** (the things flows trigger on) | Append-only history specific to email orchestration |
| **Flows, templates, broadcasts** (configuration) | The product |
| **Flow runs** (state machine) | Mailer's runtime state |
| **Sends** (what went out, what happened) | Audit + deliverability + analytics |
| **Tracking events** (opens, clicks, bounces from webhooks) | Mailer-internal |
| **Leads** (emails captured before they're host users) | Pragmatic — host shouldn't be forced to create user records prematurely |

Host owns:

- Identity: `users._id`, `email`, profile fields
- Business state: subscription tier, account creation date, tags representing in-product state
- Anything else that exists for product reasons rather than email reasons

The host exposes its `users` collection to mailer through a small **`ContactAdapter`** interface. Mailer reads through that adapter — never writes, never duplicates.

This means:
- Email changes in the host app immediately affect the next send (no sync delay)
- Custom fields added to host users are available as merge tags without library updates
- Mailer can ship across multiple apps with different user schemas, never knowing or caring what they look like

---

## The ContactAdapter

Required init option. Tiny interface, host-implemented.

```ts
export interface Contact {
  externalId: string                              // host-app user's _id, as a string
  email: string                                   // current address
  tags: string[]                                  // first-class — host owns or mailer owns; see Tags section below
  fields: Record<string, any>                     // arbitrary; whatever the host wants in templates
  timezone?: string                               // IANA, e.g. 'America/New_York'
  locale?: string                                 // BCP 47, e.g. 'en-US'
}

export interface AdapterFilter {
  // Mailer translates these into the host's query language via the adapter.
  // Tiny intentionally — richer filtering happens via post-filter in mailer.
  emailIn?: string[]
  externalIdIn?: string[]
  fieldEquals?: { field: string, value: any }
  fieldIn?: { field: string, values: any[] }
  fieldExists?: string
  hasTag?: string
  hasTagIn?: string[]                              // OR semantics
  createdAfter?: Date
  createdBefore?: Date
}

export interface ContactAdapter {
  // Reads (required)
  getById(externalId: string): Promise<Contact | null>
  getByEmail(email: string): Promise<Contact | null>
  getBatch(externalIds: string[]): Promise<Map<string, Contact>>
  query(filter: AdapterFilter, opts: { limit: number, cursor?: string }): Promise<{ contacts: Contact[], nextCursor?: string }>
  count(filter: AdapterFilter): Promise<number>

  // Writes — optional, narrow, tag-only
  // If implemented, mailer writes tags through here (host-owned tag storage).
  // If absent, mailer manages tags in its own `mailer_contact_tags` collection.
  addTags?(externalId: string, tags: string[]): Promise<void>
  removeTags?(externalId: string, tags: string[]): Promise<void>
}
```

The adapter is **read-mostly**. The only writes are narrow tag operations — and only if the host implements them. The host never has mailer reaching into user fields beyond `tags`. Email changes, profile updates, account deletions all happen in the host app; the next mailer read picks them up.

## Tags: where they live

Many hosts already store tags on the user model (`user.tags: ['vip', 'beta']`) because they use them for in-app features. Forcing duplication into mailer would recreate the sync problem the adapter pattern solves. So:

**Tags can live on the host model or in mailer's own storage. The adapter decides.**

Two configurations:

1. **Host-owned tags** (recommended when the host already has a `tags` field):
   ```ts
   new MongoContactAdapter({
     db, collection: 'users', emailField: 'email', idField: '_id',
     tagsField: 'tags',
     tagsWritable: true,   // mailer can $addToSet / $pull on user.tags
   })
   ```
   Mailer reads `user.tags` directly. When a flow runs `{ type: 'tag', addTags: ['engaged'] }`, mailer calls `adapter.addTags(externalId, ['engaged'])` — which executes a Mongo `$addToSet` on the user document.

2. **Mailer-owned tags** (when the host doesn't have a tags field, or doesn't want mailer touching the user model):
   ```ts
   new MongoContactAdapter({
     db, collection: 'users', emailField: 'email', idField: '_id',
     // No tagsField, no addTags/removeTags
   })
   ```
   The adapter doesn't implement write methods, and `Contact.tags` is populated by mailer from its own `mailer_contact_tags` collection.

Both work transparently for flows, templates, and segments. The only difference is where the bits sit on disk.

**Always interact with tags via `mailer.tag()` / `mailer.untag()` or the `{type: 'tag'}` flow step.** Never write to `user.tags` directly, even when you can see it — the abstraction is what lets the storage be swappable.

A default `MongoContactAdapter` ships out of the box for Mongo hosts:

```ts
import { MongoContactAdapter } from '@your-org/mailer'

const adapter = new MongoContactAdapter({
  db,                                              // the host's MongoDB Db handle
  collection: 'users',
  emailField: 'email',
  idField: '_id',

  // Optional: where tags live on the host model
  tagsField: 'tags',
  tagsWritable: true,                              // mailer can $addToSet / $pull on user.tags

  // Optional: customize the projection returned to mailer
  toContact: (user) => ({
    externalId: user._id.toString(),
    email: user.email,
    tags: user.tags || [],
    timezone: user.timezone,
    locale: user.locale,
    fields: {
      firstName: user.name,
      lastName: user.lastName,
      jobTitle: user.jobTitle,
      customerType: user.customerType,
      reasonForSigningUp: user.reasonForSigningUp,
    },
  }),
})
```

The `toContact` function is the projection — host decides what fields are exposed to mailer. Anything not in the returned `fields` map is invisible to templates and segments. `tags` is its own top-level field on `Contact`, populated either from `tagsField` on the user doc (if set) or merged from `mailer_contact_tags` (if not).

### Segmentation through the adapter

Segments combine host-side filters (via adapter) with mailer-side filters (events, suppression state, send history). Evaluation is two-pass:

1. **Stage A — host filter**: mailer calls `adapter.query()` with the host-relevant filters (`fieldEquals`, `fieldIn`, etc.). Adapter returns a cursor.
2. **Stage B — mailer post-filter**: mailer streams the cursor, applies its own filters (`firedEvent`, `notFiredEvent`, `subscribedAfter`, etc.), drops contacts who fail.

The admin UI shows row counts at each stage, so operators can see where the segment narrows.

For broadcasts, the same two-pass evaluation runs against `count()` first to get the recipient count before sending. The broadcast confirmation gate (`09-admin-ui.md`) uses this count.

### Performance hooks

Two `Contact`-shaped objects are not the same as a Mongo document — mailer caches them with a short TTL (default 60s) per externalId to avoid hitting the adapter on every send within a single broadcast.

For broadcasts, mailer uses `getBatch(ids)` to hydrate up to 500 contacts per round trip.

---

## Conventions

- All mailer-owned collections are prefixed `mailer_` to avoid colliding with host collections in shared databases.
- All documents have `_id` (Mongo ObjectId), `createdAt`, `updatedAt`.
- All field names are `camelCase`.
- All enums are documented inline. Stick to documented values.
- Timestamps are JavaScript `Date` objects in UTC. ISO 8601 strings on the wire.
- All references between mailer collections are by `_id` unless noted.
- All references to a contact use `externalId` (string from the host) — mailer does not have its own contact ID.
- `slug` fields are URL-safe, kebab-case, globally unique per collection.

---

## Mailer-owned collections

There are **11 mailer-owned collections** — 7 that operators and scripts regularly touch, plus 4 operational ones that should be left alone.

### Frequently-touched (7)

#### 1. `mailer_subscriptions`

Consent state per contact. One row per `externalId`. Mailer's lightweight pointer back to the host's user record.

```ts
{
  _id: ObjectId,
  externalId: string,                              // host user._id

  // Subscription state — this is the source of truth for "can I send to this person?"
  status: 'subscribed' | 'pending_doi' | 'unsubscribed' | 'bounced' | 'complained',
  subscribedAt: Date | null,
  unsubscribedAt: Date | null,
  unsubscribeReason: string | null,                // 'user_request' | 'hard_bounce' | 'complaint' | 'manual' | 'gdpr_forget'

  // Double opt-in tracking (used when DOI is enabled in config)
  doiTokenHash: string | null,                     // sha256 of confirmation token
  doiRequestedAt: Date | null,
  doiConfirmedAt: Date | null,
  doiIp: string | null,
  doiUserAgent: string | null,

  // Source — where did this subscription originate?
  source: string,                                  // 'signup' | 'import:march-2026' | 'manual:jeff' | etc.

  // Snapshot of email at subscribe time (for compliance recordkeeping)
  emailAtSubscribe: string,

  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes**:
- `{ externalId: 1 }` unique
- `{ status: 1, unsubscribedAt: -1 }`

**Conventions**:
- Status `'subscribed'` is the only state that allows marketing sends. Transactional sends bypass this check (but still respect suppressions).
- One row per externalId. If the host deletes the user, the host should also call `mailer.removeSubscription(externalId)` — or the row stays orphan until garbage collection runs.
- A user without a subscription row defaults to **unsubscribed**. Subscription must be explicit (signup → subscribe).

#### 2. `mailer_leads`

Orphan emails — captured (form fill, newsletter signup) before they have a host user record. Promote to a real subscription once the host creates a user.

```ts
{
  _id: ObjectId,
  email: string,                                   // lowercase

  source: string,                                  // 'newsletter-form' | 'lead-magnet:guide-x' | etc.
  capturedFields: Record<string, any>,             // whatever the form collected

  // Promotion state
  status: 'lead' | 'promoted' | 'rejected',
  promotedToExternalId: string | null,
  promotedAt: Date | null,

  // Same compliance fields as subscriptions, since leads can also opt in / out
  consentedAt: Date | null,
  consentIp: string | null,
  unsubscribedAt: Date | null,

  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes**:
- `{ email: 1 }` unique
- `{ status: 1, createdAt: -1 }`

When the host calls `mailer.promoteLead(email, externalId)`, the lead is marked `promoted`, a `subscriptions` row is created with the inherited consent timestamp, and any in-flight flows targeting that email are redirected to the new `externalId`.

#### 3. `mailer_events`

Append-only behavioral event log. Drives flow triggers.

```ts
{
  _id: ObjectId,
  externalId: string,                              // host user._id (or lead promotion)
  name: string,                                    // e.g. 'Downloaded app'
  properties: object,

  // Idempotency — REQUIRED on every fire(). See public-api.
  dedupeKey: string,

  occurredAt: Date,
  createdAt: Date,
}
```

**Indexes**:
- `{ externalId: 1, occurredAt: -1 }`
- `{ name: 1, occurredAt: -1 }`
- `{ externalId: 1, name: 1 }`
- `{ dedupeKey: 1 }` unique

**Conventions**:
- Events are immutable. Never updated. Only deleted via GDPR forget.
- `name` is the contract — same exact string across firings.

#### 4. `mailer_flows`

A flow definition.

```ts
{
  _id: ObjectId,
  slug: string,
  name: string,
  description: string,

  trigger: {
    type: 'event' | 'segment_enter' | 'cron',
    eventName?: string,
    segmentDefinition?: SegmentDefinition,
    cronExpression?: string,
    once: boolean,
  },

  enabled: boolean,

  steps: FlowStep[],
  version: number,

  draft: {
    steps: FlowStep[],
    notes: string,
    lastModifiedBy: string,
    lastModifiedAt: Date,
  } | null,

  goal: 'activation' | 'conversion' | 'retention' | 'reactivation' | 'transactional' | 'broadcast',
  audience: string,
  expectedVolumePerWeek: number | null,

  stats: {
    activeRuns: number,
    completedRuns: number,
    sendsTotal: number,
    sendsLast7Days: number,
  },

  // Runner bookkeeping
  lastTriggerScanAt: Date | null,                  // watermark for event-trigger scanning

  publishedAt: Date | null,
  publishedBy: string | null,
  createdAt: Date,
  updatedAt: Date,
}
```

`FlowStep` and `Predicate` types — see end of doc.

**Indexes**:
- `{ slug: 1 }` unique
- `{ enabled: 1, 'trigger.type': 1, 'trigger.eventName': 1 }`

Companion collection: `mailer_flow_versions` (append-only snapshot per publish, for pinning in-flight runs).

```ts
{ flowId, version, steps, trigger, publishedAt, publishedBy }
```

#### 5. `mailer_flow_runs`

A specific contact's journey through a flow.

```ts
{
  _id: ObjectId,
  externalId: string,                              // contact reference
  flowId: ObjectId,
  flowSlug: string,
  flowVersion: number,                             // pinned at entry

  // Email snapshot at entry. Why: if the contact's email changes mid-flow,
  // future sends use the current email (via adapter), but for diagnostics
  // we want to know which email they entered as.
  emailAtEntry: string,

  enteredAt: Date,
  status: 'active' | 'completed' | 'exited' | 'failed',

  currentStepIndex: number,
  currentBranchPath: Array<number | 'true' | 'false'>,
  nextActionAt: Date,
  attemptsForCurrentStep: number,

  history: Array<{
    stepIndex: number,
    action: 'entered' | 'wait_started' | 'wait_completed' | 'condition_evaluated' | 'branch_taken' | 'sent' | 'send_skipped' | 'tagged' | 'event_fired' | 'webhook_called' | 'exited' | 'failed',
    at: Date,
    details?: object,
  }>,

  exitedAt: Date | null,
  exitReason: string | null,

  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes**:
- `{ status: 1, nextActionAt: 1 }` — runner's main query
- `{ externalId: 1, flowId: 1 }` — already-entered check
- `{ flowId: 1, status: 1 }`

#### 6. `mailer_templates`

An email's content.

```ts
{
  _id: ObjectId,
  slug: string,
  name: string,
  description: string,

  kind: 'transactional' | 'marketing',             // REQUIRED. Affects sender, suppression scope, circuit breaker.

  // Sender — defaults from config; templates override
  fromName: string,
  fromEmail: string,                               // recommend transactional uses tx@yourdomain, marketing uses marketing@yourdomain
  replyTo: string | null,
  providerOverride: string | null,                 // route through a specific provider instead of the default

  subject: string,                                 // Handlebars-allowed
  preheader: string,                               // Handlebars-allowed

  body: {
    mjml: string,                                  // source of truth
    html: string,                                  // compiled
    plainText: string,                             // auto-derived
    compiledAt: Date,
  },

  variablesSchema: {
    [name: string]: {
      type: 'string' | 'number' | 'boolean' | 'date' | 'url',
      required: boolean,
      description?: string,
      defaultValue?: any,
    },
  },

  draft: {
    subject: string,
    preheader: string,
    mjml: string,
    notes: string,
    lastModifiedBy: string,
    lastModifiedAt: Date,
  } | null,

  tags: string[],
  trackOpens: boolean,                             // default true; set false for transactional receipts
  trackClicks: boolean,                            // same

  stats: {
    sent: number,
    delivered: number,
    opened: number,
    clicked: number,
    bounced: number,
    complained: number,
    unsubscribed: number,
    lastSentAt: Date | null,
  },

  publishedAt: Date | null,
  publishedBy: string | null,
  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes**: `{ slug: 1 }` unique, `{ tags: 1 }`, `{ kind: 1 }`

#### 7. `mailer_sends`

Every send + lifecycle.

```ts
{
  _id: ObjectId,
  dedupeKey: string,                               // unique

  externalId: string,                              // contact reference at send time
  emailAtSend: string,                             // snapshot — for audit + bounce processing

  templateId: ObjectId,
  templateSlug: string,
  flowRunId: ObjectId | null,
  broadcastId: ObjectId | null,
  manualSendBy: string | null,

  kind: 'transactional' | 'marketing',             // from template at send time
  provider: string,
  providerMessageId: string | null,

  fromName: string,
  fromEmail: string,
  subject: string,
  bodyHash: string,

  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed',
  errorMessage: string | null,
  bounceType: 'hard' | 'soft' | null,
  bounceReason: string | null,

  openedAt: Date | null,
  openCount: number,
  firstClickAt: Date | null,
  clickCount: number,
  clickedLinks: Array<{ url: string, linkId: string, clickedAt: Date }>,

  unsubscribedAt: Date | null,
  complainedAt: Date | null,

  queuedAt: Date,
  sentAt: Date | null,
  deliveredAt: Date | null,
}
```

**Indexes**:
- `{ dedupeKey: 1 }` unique
- `{ externalId: 1, sentAt: -1 }`
- `{ templateId: 1, sentAt: -1 }`
- `{ flowRunId: 1 }`
- `{ broadcastId: 1 }`
- `{ providerMessageId: 1 }` sparse
- `{ status: 1, queuedAt: 1 }`

Why `emailAtSend`: bounces and complaints arrive via webhook days later, keyed by email. If the user has since changed email, we still need to suppress the email that actually bounced. So we snapshot.

#### 8. `mailer_suppressions`

"Do not send" list, scoped by kind.

```ts
{
  _id: ObjectId,
  email: string,                                   // lowercase
  emailHash: string,                               // sha256(email); kept after GDPR purge
  scope: 'all' | 'marketing' | 'transactional',
  reason: 'unsubscribed' | 'hard_bounce' | 'complaint' | 'manual' | 'list_cleaning' | 'gdpr_forget',
  source: string,
  notes: string | null,

  addedAt: Date,
  expiresAt: Date | null,
}
```

**Indexes**:
- `{ email: 1, scope: 1 }` unique
- `{ emailHash: 1 }`
- `{ addedAt: -1 }`

Send-time check: sending kind `marketing` skips if a suppression exists for that email with scope in `{'all', 'marketing'}`. Same logic for transactional with `{'all', 'transactional'}`.

#### 9. `mailer_broadcasts`

One-off campaigns.

```ts
{
  _id: ObjectId,
  slug: string,
  name: string,

  templateSlug: string,
  segmentDefinition: SegmentDefinition,

  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed',
  scheduledAt: Date | null,
  startedAt: Date | null,
  completedAt: Date | null,

  // Confirmation gate (admin UI only)
  confirmationRequired: boolean,
  confirmedCount: number | null,                   // operator-typed count at confirmation time
  confirmedAt: Date | null,
  confirmedBy: string | null,

  recipientCount: number | null,                   // computed when sending starts

  stats: {
    sent: number,
    delivered: number,
    opened: number,
    clicked: number,
    bounced: number,
    complained: number,
    unsubscribed: number,
  },

  createdAt: Date,
  createdBy: string,
  updatedAt: Date,
}
```

**Indexes**: `{ slug: 1 }` unique, `{ status: 1, scheduledAt: 1 }`

### Tag storage (optional, fallback-only)

These two collections only exist when the host doesn't expose tags through the adapter. If `tagsField + tagsWritable` are configured on `MongoContactAdapter`, mailer reads/writes the host's user document instead and these collections stay empty.

#### `mailer_tags` (tag definitions — always present)

Optional definitions for tags: colors, descriptions, etc. Independent of where the tag *values* live. Pure mailer config.

```ts
{
  _id: ObjectId,
  name: string,                                    // 'vip', 'engaged', 'beta'
  description: string | null,
  color: string | null,                            // hex for UI; '#5d30ff'
  origin: 'host' | 'mailer',                       // who owns tag application
  isProtected: boolean,                            // if true, mailer flows can't add/remove
  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes**: `{ name: 1 }` unique

A tag can be `origin: 'host'` (set by host app for business reasons; mailer never modifies) or `origin: 'mailer'` (managed by mailer flows). When the adapter has `tagsWritable: true`, both origins coexist on the same `user.tags` array — the convention is just human-readable.

#### `mailer_contact_tags` (tag values — fallback-only)

Used only when the adapter doesn't expose host-owned tags. Stores tag application per `externalId`.

```ts
{
  _id: ObjectId,
  externalId: string,
  tag: string,
  appliedBy: 'flow' | 'admin' | 'script' | 'import',
  appliedAt: Date,
}
```

**Indexes**: `{ externalId: 1, tag: 1 }` unique, `{ tag: 1 }`

When this collection is in use, `Contact.tags` is populated by mailer from a per-externalId aggregate. Otherwise this collection stays empty.

### Operational (4 — leave alone)

#### 10. `mailer_outbox`

Transactional outbox. Hosts that need to enqueue events as part of a Mongo session (so events never drift from business writes) write here in the session; a drain processes pending rows on each tick.

```ts
{
  _id: ObjectId,
  payload: { type: 'event' | 'upsert_subscription' | 'unsubscribe', data: object, dedupeKey: string },
  status: 'pending' | 'processed' | 'failed' | 'duplicate',
  attempts: number,
  lastAttemptAt: Date | null,
  lastError: string | null,
  enqueuedAt: Date,
  processedAt: Date | null,
}
```

**Indexes**: `{ status: 1, enqueuedAt: 1 }`, `{ 'payload.dedupeKey': 1 }` unique.

#### 11. `mailer_audit_log`

Every mutating action, intended for "who changed what when" queries.

```ts
{
  _id: ObjectId,
  actor: string,                                   // 'script:operator' | 'human:jeff@...' | 'system:webhook' | 'system:runner'
  action: string,                                  // 'flow.publish' | 'template.update' | ...
  resource: { collection: string, id: string | ObjectId, slug?: string },

  before: object | null,
  after: object | null,
  diffSummary: string | null,

  ip: string | null,
  userAgent: string | null,
  requestId: string | null,

  occurredAt: Date,
}
```

**Indexes**: `{ occurredAt: -1 }`, `{ 'resource.collection': 1, 'resource.id': 1, occurredAt: -1 }`, `{ actor: 1, occurredAt: -1 }`

Convention for direct-DB scripts: call `mailer.audit({...})` after every mutation. Documented in `DIRECT_DB.md`.

#### 12. `mailer_webhook_events`

Dedup store for inbound provider webhooks.

```ts
{
  _id: ObjectId,
  provider: string,
  providerEventId: string,                         // SendGrid sg_event_id, Postmark MessageID+RecordType, etc.
  eventType: string,
  normalizedType: 'delivered' | 'open' | 'click' | 'bounce' | 'complaint' | 'unsubscribe' | 'spam_report',
  providerMessageId: string,
  email: string,
  occurredAt: Date,
  receivedAt: Date,
  processed: boolean,
  raw: object,
}
```

**Indexes**: `{ provider: 1, providerEventId: 1 }` unique, `{ providerMessageId: 1 }`, `{ processed: 1, receivedAt: 1 }`

Retention: 30 days. Reconciliation against provider APIs (daily) catches anything missed.

#### 13. `mailer_health`

Rolling-window metrics for the circuit breaker.

```ts
{
  _id: 'singleton',
  windowStartedAt: Date,
  windowDurationMs: number,
  counters: {
    sent: number, delivered: number, bounced: number, hardBounced: number, softBounced: number,
    complained: number, failedToSend: number,
  },
  rates: {
    bounceRate: number, hardBounceRate: number, complaintRate: number, failureRate: number,
  },
  status: 'healthy' | 'degraded' | 'tripped',
  trippedAt: Date | null,
  trippedReason: string | null,
  manuallyResumedAt: Date | null,
  updatedAt: Date,
}
```

Circuit breaker thresholds (configurable; defaults):

| Trigger | Threshold | Action |
|---|---|---|
| Hard bounce rate / hour | >2% | trip; pause marketing |
| Complaint rate / hour | >0.3% | trip; pause marketing |
| Combined bounce rate | >5% | trip; pause all sends |
| Failed-to-send rate | >10% | degrade; alert |

Recovery is human-only (admin UI button writes `manuallyResumedAt` + audit log). The runner consults `status` before every send — if `tripped`, marketing sends are queued+held; transactional bypasses (they're often critical).

---

## Cross-cutting types

### `FlowStep` and `Predicate`

```ts
type FlowStep =
  | { type: 'wait', value: number, unit: 'minutes' | 'hours' | 'days' | 'weeks' }
  | { type: 'condition', test: Predicate, ifFalse: 'continue' | 'exit' }
  | { type: 'branch', test: Predicate, ifTrueSteps: FlowStep[], ifFalseSteps: FlowStep[] }
  | { type: 'send', templateSlug: string, providerOverride?: string }
  | { type: 'tag', addTags?: string[], removeTags?: string[] }     // routes through adapter (advisory) or pure event firing
  | { type: 'fire_event', eventName: string, properties?: object }
  | { type: 'webhook', url: string, method?: 'POST' | 'PUT', payload?: object }
  | { type: 'exit', reason: string }

type Predicate =
  | { hasTag: string }                              // checks adapter contact.fields.tags
  | { notHasTag: string }
  | { fieldEquals: { field: string, value: any } }  // adapter contact.fields
  | { fieldExists: string }
  | { hasFiredEvent: string, sinceFlowStart?: boolean, withinDays?: number }
  | { notHasFiredEvent: string, withinDays?: number }
  | { subscriptionStatus: 'subscribed' | 'unsubscribed' | 'pending_doi' | 'bounced' | 'complained' }
  // Engagement predicates — see INVARIANTS rule 7. Single-event variants are noisy
  // (Apple MPP, link-scanner bots). Prefer the *ExcludingBots or aggregated variants.
  | { hasOpened: { templateSlug?: string, sinceFlowStart?: boolean, withinDays?: number } }
  | { hasClicked: { templateSlug?: string, sinceFlowStart?: boolean, withinDays?: number } }
  | { hasOpenedExcludingBots: { templateSlug?: string, sinceFlowStart?: boolean, withinDays?: number } }
  | { hasClickedExcludingBots: { templateSlug?: string, sinceFlowStart?: boolean, withinDays?: number } }
  | { openedAtLeastN: { count: number, withinDays: number } }
  | { clickedAtLeastN: { count: number, withinDays: number } }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
```

Note: `hasTag` and `fieldEquals` route through the `ContactAdapter`. The library doesn't store its own copy of these — it asks the host on every evaluation (with short-TTL caching to keep cost low).

### `SegmentDefinition`

```ts
type SegmentDefinition = {
  filters: SegmentFilter[],                         // ANDed together
}

type SegmentFilter =
  // Host-side (evaluated via adapter)
  | { kind: 'fieldEquals', field: string, value: any }
  | { kind: 'fieldIn', field: string, values: any[] }
  | { kind: 'fieldExists', field: string }
  | { kind: 'hasTag', tag: string }                 // shorthand for fieldEquals on tags
  | { kind: 'notHasTag', tag: string }
  // Mailer-side (evaluated against mailer collections)
  | { kind: 'subscriptionStatus', equals: 'subscribed' | 'unsubscribed' | 'pending_doi' | 'bounced' | 'complained' }
  | { kind: 'firedEvent', eventName: string, withinDays?: number }
  | { kind: 'notFiredEvent', eventName: string, withinDays?: number }
  | { kind: 'subscribedAfter', date: Date }
  | { kind: 'subscribedBefore', date: Date }
  | { kind: 'opened', templateSlug?: string, withinDays?: number }   // engagement-based
  | { kind: 'notOpened', templateSlug?: string, withinDays?: number }
  // Composition
  | { kind: 'any', filters: SegmentFilter[] }       // OR
  | { kind: 'not', filter: SegmentFilter }
```

Evaluation order: mailer prefers to start with the most selective filter. Host-side and mailer-side filters compose via two-pass evaluation.

### Standard event names (StoryFolder example)

These are what the host fires via `mailer.fire(name, externalId)`. Conventions:

```
Created          Downloaded app    Activated app    Imported
Viewed Storyboard  Uploaded         Exported          Customer
Hit Free Limit    Cancelled         Refunded         Referred a friend
```

Plus app-specific custom events.

---

## Migration consideration

For StoryFolder specifically: the current `user.addTag('Imported')` flow on the server calls into a method that already syncs to MailerLite. The new integration is one line:

```ts
async addTag(tag) {
  this.tags.push(tag)
  await this.save()
  await mailer.fire(tag, this._id.toString(), { from: 'addTag' })
}
```

That's it. The adapter sees `this.tags` automatically because the `MongoContactAdapter`'s `toContact` projection exposes it.
