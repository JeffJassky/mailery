/**
 * BullMQ wiring: four queues + the corresponding worker factories.
 *
 *  mailer:tick      → recovery sweep + event-trigger scan + scheduled broadcasts + outbox drain
 *  mailer:advance   → per-flow_run wakeup at nextActionAt (delayed jobs)
 *  mailer:send      → provider dispatch for a single send row
 *  mailer:webhook   → async normalization + apply of inbound provider events
 *
 * The Mailer class instantiates queues at init() and workers at startWorkers().
 * Job handlers themselves live in `runner/` and `api/webhook-processor.ts`.
 */

import { Queue, Worker, type QueueOptions, type WorkerOptions } from 'bullmq'
import IORedis, { type RedisOptions as IORedisOptions } from 'ioredis'

import type { RedisOptions } from '../config.js'

/**
 * Minimal queue surface the runner depends on. Production wraps BullMQ; tests
 * can supply a no-op implementation.
 */
export interface QueueAPI {
  add(name: string, data: unknown, opts?: { delay?: number; attempts?: number; backoff?: { type: 'exponential'; delay: number }; jobId?: string }): Promise<unknown>
  getWaitingCount(): Promise<number>
  close(): Promise<void>
}

export interface Queues {
  tick: QueueAPI
  advance: QueueAPI
  send: QueueAPI
  webhook: QueueAPI
}

function adaptBullQueue(q: Queue): QueueAPI {
  return {
    add: (name, data, opts) => q.add(name, data, opts),
    getWaitingCount: () => q.getWaitingCount(),
    close: () => q.close(),
  }
}

export function noopQueueAPI(): QueueAPI {
  return {
    add: async () => undefined,
    getWaitingCount: async () => 0,
    close: async () => undefined,
  }
}

export function noopQueues(): Queues {
  return {
    tick: noopQueueAPI(),
    advance: noopQueueAPI(),
    send: noopQueueAPI(),
    webhook: noopQueueAPI(),
  }
}

export interface QueueNames {
  tick: string
  advance: string
  send: string
  webhook: string
}

export function namespacedQueueNames(prefix: string): QueueNames {
  // BullMQ disallows `:` in queue names; use dashes for the namespace.
  void prefix
  return {
    tick: 'mailer-tick',
    advance: 'mailer-advance',
    send: 'mailer-send',
    webhook: 'mailer-webhook',
  }
}

export function makeRedis(opts: RedisOptions | IORedis): IORedis {
  // Pre-built instance — used by tests with ioredis-mock and by hosts that
  // want to share a connection with other parts of their app.
  if (isRedisLike(opts)) return opts

  const config: IORedisOptions = {
    maxRetriesPerRequest: null, // BullMQ requirement
    enableReadyCheck: false,
  }
  if (opts.url) {
    return new IORedis(opts.url, config)
  }
  return new IORedis({
    ...config,
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 6379,
    password: opts.password,
    db: opts.db,
    username: opts.username,
    tls: opts.tls ? {} : undefined,
  })
}

function isRedisLike(x: unknown): x is IORedis {
  return !!x && typeof x === 'object' && typeof (x as any).get === 'function' && typeof (x as any).set === 'function'
}

export function createQueues(redis: IORedis): { queues: Queues; bullQueues: BullQueues } {
  const names = namespacedQueueNames('')
  const qOpts: QueueOptions = { connection: redis }
  const bullQueues: BullQueues = {
    tick: new Queue(names.tick, qOpts),
    advance: new Queue(names.advance, qOpts),
    send: new Queue(names.send, qOpts),
    webhook: new Queue(names.webhook, qOpts),
  }
  return {
    queues: {
      tick: adaptBullQueue(bullQueues.tick),
      advance: adaptBullQueue(bullQueues.advance),
      send: adaptBullQueue(bullQueues.send),
      webhook: adaptBullQueue(bullQueues.webhook),
    },
    bullQueues,
  }
}

export interface BullQueues {
  tick: Queue
  advance: Queue
  send: Queue
  webhook: Queue
}

/** Register the repeating mailer-tick job. Idempotent (BullMQ dedupes by jobId). */
export async function scheduleTick(bullQueues: BullQueues, intervalSeconds: number): Promise<void> {
  await bullQueues.tick.upsertJobScheduler(
    'mailer-tick-repeat',
    { every: intervalSeconds * 1000 },
    { name: 'tick', data: {} },
  )
}

export interface CreateWorkersInput {
  redis: IORedis
  concurrency: { send: number }
  sendRateLimit?: { max: number; durationMs: number }
  handlers: {
    tick: (data: unknown) => Promise<void>
    advance: (data: { flowRunId: string }) => Promise<void>
    send: (data: { sendId: string }) => Promise<void>
    webhook: (data: { provider: string }) => Promise<void>
  }
}

export interface Workers {
  tick: Worker
  advance: Worker
  send: Worker
  webhook: Worker
}

export function createWorkers(input: CreateWorkersInput): Workers {
  const names = namespacedQueueNames('')
  const base: WorkerOptions = { connection: input.redis }

  const tick = new Worker(names.tick, async (job) => input.handlers.tick(job.data), {
    ...base,
    concurrency: 1, // single tick driver per worker process
  })

  const advance = new Worker(
    names.advance,
    async (job) => input.handlers.advance(job.data as any),
    { ...base, concurrency: 10 },
  )

  const sendOpts: WorkerOptions = {
    ...base,
    concurrency: input.concurrency.send,
    limiter: input.sendRateLimit
      ? { max: input.sendRateLimit.max, duration: input.sendRateLimit.durationMs }
      : undefined,
  }
  const send = new Worker(names.send, async (job) => input.handlers.send(job.data as any), sendOpts)

  const webhook = new Worker(
    names.webhook,
    async (job) => input.handlers.webhook(job.data as any),
    { ...base, concurrency: 4 },
  )

  return { tick, advance, send, webhook }
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all([queues.tick.close(), queues.advance.close(), queues.send.close(), queues.webhook.close()])
}

export async function closeBullQueues(b: BullQueues): Promise<void> {
  await Promise.all([b.tick.close(), b.advance.close(), b.send.close(), b.webhook.close()])
}

export async function closeWorkers(workers: Workers): Promise<void> {
  await Promise.all([workers.tick.close(), workers.advance.close(), workers.send.close(), workers.webhook.close()])
}
