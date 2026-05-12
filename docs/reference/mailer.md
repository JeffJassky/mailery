# Mailer

The library's main class. Hosts call `Mailer.init(config)` to construct an instance.

```ts
import { Mailer } from 'mailery'
```

## Static methods

### `Mailer.init(config)`

```ts
static async init(config: MailerConfig): Promise<Mailer>
```

Connects to Mongo / Redis, ensures indexes on all mailer collections, sets up BullMQ queues. Does **not** start workers — call `.startWorkers()` for that.

```ts
const mailer = await Mailer.init({
  db,
  adapter: new MongoContactAdapter({ db, collection: 'users' }),
  redis: { url: process.env.REDIS_URL! },
  providers: { sendgrid: new SendGridProvider({ apiKey: '...' }) },
  defaultProvider: 'sendgrid',
  publicUrl: 'https://yourdomain.com',
  unsubscribeSecret: process.env.MAILER_UNSUB_SECRET!,
})
```

See [the configuration guide](/guide/configuration) for the full `MailerConfig`.

### `Mailer.fromEnv()`

```ts
static async fromEnv(): Promise<Mailer>
```

Constructs a `Mailer` from `MAILER_*` env vars. See [the guide](/guide/configuration#from-environment-variables) for the variable list.

## Event firing

### `registerEvent(input)`

```ts
registerEvent(input: { name: string; dedupePolicy: 'once-per-contact' | 'once-per-day' | 'every-time' }): void
```

Declares an event name + dedupe policy so subsequent `fire()` calls can omit the key.

### `fire(name, externalId, properties?, dedupeKey?)`

```ts
fire(
  eventName: string,
  externalId: string,
  properties?: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void>
```

Records a behavioral event. If no `dedupeKey` is passed, one is derived from the registered policy. Without either, throws.

Duplicate-keyed calls are silent no-ops at the unique index.

### `fireFromSession(session, name, externalId, properties?, dedupeKey?)`

```ts
fireFromSession(
  session: ClientSession,
  eventName: string,
  externalId: string,
  properties?: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void>
```

Use inside a Mongo transaction. Writes to `mailer_outbox` within the session; the tick drains pending rows into `mailer_events` after the transaction commits.

## Subscriptions

### `upsertSubscription(input)`

```ts
upsertSubscription(input: {
  externalId: string
  source: string
  consentTimestamp?: Date
  consentIp?: string
  consentUserAgent?: string
}): Promise<void>
```

Creates / updates the `mailer_subscriptions` row for a contact. If `requireDoubleOptIn: true` in config, the new row is `status: 'pending_doi'`.

### `unsubscribe(email, opts)`

```ts
unsubscribe(email: string, opts: {
  scope: 'all' | 'marketing' | 'transactional'
  reason?: 'user_request' | 'hard_bounce' | 'complaint' | 'manual' | 'gdpr_forget' | 'list_cleaning'
  source?: string
  notes?: string
}): Promise<void>
```

Records an unsubscribe + adds a suppression row. Same path as the public `/m/unsub/:token` endpoint.

## Suppression

### `suppress(email, opts)`

```ts
suppress(email: string, opts: {
  scope: 'all' | 'marketing' | 'transactional'
  reason: 'unsubscribed' | 'hard_bounce' | 'complaint' | 'manual' | 'list_cleaning' | 'gdpr_forget'
  source?: string
  notes?: string
  expiresAt?: Date
}): Promise<void>
```

Adds a suppression row directly. Idempotent (upsert on `(email, scope)`).

## Tags

### `tag(externalId, tag)` / `untag(externalId, tag)`

```ts
tag(externalId: string, tag: string): Promise<void>
untag(externalId: string, tag: string): Promise<void>
```

Adds / removes a tag. Routes through `adapter.addTags` / `removeTags` if defined; otherwise writes to `mailer_contact_tags`.

## GDPR

### `forget(externalId)`

```ts
forget(externalId: string): Promise<void>
```

Hard-deletes all PII for the contact across mailer collections, then inserts a `mailer_suppressions` row with `email: null` + `emailHash` retained. Future sends to the same email are blocked at the hash level — INVARIANT 9.

### `exportContactData(externalId)`

```ts
exportContactData(externalId: string): Promise<Record<string, unknown>>
```

Returns a JSON-serializable object with all mailer-side data for the contact (subscription, events, flowRuns, sends, suppressions, tags). Pipe this into your host's GDPR export.

## One-off sends

### `sendOneOff(input)`

```ts
sendOneOff(input: {
  templateSlug: string
  externalId: string
  vars?: Record<string, unknown>
  providerOverride?: string
  dedupeKey: string                     // required
}): Promise<{ sendId: string }>
```

Ad-hoc transactional send (receipts, password resets). Same pipeline as flow sends — suppression check, tracking, idempotency via `dedupeKey`.

```ts
await mailer.sendOneOff({
  templateSlug: 'password-reset',
  externalId: user._id.toString(),
  vars: { resetUrl: `https://yourdomain.com/reset?token=${tokenHash}` },
  dedupeKey: `password-reset:${user._id}:${tokenHash}`,
})
```

The `dedupeKey` prevents accidental double-sends if your caller retries.

## Audit

### `audit(entry)`

```ts
audit(entry: {
  actor: string
  action: string
  resource: { collection: string; id?: string | ObjectId; slug?: string }
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  diffSummary?: string
  ip?: string
  userAgent?: string
  requestId?: string
}): Promise<void>
```

Writes an entry to `mailer_audit_log`. Useful when you mutate mailer collections directly from a deploy script:

```ts
await db.collection('mailer_flows').updateOne({ slug }, { $set: { 'draft.steps': newSteps } })
await mailer.audit({
  actor: 'script:deploy',
  action: 'flow.draft.update',
  resource: { collection: 'mailer_flows', slug },
  diffSummary: 'Added day-21 check-in step',
})
```

## Lifecycle

### `startWorkers()`

```ts
startWorkers(): Promise<void>
```

Spins up BullMQ workers for tick / advance / send / webhook queues. Call from your worker process only.

### `stop()`

```ts
stop(): Promise<void>
```

Closes workers, queues, and the Redis connection. Call on `SIGTERM` for graceful shutdown.

### `getRunnerContext()`

```ts
getRunnerContext(): RunnerContext
```

Returns the internal context object passed to runner functions. Useful for tests that drive `runTick`, `processOneRunStep`, `dispatchSend` directly. Not part of the public API for production code.

## Properties

| Property | Type | Notes |
|---|---|---|
| `mailer.db` | `Db` | The Mongo database mailery owns its collections in. |
| `mailer.collections` | `Collections` | Typed accessors for every `mailer_*` collection. |
| `mailer.adapter` | `ContactAdapter` | Whatever you passed at init. |
| `mailer.providers` | `Record<string, MailProvider>` | Configured providers map. |
| `mailer.queues` | `Queues` | BullMQ queue facade (`add`, `getWaitingCount`, `close`). |
| `mailer.redis` | `IORedis \| null` | The Redis connection, or null in queueless mode. |
| `mailer.config` | `ResolvedConfig` | Resolved configuration with defaults applied. |
| `mailer.events` | `EventRegistry` | Internal registry tracking event policies. |
