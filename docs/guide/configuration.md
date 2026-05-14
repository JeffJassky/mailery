# Configuration

`Mailer.init(config)` accepts a single object. Six fields are required; the rest have sensible defaults.

## Required

```ts
await Mailer.init({
  db,                                    // mongodb.Db
  adapter,                               // ContactAdapter — see /reference/types-contact
  queue: { driver: 'bull', redis: { url: 'redis://...' } },   // or { driver: 'agenda' }, or { driver: 'noop' }
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
| `queue` | Queue driver selection. See [Queue drivers](./queues). One of `{ driver: 'bull', redis }`, `{ driver: 'agenda' }`, `{ driver: 'noop' }`. |
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

## Sender domains (reputation isolation)

If you send both marketing and transactional email, your transactional pipeline's deliverability lives or dies on your sender domain's reputation. Marketing complaints / soft-bounces on `news.example.com` should never affect password resets on `mail.example.com`. The `senderDomains` registry enforces that separation at template publish time:

```ts
await Mailer.init({
  // ...
  fromDefaults: { name: 'YourApp Newsletter', email: 'hello@news.example.com' },
  transactionalFromDefaults: { name: 'YourApp', email: 'noreply@mail.example.com' },
  senderDomains: {
    'news.example.com':  { kind: 'marketing' },
    'mail.example.com':  { kind: 'transactional' },
    'tools.example.com': { kind: 'both' },           // OK for either kind
  },
})
```

What this guarantees:

- A template whose `kind: 'marketing'` cannot publish with a `fromEmail` on `mail.example.com` — the publish returns `400 sender_domain_invalid` with the reason.
- A template whose `kind: 'transactional'` cannot publish with a `fromEmail` on `news.example.com`.
- A template with a `fromEmail` on an unregistered domain (typo, copy-paste from another app) is rejected at publish.

The check also runs at template create + draft update, so the admin UI surfaces the error immediately. If you leave `senderDomains` unset (the default), no enforcement happens — back-compatible.

Verify each declared domain separately with your email provider (SendGrid / Postmark / SES) so each gets its own DKIM signature and reputation. mailery doesn't manage the DNS side; it just enforces that you actually use the domains you set up.

## Worker behavior

```ts
{
  workerless: false,            // set true on web processes that don't run background workers
  tickIntervalSeconds: 60,      // how often the recovery sweep runs
  sendConcurrency: 5,           // parallel send jobs per worker
  sendRatePerSecond: 10,        // global cap (per-provider overrides this)
  webhookRetryAttempts: 3,
  sendRetryAttempts: 4,
}
```

See [Queue drivers](./queues) for the Bull/Agenda choice, and [Deployment](./deployment) for the web/worker split.

## Setup status checks

The dashboard surfaces a banner when something in your configuration is broken or worth a second look. Backed by `GET /admin/mailer/api/setup-status` which runs a handful of checks each time the dashboard loads (and every 60s while open):

- **MongoDB connection** — error if the ping fails.
- **Queue driver** — error if the configured driver isn't responding.
- **Workers heartbeat** — error if the last tick is more than `3 × tickIntervalSeconds` old. Usually means you forgot to start a worker process.
- **Circuit breaker** — warning when degraded, error when tripped.
- **`fromDefaults` / `transactionalFromDefaults` vs `senderDomains`** — error if either default's domain isn't valid for the email kind it would be used for.
- **Published templates** — error if any published template's `fromEmail` no longer satisfies the current `senderDomains` registry (typically after editing the registry post-publish).
- **CAN-SPAM postal address** — warning if `senderAddress` is unset and any marketing template has been published.
- **DOI template** — error if `requireDoubleOptIn: true` but no published template exists at `doiTemplateSlug`.

All-clear states are silent. The banner only renders when there's at least one warning or error to surface. Hit `GET /admin/mailer/api/setup-status` directly if you want to script against it (e.g., as part of a deploy-time health check).

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

The circuit breaker is scoped **per (sender domain × template kind)**. One bad subdomain doesn't hold mail for the others. When a bucket trips, only marketing sends from that (domain, kind) pair are held; transactional sends bypass entirely; other buckets keep flowing. Manual reset only — mailery never auto-resumes. See [Deliverability → Per-domain circuit breaker](./deliverability#per-domain-circuit-breaker).

## DNS block-list monitoring

```ts
{
  dnsbl: {
    domainLists: [                       // defaults shown
      { host: 'dbl.spamhaus.org', label: 'Spamhaus DBL' },
      { host: 'multi.surbl.org', label: 'SURBL' },
      { host: 'multi.uribl.com', label: 'URIBL' },
    ],
    ipLists: [                           // defaults shown — only used with dedicatedIps
      { host: 'zen.spamhaus.org', label: 'Spamhaus ZEN' },
      { host: 'b.barracudacentral.org', label: 'Barracuda' },
      { host: 'dnsbl.sorbs.net', label: 'SORBS' },
      { host: 'bl.spamcop.net', label: 'SpamCop' },
    ],
    dedicatedIps: [],                    // optional — IPs to query against ipLists
    intervalHours: 24,                   // 0 disables scheduled runs
  },
}
```

Daily DNS resolution of each sender domain (and any dedicated IPs) against the configured block lists. Results in `setup-status` + admin Health screen. No external API needed.

## Google Postmaster Tools

```ts
{
  postmaster: {
    clientId: process.env.GOOGLE_POSTMASTER_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_POSTMASTER_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_POSTMASTER_REFRESH_TOKEN!,
    domains: ['news.example.com'],       // optional — defaults to senderDomains + fromDefaults
    intervalHours: 24,
  },
}
```

Requires an OAuth refresh token with `https://www.googleapis.com/auth/postmaster.readonly` scope. Only meaningful at >100 sends/day to Gmail. Auto-trips the (domain × marketing) breaker when a domain falls to `BAD` reputation. See [Deliverability → Google Postmaster Tools](./deliverability#google-postmaster-tools).

## Microsoft SNDS

```ts
{
  snds: {
    accessKey: process.env.SNDS_ACCESS_KEY!,
    ips: ['203.0.113.5'],                // optional filter
    intervalHours: 24,
  },
}
```

Only meaningful if you send from a dedicated IP. Visibility-only — RED filter results surface in setup-status but don't auto-trip. JMRP enrolment is a separate manual step. See [Deliverability → Microsoft SNDS](./deliverability#microsoft-snds).

## DMARC ingestion

```ts
{
  dmarc: {
    knownSources: [                      // operator-provided baseline tags
      { ip: '149.72.45.10', label: 'SendGrid' },
      { ip: '203.0.113.99', label: 'Old marketing', ignored: true },
    ],
    retentionDays: 90,                   // failure rows older than this are pruned by an hourly housekeeping job
  },
}
```

Tags merge with the mutable `mailer_dmarc_source_tags` collection that the admin UI writes to. See [Deliverability → DMARC RUA report ingestion](./deliverability#dmarc-rua-report-ingestion).

## Mail-Tester (optional)

```ts
{
  mailTester: {
    apiKey: process.env.MAIL_TESTER_API_KEY!,
    minScore: 8.0,                       // default — publish blocks when below
    cacheHours: 24,                      // re-running same content within window is a no-op
    baseUrl: 'https://mail-tester.com/api',  // override for staging
  },
}
```

Enables the deliverability-check card in the template editor. Each check sends one real email via the default provider and consumes one Mail-Tester credit. Cache key is `(bodyHash, subject, fromEmail)`. See [Deliverability → Mail-Tester integration](./deliverability#mail-tester-integration-optional).

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
MAILER_MONGODB_URI          MAILER_REDIS_URL            (only when MAILER_QUEUE_DRIVER=bull, default)
MAILER_PUBLIC_URL           MAILER_UNSUBSCRIBE_SECRET
MAILER_SENDER_ADDRESS       MAILER_FROM_NAME / MAILER_FROM_EMAIL
MAILER_DEFAULT_PROVIDER     MAILER_SENDGRID_API_KEY / MAILER_SENDGRID_WEBHOOK_KEY
MAILER_QUEUE_DRIVER         'bull' (default) | 'agenda' | 'noop'
MAILER_HOST_USERS_COLLECTION (default 'users')
MAILER_HOST_USERS_EMAIL_FIELD (default 'email')
MAILER_HOST_USERS_ID_FIELD (default '_id')
MAILER_HOST_USERS_TAGS_FIELD
MAILER_HOST_USERS_TAGS_WRITABLE
```

For anything more elaborate (custom `toContact`, custom providers, hooks), use the programmatic `Mailer.init(...)`.
