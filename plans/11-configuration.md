# 11 — Configuration

How to initialize and configure mailer in a host app.

## Full init shape

```ts
import { MongoClient } from 'mongodb'
import { Mailer, MongoContactAdapter, SendGridProvider, PostmarkProvider } from '@your-org/mailer'

const mongoClient = await MongoClient.connect(process.env.MONGODB_URI)
const db = mongoClient.db()                              // the native Db handle

const adapter = new MongoContactAdapter({
  db,
  collection: 'users',
  emailField: 'email',
  idField: '_id',
  tagsField: 'tags',
  tagsWritable: true,
  toContact: (user) => ({
    externalId: user._id.toString(),
    email: user.email,
    tags: user.tags ?? [],
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

const mailer = await Mailer.init({
  // Storage
  db,                                                    // mongodb.Db
  collectionPrefix: 'mailer_',                           // default; lets multiple instances coexist
  adapter,                                               // required

  // Queue
  redis: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT ?? '6379'),
    password: process.env.REDIS_PASSWORD,
  },

  // Providers
  providers: {
    sendgrid: new SendGridProvider({
      apiKey: process.env.SENDGRID_API_KEY,
      webhookVerificationKey: process.env.SENDGRID_WEBHOOK_KEY,
    }),
    postmark: new PostmarkProvider({
      apiKey: process.env.POSTMARK_API_KEY,
    }),
  },
  defaultProvider: 'sendgrid',
  defaultTransactionalProvider: 'postmark',              // optional; routes transactional templates here

  // Identity
  publicUrl: 'https://yourdomain.com',                   // base for tracking/unsub URLs
  unsubscribeSecret: process.env.MAILER_UNSUB_SECRET,    // HMAC key — generate with crypto.randomBytes(32).toString('hex')
  senderAddress: '12 Main Street, Brooklyn, NY 11201, USA',
  fromDefaults: {
    name: 'Jeff Jassky',
    email: 'jeff@yourdomain.com',
  },
  transactionalFromDefaults: {
    name: 'StoryFolder',
    email: 'tx@yourdomain.com',
  },

  // Compliance
  requireDoubleOptIn: false,
  unsubscribeTokenLifetimeDays: 90,
  transactionalRespectUnsubscribe: false,

  // Health / circuit breaker
  circuitBreaker: {
    hardBounceRatePctTrip: 2,                            // trip when last-hour hard-bounce rate exceeds
    complaintRatePctTrip: 0.3,
    combinedBounceRatePctTrip: 5,
    failedToSendRatePctDegrade: 10,
    windowMinutes: 60,
    minSendsBeforeEval: 100,                             // don't trip on tiny sample sizes
  },

  // Broadcast safety + throughput
  broadcastConfirmationThreshold: 1000,                  // require typed-count gate above this
  broadcastEnqueueBatchSize: 1000,                       // recipients enqueued per page when streaming a segment
  broadcastEnqueueMaxWaiting: 5000,                      // pause enqueue when the send queue's waiting set exceeds this

  // Worker behavior
  workerless: false,                                     // set true on web processes that don't run BullMQ workers
  tickIntervalSeconds: 60,
  sendConcurrency: 5,
  sendRatePerSecond: 10,                                 // global default; provider config overrides per-provider
  softBouncePromotionThreshold: 3,                       // soft bounces in window → hard suppression
  softBouncePromotionWindowDays: 30,

  // Tracking
  trackOpens: true,                                      // default; per-template overrides
  trackClicks: true,
  storeTrackingIp: false,                                // privacy-conscious default
  storeRenderedBody: false,                              // size-conscious default; flip on for compliance audits

  // Optional hooks
  getAdminActor: (req) => `human:${req.user?.email ?? 'anonymous'}`,
  onCircuitBreakerTrip: async ({ reason, rates }) => {
    await slack.notify(`#alerts`, `mailer tripped: ${reason}`)
  },
  onSendFailure: async ({ send, error }) => {
    // optional Sentry/datadog reporter
  },
  handlebarsHelpers: { /* custom helpers */ },

  // Optional consent log destination — if set, every consent/opt-in/opt-out
  // event also writes to this stream (for compliance audits in some jurisdictions).
  consentLog: {
    sink: 's3',
    bucket: process.env.CONSENT_LOG_BUCKET,
  },
})
```

## Required options

These six are mandatory; everything else has sensible defaults.

| Option | Why |
|---|---|
| `db` | Native MongoDB `Db` handle. Mailer's storage. |
| `adapter` | The host's `ContactAdapter`. Mailer needs to read contacts somehow. |
| `redis` | BullMQ requires Redis. |
| `providers` (with at least one entry) | Mailer needs at least one way to send email. |
| `publicUrl` | Tracking, unsub, and webhook URLs are absolute. |
| `unsubscribeSecret` | HMAC tokens — must be a stable secret. |

## Recommended options

These have defaults but you almost certainly want to set them:

| Option | Default | Recommendation |
|---|---|---|
| `senderAddress` | `(none)` | Required by CAN-SPAM in marketing footers. Set it. |
| `fromDefaults` | `{ name: '', email: '' }` | Set per-template overrides, but a global default is convenient. |
| `defaultProvider` | First provider in `providers` map | Pick explicitly to avoid surprises. |
| `circuitBreaker` thresholds | (sane defaults) | Tighten if you have audience-specific deliverability concerns. |

## Web vs worker process

For production HA, run two process types from the same image:

**Web (handles HTTP):**

```ts
const mailer = await Mailer.init({
  // ...
  workerless: true,         // don't start BullMQ workers here
})
// app.use(...)
// start HTTP server
```

**Worker (handles BullMQ jobs):**

```ts
const mailer = await Mailer.init({
  // ...same config...
  // workerless defaults to false
})
await mailer.startWorkers()
// keep process alive
```

Both share the same Mongo + Redis. Web writes events (via `fire()`) and serves HTTP endpoints (tracking, admin UI). Worker processes the queues.

## The `MongoContactAdapter` in detail

The default adapter ships with these options:

```ts
new MongoContactAdapter({
  // Required
  db: Db,                                                // host's native MongoDB Db
  collection: string,                                    // host user collection (e.g. 'users')
  emailField: string,                                    // path to email on user doc (e.g. 'email')
  idField: string,                                       // path to id on user doc (e.g. '_id')

  // Optional — tags integration
  tagsField?: string,                                    // path to tags array on user doc
  tagsWritable?: boolean,                                // if true, mailer can write to tagsField
  tagsArrayShape?: 'strings' | 'objects',                // 'strings' for ['vip','beta']; 'objects' for [{ name: 'vip' }]

  // Optional — projection
  toContact?: (userDoc: any) => Contact,                 // customize what mailer sees
  contactFields?: string[],                              // shortcut: project these as Contact.fields keys

  // Optional — query translation
  translateFilter?: (filter: AdapterFilter) => any,      // customize how AdapterFilter becomes a Mongo query

  // Optional — batching
  batchSize?: number,                                    // default 500
})
```

For 95% of Mongo hosts, the defaults suffice and the config is 5 lines.

## Implementing your own adapter

For non-Mongo hosts (e.g. PostgreSQL) or for hosts with unusual identity setups, implement the interface yourself:

```ts
import { ContactAdapter, Contact, AdapterFilter } from '@your-org/mailer'

class PostgresContactAdapter implements ContactAdapter {
  constructor(private pool: Pool) {}

  async getById(externalId: string): Promise<Contact | null> {
    const { rows } = await this.pool.query(
      'SELECT id, email, first_name, tags FROM users WHERE id = $1',
      [externalId],
    )
    if (!rows[0]) return null
    return this.rowToContact(rows[0])
  }

  async getByEmail(email: string): Promise<Contact | null> { /* ... */ }
  async getBatch(externalIds: string[]): Promise<Map<string, Contact>> { /* ... */ }
  async query(filter: AdapterFilter, opts): Promise<{ contacts: Contact[], nextCursor?: string }> { /* ... */ }
  async count(filter: AdapterFilter): Promise<number> { /* ... */ }

  async addTags(externalId: string, tags: string[]): Promise<void> {
    await this.pool.query(
      `UPDATE users SET tags = ARRAY(SELECT DISTINCT unnest(tags || $1::text[])) WHERE id = $2`,
      [tags, externalId],
    )
  }

  async removeTags(externalId: string, tags: string[]): Promise<void> { /* ... */ }

  private rowToContact(row: any): Contact {
    return {
      externalId: row.id,
      email: row.email,
      tags: row.tags ?? [],
      fields: { firstName: row.first_name },
    }
  }
}
```

The interface is intentionally tiny. An adapter is usually 100-200 lines of code.

## Multiple deployments per app

If a single host app needs multiple mailer instances (e.g. one for marketing@, one for support@), give each its own `collectionPrefix` and mount under different routes:

```ts
const marketingMailer = await Mailer.init({ collectionPrefix: 'mkt_mailer_', /* ... */ })
const supportMailer = await Mailer.init({ collectionPrefix: 'sup_mailer_', /* ... */ })

app.use('/admin/marketing-mail', marketingMailer.adminRouter())
app.use('/admin/support-mail', supportMailer.adminRouter())
```

They share the host's user collection (same adapter) but their own subscriptions, flows, templates, etc.

This is unusual — most apps run a single instance — but it's supported.

## Env variable convention

If you'd rather configure from env vars (12-factor):

```ts
import { Mailer } from '@your-org/mailer'

const mailer = await Mailer.fromEnv()
```

`fromEnv()` reads:

```
MAILER_MONGODB_URI
MAILER_REDIS_URL
MAILER_PUBLIC_URL
MAILER_UNSUBSCRIBE_SECRET
MAILER_SENDER_ADDRESS
MAILER_FROM_NAME
MAILER_FROM_EMAIL
MAILER_DEFAULT_PROVIDER
MAILER_SENDGRID_API_KEY
MAILER_SENDGRID_WEBHOOK_KEY
MAILER_POSTMARK_API_KEY
MAILER_HOST_USERS_COLLECTION
MAILER_HOST_USERS_EMAIL_FIELD
MAILER_HOST_USERS_ID_FIELD
MAILER_HOST_USERS_TAGS_FIELD
MAILER_HOST_USERS_TAGS_WRITABLE
```

The adapter is built from these conventions automatically. The rest of the config is read from defaults. For anything more complex (custom `toContact`, custom providers, hooks), use the programmatic init.

## Migration: existing MailerLite users

For StoryFolder specifically, migration steps:

1. Add `mailer` package to host repo.
2. Configure with `MongoContactAdapter` pointing at existing `users` collection — `tagsField: 'tags'`, `tagsWritable: true`.
3. Import existing MailerLite subscribers into `mailer_subscriptions` (one-time script: pull from MailerLite API, create subscription rows keyed by externalId resolved by email lookup against `users`).
4. Import MailerLite suppression list into `mailer_suppressions`.
5. In `user.addTag()`, after the existing logic, add: `await mailer.fire(tag, user._id.toString(), {}, \`${user._id}:${tag}\`)`.
6. Start with one flow live in `mailer` (the activation rescue), keep MailerLite's main drip running in parallel.
7. Once mailer is proven, migrate flow-by-flow off MailerLite.

No big-bang cutover required.
