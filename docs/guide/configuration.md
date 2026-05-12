# Configuration

`Mailer.init(config)` accepts a single object. Six fields are required; the rest have sensible defaults.

## Required

```ts
await Mailer.init({
  db,                                    // mongodb.Db
  adapter,                               // ContactAdapter — see /reference/types-contact
  redis: { url: 'redis://...' },         // RedisOptions | IORedis | null
  providers: { sendgrid: new SendGridProvider({...}) },
  defaultProvider: 'sendgrid',
  publicUrl: 'https://yourdomain.com',   // base URL for /m/* endpoints (tracking, unsub, webhooks)
  unsubscribeSecret: 'min-32-char-secret',
})
```

| Field | Purpose |
|---|---|
| `db` | Native MongoDB `Db` instance. mailery creates indexes on init. |
| `adapter` | A `ContactAdapter` that reads from your host's user collection. Usually `new MongoContactAdapter(...)`. |
| `redis` | BullMQ backend. Pass options, an `ioredis` instance, or `null` to opt out of BullMQ (synchronous-only mode). |
| `providers` | Map of provider name → instance. Must include at least the `defaultProvider`. |
| `defaultProvider` | Which provider key (above) handles unrouted sends. |
| `publicUrl` | Base of the URL where you mount `createPublicRouter()`. Used for unsubscribe / open pixel / click links. |
| `unsubscribeSecret` | HMAC key for signing unsubscribe tokens. Rotate this and existing one-click links break — set once, keep stable. |

## Recommended

```ts
await Mailer.init({
  // ... required above
  senderAddress: '12 Main Street, Brooklyn NY 11201, USA',
  fromDefaults: { name: 'Jeff', email: 'hello@yourdomain.com' },
  transactionalFromDefaults: { name: 'YourCompany', email: 'tx@yourdomain.com' },
  defaultTransactionalProvider: 'postmark',    // route transactional through a different provider
})
```

- `senderAddress` — your postal address, required by CAN-SPAM for marketing email. Configure your templates to use the `{{senderAddress}}` Handlebars helper to inject it into footers.
- `fromDefaults` — global default From identity (overridable per template).
- `transactionalFromDefaults` — distinct From for transactional emails. Recommended for reputation isolation.
- `defaultTransactionalProvider` — route transactional templates through a provider optimized for inbox placement (Postmark), while marketing goes through one optimized for volume (SendGrid).

## Worker behavior

```ts
{
  workerless: false,            // set true on web processes that don't run BullMQ workers
  tickIntervalSeconds: 60,      // how often the recovery sweep runs
  sendConcurrency: 5,           // parallel send jobs per worker
  sendRatePerSecond: 10,        // global cap (per-provider overrides this)
  webhookRetryAttempts: 3,
  sendRetryAttempts: 4,
}
```

See [Deployment](./deployment) for the web/worker split.

## Tracking

```ts
{
  trackOpens: true,               // default; per-template overrides
  trackClicks: true,
  storeTrackingIp: false,         // privacy default — IPs not stored
  storeRenderedBody: false,       // size default — body hash is stored, not full HTML
}
```

## Broadcasts

```ts
{
  broadcastConfirmationThreshold: 1000,    // typed-count gate above this
  broadcastEnqueueBatchSize: 1000,
  broadcastEnqueueMaxWaiting: 5000,
}
```

## Compliance

```ts
{
  requireDoubleOptIn: false,
  unsubscribeTokenLifetimeDays: 90,
  transactionalRespectUnsubscribe: false,    // false = transactional sends to unsubscribed users still go out
}
```

## Circuit breaker

```ts
{
  circuitBreaker: {
    hardBounceRatePctTrip: 2,            // trip when rolling hard-bounce rate >= 2%
    complaintRatePctTrip: 0.3,
    combinedBounceRatePctTrip: 5,
    failedToSendRatePctDegrade: 10,
    windowMinutes: 60,
    minSendsBeforeEval: 100,             // don't trip on tiny sample sizes
  },
}
```

When tripped, marketing sends are held; transactional sends bypass. Manual reset only — mailery never auto-resumes.

## Hooks

Custom Handlebars helpers + alert callbacks:

```ts
{
  handlebarsHelpers: {
    truncate: (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s),
  },
  getAdminActor: (req) => `human:${req.user?.email ?? 'anonymous'}`,
  onCircuitBreakerTrip: async ({ reason, rates }) => {
    await slack.notify(`#alerts`, `mailery tripped: ${reason}`)
  },
  onSendFailure: async ({ send, error }) => {
    sentry.captureException(error, { extra: { sendId: send._id } })
  },
}
```

## From environment variables

If you'd rather configure via env vars (12-factor):

```ts
const mailer = await Mailer.fromEnv()
```

Reads:

```
MAILER_MONGODB_URI          MAILER_REDIS_URL
MAILER_PUBLIC_URL           MAILER_UNSUBSCRIBE_SECRET
MAILER_SENDER_ADDRESS       MAILER_FROM_NAME / MAILER_FROM_EMAIL
MAILER_DEFAULT_PROVIDER     MAILER_SENDGRID_API_KEY / MAILER_SENDGRID_WEBHOOK_KEY
MAILER_HOST_USERS_COLLECTION (default 'users')
MAILER_HOST_USERS_EMAIL_FIELD (default 'email')
MAILER_HOST_USERS_ID_FIELD (default '_id')
MAILER_HOST_USERS_TAGS_FIELD
MAILER_HOST_USERS_TAGS_WRITABLE
```

For anything more elaborate (custom `toContact`, custom providers, hooks), use the programmatic `Mailer.init(...)`.
