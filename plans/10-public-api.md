# 10 — Public API

The methods the consuming app calls into. The surface is intentionally small — most state changes are done by reading and writing MongoDB documents directly. The public API is what mediates the few operations where doing it by hand is dangerous or annoying.

## The Mailer class

```ts
import { Mailer } from '@your-org/mailer'

const mailer = await Mailer.init({
  db,                                                  // mongodb.Db (NOT mongoose)
  adapter,                                             // ContactAdapter instance
  redis: { host, port, password },
  providers: { sendgrid: new SendGridProvider({ apiKey }) },
  defaultProvider: 'sendgrid',
  publicUrl: 'https://yourdomain.com',
  unsubscribeSecret: process.env.MAILER_UNSUB_SECRET,
  senderAddress: '12 Main St, Brooklyn NY 11201',
  fromDefaults: { name: 'Jeff', email: 'jeff@yourdomain.com' },
  // ...see configuration.md for full options
})

await mailer.startWorkers()                            // optional; for the worker process
```

## Routers (mountable)

```ts
app.use('/admin/mailer', requireAdmin, mailer.adminRouter())
app.use('/m', mailer.publicRouter())                   // tracking + unsub + webhooks
```

The public router has no auth — it must be reachable by email recipients and provider webhooks.

## Core methods

### `mailer.registerEvent(name, opts)`

Optional setup call. Declares an event name and the policy the library should use to derive a `dedupeKey` when the caller doesn't pass one. Call at startup, after `Mailer.init`.

```ts
mailer.registerEvent('Created',          { dedupePolicy: 'once-per-contact' })
mailer.registerEvent('Downloaded app',   { dedupePolicy: 'once-per-contact' })
mailer.registerEvent('Viewed Storyboard',{ dedupePolicy: 'once-per-day' })
mailer.registerEvent('Imported',         { dedupePolicy: 'every-time' })       // each call unique
```

Policies:

| Policy | Auto-derived key shape | Use when |
|---|---|---|
| `once-per-contact` | `${externalId}:${eventName}` | Lifecycle markers ("Created", "Activated") |
| `once-per-day` | `${externalId}:${eventName}:${YYYY-MM-DD}` | Behaviors that can recur but shouldn't burn a flow every time ("Viewed Storyboard") |
| `every-time` | `${externalId}:${eventName}:${UUIDv4}` | True every-occurrence events ("Imported a video") |

Registration is optional but recommended — without it, every `fire()` for that name must pass an explicit `dedupeKey`.

### `mailer.fire(eventName, externalId, props?, dedupeKey?)`

Records a behavioral event for a contact. The fundamental method — drives flow triggers, segment evaluation, analytics.

```ts
// With registered policy — no key needed:
await mailer.fire('Created', user._id.toString())

// Without policy — pass an explicit key:
await mailer.fire('Stripe Webhook', user._id.toString(), { type: 'charge.refunded' }, stripeEvent.id)
```

Per `INVARIANTS.md` rule 1, every event reaching `mailer_events` has a dedupeKey. If the caller doesn't pass one, the library uses the registered policy for that event name. If neither is available, the library throws at runtime.

Duplicate-keyed calls are silent no-ops at the unique index.

### `mailer.fireFromSession(session, eventName, externalId, props, dedupeKey)`

The transactional outbox variant. Use inside a Mongo session/transaction so the event write is atomic with your business write.

```ts
const session = client.startSession()
await session.withTransaction(async () => {
  await User.updateOne({ _id }, { $addToSet: { tags: 'Imported' } }, { session })
  await mailer.fireFromSession(session, 'Imported', _id.toString(), {}, `${_id}:Imported`)
})
```

This writes to `mailer_outbox` inside the transaction. The drain promotes it to `mailer_events` after the transaction commits. If the transaction aborts, the event isn't dispatched. No flow ever fires from a business write that didn't actually happen.

### `mailer.upsertSubscription({ externalId, source, consentTimestamp? })`

Records consent and creates / updates `mailer_subscriptions` for a contact.

```ts
await mailer.upsertSubscription({
  externalId: user._id.toString(),
  source: 'signup-form',
  consentTimestamp: new Date(),
  consentIp: req.ip,
  consentUserAgent: req.headers['user-agent'],
})
```

If `requireDoubleOptIn: true` in config, the new subscription is `status: 'pending_doi'` and a DOI-request email fires automatically. Otherwise `status: 'subscribed'`.

### `mailer.unsubscribe(email, opts)`

Programmatic unsubscribe. Same path as the public endpoint.

```ts
await mailer.unsubscribe('user@example.com', {
  scope: 'marketing',
  reason: 'manual',
  source: 'support:ticket-1234',
})
```

### `mailer.tag(externalId, tag)` / `mailer.untag(externalId, tag)`

Adds/removes a tag for a contact. Routes through the adapter's `addTags`/`removeTags` if defined, otherwise updates `mailer_contact_tags`.

```ts
await mailer.tag(user._id.toString(), 'commercial-creator')
```

Use this instead of writing to `user.tags` directly — even if you know the adapter exposes tags writably. The abstraction is what lets storage be swappable.

### `mailer.suppress(email, opts)`

Add to suppressions. Typically used by integrations:

```ts
await mailer.suppress('user@example.com', {
  scope: 'all',
  reason: 'manual',
  source: 'support:user-requested',
  notes: 'User emailed support asking to be removed entirely',
})
```

### `mailer.forget(externalId)`

GDPR right-to-erasure. Deletes PII for the contact, inserts a hashed suppression record. Per `INVARIANTS.md` rule 9.

```ts
// In your delete-user route:
await User.deleteOne({ _id })
await mailer.forget(_id.toString())
```

### `mailer.exportContactData(externalId)`

GDPR data-export. Returns a JSON-serializable object with all mailer-side data for the contact. See `08-compliance.md`.

### `mailer.sendOneOff(args)`

For ad-hoc transactional sends not tied to a flow or broadcast — receipts, password resets, etc.

```ts
await mailer.sendOneOff({
  templateSlug: 'password-reset',
  externalId: user._id.toString(),
  vars: { resetUrl: '...' },
  dedupeKey: `password-reset:${user._id}:${tokenHash}`,
})
```

The dedupeKey prevents accidental double-sends if your caller retries. Required.

### `mailer.scheduleBroadcast(args)`

Create a broadcast programmatically. Same effect as creating via admin UI, but skips the typed-count confirmation gate (caller is responsible for safety).

```ts
await mailer.scheduleBroadcast({
  templateSlug: 'monthly-newsletter',
  segmentDefinition: { filters: [{ kind: 'subscriptionStatus', equals: 'subscribed' }] },
  scheduledAt: new Date('2026-06-01T15:00:00Z'),
  name: 'June Newsletter',
  createdBy: 'script:operator',
})
```

### `mailer.audit({ actor, action, resource, before, after })`

Helper for writing audit log entries — primarily for scripts making direct DB writes.

```ts
// A script has updated a flow draft directly
await db.collection('mailer_flows').updateOne(
  { slug: 'activation-rescue' },
  { $set: { 'draft.steps': newSteps, 'draft.lastModifiedAt': new Date() } },
)
await mailer.audit({
  actor: 'script:operator',
  action: 'flow.draft.update',
  resource: { collection: 'mailer_flows', slug: 'activation-rescue' },
  diffSummary: 'Added two new send steps to draft',
})
```

## Lower-level access

For scripts and tooling that want direct DB:

```ts
mailer.db                 // mongodb.Db handle (use carefully)
mailer.collections        // { contacts, events, flows, ... } typed accessors
mailer.queues             // BullMQ Queue instances
mailer.providers          // configured providers map
mailer.adapter            // ContactAdapter instance
```

Direct collection access is documented and supported — see `DIRECT_DB.md` — but follow the audit-log convention from `INVARIANTS.md` rule 10.

## Lifecycle

```ts
await mailer.startWorkers()         // start BullMQ workers in this process
await mailer.stop()                 // graceful shutdown — drains in-flight jobs
```

On a web process you typically skip `startWorkers()` (passing `workerless: true` to `init`). On the worker process you call `startWorkers()` and never `stop()` until shutdown.

## Idempotency cheat sheet

| Operation | Idempotency mechanism |
|---|---|
| `fire()` | dedupeKey unique index (caller-passed or policy-derived per `registerEvent`) |
| `fireFromSession()` | dedupeKey unique index on outbox |
| `upsertSubscription()` | unique on externalId |
| `unsubscribe()` | safe to call repeatedly — upserts suppression |
| `tag()` / `untag()` | adapter `$addToSet` / `$pull` semantics; mailer-side same |
| `suppress()` | upsert on (email, scope) |
| `forget()` | safe to call multiple times — deletes already-deleted is a no-op |
| `sendOneOff()` | dedupeKey unique |
| `scheduleBroadcast()` | unique on slug; second call with same slug rejects |

Every public method is safe to retry. No method has surprising side effects when called twice with the same arguments.
