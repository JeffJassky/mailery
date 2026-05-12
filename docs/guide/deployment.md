# Deployment

mailery is two processes from the same codebase: a **web** process that serves HTTP (admin UI + tracking endpoints + your business logic) and a **worker** process that runs queue consumers (flow advancement + send dispatch + webhook processing). The queue itself can be either BullMQ (Redis) or Agenda (Mongo) — see [Queue drivers](./queues).

## Why split?

- **Isolate failure modes.** A bad send template crashing the worker doesn't drop your HTTP requests.
- **Scale independently.** Web traffic and send volume don't correlate. Add web replicas for traffic; add worker replicas for send backlog.
- **Restart safely.** Workers can restart mid-batch without affecting users hitting your site.

You can run a single combined process during development — just don't set `workerless: true`.

## Web process

```ts
// server.ts
const mailer = await Mailer.init({
  // ...full config
  queue: { driver: 'bull', redis: { url: process.env.REDIS_URL! } },
  workerless: true,        // don't run queue workers in this process
})

const app = express()
app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))
app.use('/m', createPublicRouter(mailer))
// ...your routes
app.listen(PORT)
```

`workerless: true` skips the scheduled-tick job registration. Just creates queue clients so this process can ENQUEUE work; doesn't CONSUME it.

## Worker process

```ts
// worker.ts
const mailer = await Mailer.init({
  // ...same config (minus workerless)
})
await mailer.startWorkers()

// Graceful shutdown
process.on('SIGTERM', async () => {
  await mailer.stop()
  process.exit(0)
})
```

`startWorkers()` spins up queue consumers for tick / advance / send / webhook queues. Per-provider rate limits apply automatically (BullMQ enforces them globally via Redis; Agenda enforces them in-process via Bottleneck — see [Queue drivers](./queues) for the trade-off).

## Scaling

| Bottleneck | Knob |
|---|---|
| Slow flow advancement | More worker replicas. Each runs independent consumers; queue distributes work. (Bull driver only — Agenda is single-process.) |
| Slow send dispatch | More worker replicas, or raise `sendConcurrency` per worker. |
| Provider rate-limited | Per-provider `sendRatePerSecond` is the global cap across all workers (BullMQ group limiter; in-process Bottleneck for Agenda). |
| Slow Mongo queries | Standard Mongo scaling — read replicas for the admin UI dashboard, indexed queries (mailery's defaults are tight). |
| Big broadcasts | The broadcast worker streams the segment cursor; tune `broadcastEnqueueBatchSize` + `broadcastEnqueueMaxWaiting` to balance Redis memory vs throughput. |

## Required infrastructure

| | Required | Notes |
|---|---|---|
| Node | 20+ | LTS recommended. |
| MongoDB | 4.4+ | We test against 7.x. Replica set required only if you use transactions (`fireFromSession`). |
| Redis | 6+ | Required only for the Bull driver. AOF or RDB persistence recommended (not required — the tick can re-derive state from Mongo). Skip Redis entirely with `queue: { driver: 'agenda' }`. |
| Provider | SendGrid | Or Postmark / SES / Resend via custom provider. |

## Environment variables

Use `Mailer.fromEnv()` for a 12-factor setup:

```
MAILER_MONGODB_URI=mongodb://...
MAILER_REDIS_URL=redis://...
MAILER_PUBLIC_URL=https://yourdomain.com
MAILER_UNSUBSCRIBE_SECRET=<random 32+ bytes>
MAILER_SENDER_ADDRESS="12 Main Street, Brooklyn NY 11201, USA"
MAILER_FROM_NAME=Jeff
MAILER_FROM_EMAIL=hello@yourdomain.com
MAILER_DEFAULT_PROVIDER=sendgrid
MAILER_SENDGRID_API_KEY=...
MAILER_SENDGRID_WEBHOOK_KEY=...
MAILER_HOST_USERS_COLLECTION=users
MAILER_HOST_USERS_TAGS_FIELD=tags
MAILER_HOST_USERS_TAGS_WRITABLE=true
```

## Production checklist

- [ ] SPF, DKIM, DMARC configured on your sender domain
- [ ] `unsubscribeSecret` is a stable 32+ byte random string, stored in your secret manager
- [ ] Web process has `workerless: true`
- [ ] Separate worker process running `mailer.startWorkers()`
- [ ] Provider event webhook configured to POST to `/m/webhooks/<provider>`
- [ ] `/m/*` endpoints reachable from the public internet (NOT auth-gated)
- [ ] `/admin/mailer` gated by your existing auth
- [ ] Sentry / log sink wired to `onSendFailure` and `onCircuitBreakerTrip` hooks
- [ ] `circuitBreaker` thresholds tuned for your audience (defaults are reasonable starting points)
- [ ] Monitor queue depth (`mailer.queues.send.getWaitingCount()` etc.; Bull-Board recommended for Bull driver)
- [ ] Health-check endpoint that pings Mongo (and Redis if using Bull) + `/admin/mailer/api/health`

## Docker

A reasonable shape:

```yaml
# docker-compose.yml (dev)
services:
  app:
    build: .
    command: node --experimental-strip-types server.ts
    ports: ['3000:3000']
    environment:
      MONGODB_URI: mongodb://mongo:27017/myapp
      REDIS_URL: redis://redis:6379
      # ...
    depends_on: [mongo, redis]
  worker:
    build: .
    command: node --experimental-strip-types worker.ts
    environment:
      # same as app
    depends_on: [mongo, redis]
  mongo:
    image: mongo:7
    volumes: ['mongo-data:/data/db']
  redis:
    image: redis:7-alpine
    command: ['redis-server', '--appendonly', 'yes']
    volumes: ['redis-data:/data']
volumes:
  mongo-data:
  redis-data:
```

## What gets shipped in your bundle

mailery's npm package includes the prebuilt admin SPA at `dist/admin/spa/`. The `createAdminRouter()` serves it from there. You don't run Vite or any frontend build in your app — the SPA is shipped pre-compiled.

CSS + JS are content-hashed; the router serves them with `Cache-Control: public, max-age=31536000, immutable`. New mailery releases produce new hashes, automatically invalidating browser caches.
