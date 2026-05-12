# 04 — Queue (BullMQ)

The runner needs scheduling. The library uses **BullMQ** exclusively. No queue abstraction layer.

## Why BullMQ only?

Earlier drafts had a queue interface with Agenda and BullMQ adapters. Dropped for these reasons:

- **One queue is one less concept to learn.** Adapter layers tend to expose the lowest-common-denominator of underlying systems and obscure useful provider-specific features.
- **BullMQ is the right call at our scale.** Redis is fast, BullMQ is battle-tested, the operational tooling (Bull-Board) is excellent.
- **Host apps can still use Agenda for their own jobs.** Mailer's queue is independent of the host's. Mailer brings its own BullMQ worker; the host keeps its own scheduling for non-mailer work.
- **Redis is cheap.** A small Redis instance is $10/mo on most providers. For an app running email automation in production, that's not a meaningful cost.

If a host genuinely cannot run Redis (rare in modern Node + Mongo SaaS), they can hold off adopting this library — or implement a Mongo-backed shim against the BullMQ API. The library doesn't try to be all things to all infrastructures.

## Required infrastructure

A Redis instance. Configured via:

```ts
new Mailer({
  redis: {
    host: 'localhost',
    port: 6379,
    password: process.env.REDIS_PASSWORD,
    // or a URL:
    // url: process.env.REDIS_URL
  },
})
```

Mailer internally wraps this in an `ioredis` connection used by BullMQ.

## Queue layout

Four queues:

| Queue | Purpose | Trigger |
|---|---|---|
| `mailer:tick` | Recovery sweep + event-trigger scan + broadcast dispatch + outbox drain + reconciliation | Repeating, every 1 minute |
| `mailer:advance` | Wake a specific flow_run at its `nextActionAt` | Delayed job, scheduled when a `wait` step starts |
| `mailer:send` | Provider dispatch for a single send row | One-shot, enqueued by the runner's send step |
| `mailer:webhook` | Process inbound provider webhook events asynchronously | One-shot, enqueued by the webhook endpoint |

### `mailer:tick`

Repeating job. Cron: `* * * * *`. Worker concurrency: 1 per process. Idempotent across a fleet via BullMQ's `jobId` dedupe (`jobId: 'mailer:tick'`).

Tick body — see `03-runner.md`:
1. `processNewlyFiredEventTriggers()` — scan `mailer_events` since `flow.lastTriggerScanAt`, create `flow_runs` for new matches.
2. `sweepStrandedFlowRuns()` — find `flow_runs` with `nextActionAt <= now` that didn't get woken by their delayed job (worker restart, BullMQ data loss).
3. `processScheduledBroadcasts()` — dispatch broadcasts whose `scheduledAt` has passed.
4. `drainOutbox()` — promote outbox rows committed by host transactions.
5. `rollupStats()` (every 15 min) — denormalized counters on `mailer_templates` and `mailer_flows`.
6. `reconcileWebhookEvents()` (daily) — pull provider Events API for the last 24h, fill gaps.

### `mailer:advance`

One-shot delayed job. Enqueued by `handleWait` (`03-runner.md`) with `delay: ms` matching the wait step's duration. Also enqueued without delay after `handleBranch`, `handleCondition` (when advancing), and after a new flow_run is created — so the runner advances immediately, not on the next minute boundary.

Worker re-loads the run and calls `processOneRunStep`. The tick's recovery sweep covers any wakeup that BullMQ loses.

### `mailer:send`

Each `send` step (and each broadcast recipient) creates a `mailer_sends` row with `status: 'queued'` and enqueues a job here. The send worker:

1. Re-loads the `mailer_sends` document (status check — could have been cancelled).
2. Re-checks suppression by `(emailAtSend, scope-for-kind)` — `INVARIANTS.md` rule 3.
3. Re-checks circuit breaker (`mailer_health.status`) — marketing held when tripped, transactional bypasses (`INVARIANTS.md` rule 6).
4. Applies tracking rewrites (open pixel, click links) using `sendId`.
5. Calls `provider.send(...)`.
6. Updates the send record (`status: 'sent'`, `providerMessageId`, `sentAt`).

Retries (built into BullMQ):

```ts
{
  attempts: 4,
  backoff: { type: 'exponential', delay: 60_000 },   // 1m, 5m, 25m, 125m
}
```

After 4 attempts the send is marked `failed`. The flow_run already advanced past this step at enqueue time, so failed sends do not block subsequent steps.

#### Per-provider rate limiting

Each provider has a `sendRatePerSecond` (default 10/sec for SendGrid shared IPs; configure higher on dedicated IPs). The send worker is configured with BullMQ's group limiter, keyed by provider name:

```ts
new Worker('mailer:send', handler, {
  limiter: { max: provider.sendRatePerSecond, duration: 1000, groupKey: 'provider' },
})
```

Jobs over the limit sit in BullMQ's delayed set until they can run. Going above provider limits tanks reputation faster than almost anything else.

#### Broadcast enqueue

Broadcasts can have hundreds of thousands of recipients. Naive enqueue creates one BullMQ job per recipient up front, spiking Redis memory. The broadcast worker instead **streams** the segment cursor and bulk-enqueues in pages of `broadcastEnqueueBatchSize` (default 1000), pausing when the queue's waiting-count exceeds `broadcastEnqueueMaxWaiting` (default 5000):

```ts
async function dispatchBroadcast(broadcast) {
  const cursor = adapter.query(broadcast.segmentDefinition.filters, { limit: 1000 })
  for await (const batch of cursor) {
    while ((await queue.send.getWaitingCount()) > config.broadcastEnqueueMaxWaiting) {
      await sleep(2000)
    }
    await queue.send.addBulk(batch.map(c => ({ name: 'send', data: prepareSend(broadcast, c) })))
  }
}
```

This keeps Redis memory bounded and lets the rate limiter shape actual outflow.

### `mailer:webhook`

Inbound provider webhooks land at the public HTTP endpoint. The handler verifies the signature, dedupes against `mailer_webhook_events`, and enqueues processing onto `mailer:webhook` for async handling. This decouples HTTP latency from DB work.

## Worker model

The library exposes a single function:

```ts
await mailer.startWorkers()
```

…which spins up workers for all three queues, returns when they're ready. Call once at host startup, after all flows and templates have been loaded.

To run workers on a separate process (recommended for production):

```ts
// worker.ts
const mailer = await Mailer.init({ /* same config as web */ })
await mailer.startWorkers()
// keep alive forever
```

The web process can be configured with `workerless: true` to skip worker startup:

```ts
const mailer = await Mailer.init({ /* ... */ workerless: true })
```

Web still handles tracking endpoints, admin UI, and `fire()`/`upsertSubscription()` calls (which write to outbox / events / subscriptions). The worker process picks up the work.

## Direct BullMQ access

For ops, mailer exposes the underlying queues:

```ts
mailer.queues.tick     // BullMQ Queue instance
mailer.queues.advance
mailer.queues.send
mailer.queues.webhook
```

This lets you mount Bull-Board, inspect failed jobs, drain queues manually, etc. The library doesn't wrap BullMQ's API — operators interact with it directly when needed.

## Failure modes

| Failure | Behavior |
|---|---|
| Redis unreachable | Library logs error every tick; events still write to `mailer_outbox` if the host uses the outbox pattern; nothing sends; alerts fire |
| Worker process dies | BullMQ marks jobs as stalled, re-queues after stall timeout (30s default); another worker (or the restarted process) picks them up |
| Tick crashes mid-iteration | Whatever steps had been advanced are persisted; remaining work picks up next tick (state lives in Mongo) |
| BullMQ job exceeds retry attempts | Job moves to BullMQ's failed set; alert fires; operator inspects via Bull-Board |

## Operational notes

- Run at least 2 worker processes in production for HA.
- Set `concurrency` per worker to match send throughput needs (default 5).
- Monitor `mailer:send` failed-set size — anything sustained > 0 means a provider problem.
- Redis persistence (AOF or RDB snapshots) is recommended but not required — the worst case if Redis loses data is dropped scheduled-job records, which the tick will re-derive from Mongo state on the next minute.
