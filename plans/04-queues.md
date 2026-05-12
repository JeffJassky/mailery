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

Three queues, each with a single worker:

| Queue | Purpose | Repeat? |
|---|---|---|
| `mailer:tick` | Periodic state-machine processor (event → flow_run, advance flow_runs, drain outbox, scheduled broadcasts, reconciliation) | Every 1 minute |
| `mailer:send` | Actual provider dispatch with retries | One-shot, per send |
| `mailer:webhook` | Process inbound webhook events asynchronously | One-shot |

### `mailer:tick`

Repeating job. Cron: `* * * * *`. Worker concurrency: 1 (single source of truth per process). Idempotent — multiple workers across a fleet are safe, only one will pick up a given job interval due to BullMQ's job ID dedupe (`jobId: 'mailer:tick'`).

Tick body: see `03-runner.md`.

### `mailer:send`

Each `send` step in a flow_run, and each broadcast recipient, enqueues a job here. The send worker:

1. Re-loads the `mailer_sends` document (status check — could have been cancelled)
2. Re-checks suppression (per `INVARIANTS.md`, suppression is always re-checked at send time, never trusted from enqueue time)
3. Re-checks circuit breaker (`mailer_health.status`)
4. Calls `provider.send(...)`
5. Updates the send record

Retries (built into BullMQ):

```ts
{
  attempts: 4,
  backoff: { type: 'exponential', delay: 60_000 },   // 1m, 5m, 25m, 125m
}
```

After 4 attempts the send is marked `failed`. The flow_run advances past this step (it doesn't block).

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
