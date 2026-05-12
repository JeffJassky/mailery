/**
 * BullMQ driver. Four named queues backed by Redis. Job-level `attempts`,
 * `backoff`, `delay`, and `jobId` pass through to BullMQ's native semantics.
 * Send rate limit is enforced via BullMQ's `limiter` option (Redis Lua script).
 */

import type { Queue, Worker } from 'bullmq'
import IORedis, { type RedisOptions as IORedisOptions } from 'ioredis'

import type { RedisOptions } from '../config.js'
import type {
  AddOptions,
  QueueAPI,
  QueueDriver,
  Queues,
  WorkerStartOptions,
} from './types.js'

interface BullQueues {
  tick: Queue
  advance: Queue
  send: Queue
  webhook: Queue
}

interface BullModule {
  Queue: typeof Queue
  Worker: typeof Worker
}

const QUEUE_NAMES = {
  tick: 'mailer-tick',
  advance: 'mailer-advance',
  send: 'mailer-send',
  webhook: 'mailer-webhook',
} as const

export class BullDriver implements QueueDriver {
  readonly queues: Queues
  private redis: IORedis
  private bullQueues: BullQueues
  private workers: { tick: Worker; advance: Worker; send: Worker; webhook: Worker } | null = null
  private bull: BullModule

  static async create(redisConfig: RedisOptions | IORedis): Promise<BullDriver> {
    let bull: BullModule
    try {
      bull = (await import('bullmq')) as unknown as BullModule
    } catch {
      throw new Error(
        "mailery: queue driver 'bull' requires the 'bullmq' peer dependency. Run `npm install bullmq ioredis`.",
      )
    }
    const redis = isRedisLike(redisConfig) ? (redisConfig as IORedis) : connect(redisConfig as RedisOptions)
    return new BullDriver(bull, redis)
  }

  private constructor(bull: BullModule, redis: IORedis) {
    this.bull = bull
    this.redis = redis
    const opts = { connection: redis }
    this.bullQueues = {
      tick: new bull.Queue(QUEUE_NAMES.tick, opts),
      advance: new bull.Queue(QUEUE_NAMES.advance, opts),
      send: new bull.Queue(QUEUE_NAMES.send, opts),
      webhook: new bull.Queue(QUEUE_NAMES.webhook, opts),
    }
    this.queues = {
      tick: adaptBullQueue(this.bullQueues.tick),
      advance: adaptBullQueue(this.bullQueues.advance),
      send: adaptBullQueue(this.bullQueues.send),
      webhook: adaptBullQueue(this.bullQueues.webhook),
    }
  }

  async scheduleRepeatingTick(intervalSeconds: number): Promise<void> {
    await (this.bullQueues.tick as any).upsertJobScheduler(
      'mailer-tick-repeat',
      { every: intervalSeconds * 1000 },
      { name: 'tick', data: {} },
    )
  }

  async startWorkers(opts: WorkerStartOptions): Promise<void> {
    if (this.workers) return
    const base = { connection: this.redis }
    const { Worker } = this.bull

    const tick = new Worker(
      QUEUE_NAMES.tick,
      async (job: any) => opts.handlers.tick(job.data),
      { ...base, concurrency: 1 },
    )
    const advance = new Worker(
      QUEUE_NAMES.advance,
      async (job: any) => opts.handlers.advance(job.data),
      { ...base, concurrency: 10 },
    )
    const send = new Worker(
      QUEUE_NAMES.send,
      async (job: any) => opts.handlers.send(job.data),
      {
        ...base,
        concurrency: opts.concurrency.send,
        limiter: opts.sendRateLimit
          ? { max: opts.sendRateLimit.max, duration: opts.sendRateLimit.durationMs }
          : undefined,
      },
    )
    const webhook = new Worker(
      QUEUE_NAMES.webhook,
      async (job: any) => opts.handlers.webhook(job.data),
      { ...base, concurrency: 4 },
    )

    this.workers = { tick, advance, send, webhook }
  }

  async stopWorkers(): Promise<void> {
    if (!this.workers) return
    await Promise.all([
      this.workers.tick.close(),
      this.workers.advance.close(),
      this.workers.send.close(),
      this.workers.webhook.close(),
    ])
    this.workers = null
  }

  async close(): Promise<void> {
    await this.stopWorkers()
    await Promise.all([
      this.bullQueues.tick.close(),
      this.bullQueues.advance.close(),
      this.bullQueues.send.close(),
      this.bullQueues.webhook.close(),
    ])
  }
}

function adaptBullQueue(q: Queue): QueueAPI {
  return {
    add: (name, data, opts) => q.add(name, data as any, opts as any),
    getWaitingCount: () => q.getWaitingCount(),
    getInFlightCount: async () => {
      const [active, waiting] = await Promise.all([q.getActiveCount(), q.getWaitingCount()])
      return active + waiting
    },
    getDelayedCount: () => q.getDelayedCount(),
    close: () => q.close(),
  }
}

function isRedisLike(x: unknown): boolean {
  return !!x && typeof x === 'object' && typeof (x as any).get === 'function' && typeof (x as any).set === 'function'
}

function connect(opts: RedisOptions): IORedis {
  const config: IORedisOptions = {
    maxRetriesPerRequest: null, // BullMQ requirement
    enableReadyCheck: false,
  }
  if (opts.url) return new IORedis(opts.url, config)
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

// Re-exports needed by the broader queue surface
export type { AddOptions }
