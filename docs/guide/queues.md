# Queue drivers

mailery's runner is driven by a background queue. Four named queues — `tick`, `advance`, `send`, `webhook` — coordinate flow advancement, sends, scheduled broadcasts, and webhook processing.

You choose the driver at `Mailer.init`:

```ts
queue: { driver: 'bull', redis: { url: 'redis://...' } }   // production default
queue: { driver: 'agenda' }                                 // no Redis required
queue: { driver: 'noop' }                                   // tests / synchronous-only hosts
```

## When to pick which

| Driver | Backed by | When to use |
|---|---|---|
| **bull** | BullMQ + Redis | Default. Mature, fast, well-instrumented. Pick this unless you have a reason not to. |
| **agenda** | `agenda` + `@agendajs/mongo-backend` on your existing Mongo | Single-process deployments that don't want a second datastore. |
| **noop** | Nothing | Tests + hosts driving the runner synchronously. Job adds are no-ops. |

### Bull

```ts
import { Mailer } from 'mailery'

await Mailer.init({
  // ...
  queue: { driver: 'bull', redis: { url: process.env.REDIS_URL! } },
})
```

Install the peer deps:

```bash
npm install bullmq ioredis
```

What you get:
- Job-level `attempts` + exponential `backoff`, durable in Redis.
- `jobId`-based dedupe for delayed advance jobs.
- BullMQ's `limiter` enforcing the global send rate via Redis Lua script — correct across multiple worker processes.

#### Namespacing multiple instances (`prefix`)

All of mailery's Redis keys live under a prefix (BullMQ's default is `bull`).
When several mailery instances share one Redis cluster — most commonly local /
dev / staging / prod environments — give each its own prefix so their queues,
workers, and the repeating tick can't see each other's jobs:

```ts
queue: {
  driver: 'bull',
  redis: { url: process.env.REDIS_URL! },
  prefix: `mailery-${process.env.NODE_ENV}`,   // e.g. 'mailery-dev'
}
```

The prefix must not contain `:` (BullMQ's key separator) — `Mailer.init`
rejects it. Changing the prefix orphans any jobs under the old one; drain
before switching, as with a [driver swap](#switching-drivers). With
`Mailer.fromEnv`, set `MAILER_QUEUE_PREFIX`.

### Agenda

```ts
import { Mailer } from 'mailery'

await Mailer.init({
  // ...
  queue: { driver: 'agenda' },     // uses the same `db` you passed to Mailer.init
})
```

Install the peer deps:

```bash
npm install agenda @agendajs/mongo-backend bottleneck
```

What you get:
- Jobs persisted to a `_mailerJobs` collection in your Mongo.
- Built-in retry + exponential backoff (Agenda 6.x).
- Job dedupe via a synthetic `__jobId` key.
- Send rate limit enforced **in-process** via [Bottleneck](https://www.npmjs.com/package/bottleneck).

::: warning Single-process only
The Agenda driver's rate limiter is in-memory. If you run multiple worker processes against the same Mongo, each enforces the limit independently — actual provider rate will be `N × sendRatePerSecond`. Run a single worker process when using this driver, or switch to Bull, which uses Redis to coordinate globally.
:::

### Noop

```ts
queue: { driver: 'noop' }
```

No deps. Job-add calls are no-ops. Useful when you drive the runner yourself:

```ts
import { runTick, processOneRunStep, dispatchSend } from 'mailery'

await runTick(mailer.getRunnerContext())
```

`mailery/testing`'s `createTestMailer` uses this driver by default.

## What flows through which queue

| Queue | Triggered by | Handler |
|---|---|---|
| `tick` | Repeating every `tickIntervalSeconds` | Event-trigger scan, stranded-run sweep, stranded-send sweep, outbox drain, scheduled broadcasts, health rollup, soft-bounce promotion |
| `advance` | Flow `wait` step expiry, condition retry, webhook step retry, event trigger | Process one step of a flow run |
| `send` | `handleSend` (from flow), `mailer.sendOneOff(...)`, broadcast dispatch | Render, suppression check, provider dispatch, update tracking |
| `webhook` | Inbound provider webhook ingestion | Apply normalized event (bounce / complaint / delivered / open / click) |

## Crash safety

Both Bull and Agenda persist jobs durably (Redis / Mongo respectively). On worker crash:
- Locks have TTLs; stalled jobs return to the pending set automatically.
- Delayed jobs persist their scheduled time — if the worker is down past the fire-at, the job runs on next start.
- The tick's `sweepStrandedFlowRuns` and `sweepStrandedSends` catch state stranded by data loss or partial writes.

See [Deliverability](./deliverability) for the application-level invariants (dedupeKey, suppression-at-send-time, idempotent provider calls).

## Switching drivers

Drivers don't share state. If you're moving from Bull → Agenda you'll want to:
1. Drain the Bull queues (let them empty before swap).
2. Update the `queue` config and restart workers.
3. Optionally drop the BullMQ Redis namespace afterwards.

State that survives the swap (subscriptions, sends, flow runs, etc.) lives in mailery's Mongo collections and is queue-agnostic.
