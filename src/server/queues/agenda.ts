/**
 * Agenda driver. Backed by the same MongoDB instance the rest of mailery uses,
 * so no Redis is required. Uses `agenda` + `@agendajs/mongo-backend`.
 *
 * Single-process only: send rate limit is enforced via an in-memory Bottleneck
 * wrapped around the send handler. Multi-process Agenda deployments would
 * fan-out beyond the rate cap — out of scope.
 *
 * Retry/backoff: applied per-definition via Agenda's built-in
 * `backoffStrategies.exponential`. Per-call `attempts` from add() is ignored;
 * the driver uses the shared config-level `sendRetryAttempts`.
 *
 * Idempotency: per-call `jobId` is stored as `data.__jobId`. Before scheduling
 * we look for a pending (not-yet-run, not-finished) job with the same key.
 */

import type { Db } from 'mongodb'
import type { Agenda, Job } from 'agenda'
import type Bottleneck from 'bottleneck'

import type {
  AddOptions,
  QueueAPI,
  QueueDriver,
  Queues,
  WorkerStartOptions,
} from './types.js'

interface AgendaModule {
  Agenda: typeof Agenda
  backoffStrategies: { exponential: (opts: { delay: number; maxRetries: number; factor?: number }) => any }
}

interface MongoBackendModule {
  MongoBackend: new (cfg: { mongo: Db; collection?: string; ensureIndex?: boolean }) => any
}

interface BottleneckCtor {
  new (opts: { minTime?: number; maxConcurrent?: number }): Bottleneck
}

const QUEUE_NAMES = {
  tick: 'mailer-tick',
  advance: 'mailer-advance',
  send: 'mailer-send',
  webhook: 'mailer-webhook',
} as const

export interface AgendaDriverOptions {
  db: Db
  processEverySeconds?: number
  lockLifetimeSeconds?: number
  collectionName?: string
}

export class AgendaDriver implements QueueDriver {
  readonly queues: Queues
  private agenda: Agenda
  private agendaMod: AgendaModule
  private sendLimiter: Bottleneck | null = null
  private started = false

  static async create(opts: AgendaDriverOptions): Promise<AgendaDriver> {
    let agendaMod: AgendaModule
    let backendMod: MongoBackendModule
    try {
      agendaMod = (await import('agenda')) as unknown as AgendaModule
      backendMod = (await import('@agendajs/mongo-backend')) as unknown as MongoBackendModule
    } catch {
      throw new Error(
        "mailery: queue driver 'agenda' requires the 'agenda' and '@agendajs/mongo-backend' peer dependencies. Run `npm install agenda @agendajs/mongo-backend bottleneck`.",
      )
    }

    const backend = new backendMod.MongoBackend({
      mongo: opts.db,
      collection: opts.collectionName ?? '_mailerJobs',
    })

    const agenda = new agendaMod.Agenda({
      backend,
      processEvery: `${opts.processEverySeconds ?? 5} seconds`,
      defaultLockLifetime: (opts.lockLifetimeSeconds ?? 10 * 60) * 1000,
      maxConcurrency: 50,
      defaultConcurrency: 5,
    } as any)

    return new AgendaDriver(agenda, agendaMod, opts.db)
  }

  private db: Db

  private constructor(agenda: Agenda, agendaMod: AgendaModule, db: Db) {
    this.agenda = agenda
    this.agendaMod = agendaMod
    this.db = db
    this.queues = {
      tick: this.makeQueueAPI(QUEUE_NAMES.tick),
      advance: this.makeQueueAPI(QUEUE_NAMES.advance),
      send: this.makeQueueAPI(QUEUE_NAMES.send),
      webhook: this.makeQueueAPI(QUEUE_NAMES.webhook),
    }
  }

  private makeQueueAPI(name: string): QueueAPI {
    return {
      add: async (_jobName: string, data: unknown, opts?: AddOptions) => {
        const payload: Record<string, unknown> = { ...(data as object) }
        if (opts?.jobId) {
          payload.__jobId = opts.jobId
          if (await this.findPending(name, opts.jobId)) return
        }
        const job = this.agenda.create(name, payload as any)
        if (opts?.delay) job.schedule(new Date(Date.now() + opts.delay))
        await job.save()
      },
      getWaitingCount: async () => {
        return this.jobsCollection().countDocuments({
          name,
          $or: [{ lockedAt: null }, { lockedAt: { $exists: false } }],
          nextRunAt: { $lte: new Date() },
        })
      },
      close: async () => {},
    }
  }

  /** Direct access to the Mongo collection Agenda persists jobs into. */
  private jobsCollection() {
    return this.db.collection(this.collectionName())
  }

  private collectionName(): string {
    // We set this on the backend; the field isn't exposed publicly so we keep it in sync.
    return '_mailerJobs'
  }

  private async findPending(name: string, jobId: string): Promise<unknown> {
    return this.jobsCollection().findOne({
      name,
      'data.__jobId': jobId,
      $or: [{ lastFinishedAt: null }, { lastFinishedAt: { $exists: false } }],
    })
  }

  async scheduleRepeatingTick(intervalSeconds: number): Promise<void> {
    if (!this.started) {
      // Define tick first so Agenda knows about it before start.
      // We'll re-define it during startWorkers() with the real handler; until
      // then this is a no-op handler that the tick should never actually run.
      this.agenda.define(QUEUE_NAMES.tick, async () => {}, { concurrency: 1 })
      await this.agenda.start()
      this.started = true
    }
    await this.agenda.every(`${intervalSeconds} seconds`, QUEUE_NAMES.tick)
  }

  async startWorkers(opts: WorkerStartOptions): Promise<void> {
    const exp = this.agendaMod.backoffStrategies.exponential

    if (opts.sendRateLimit) {
      try {
        const Bottleneck = (await import('bottleneck')).default as unknown as BottleneckCtor
        this.sendLimiter = new Bottleneck({
          minTime: Math.ceil(opts.sendRateLimit.durationMs / opts.sendRateLimit.max),
          maxConcurrent: opts.concurrency.send,
        })
      } catch {
        throw new Error(
          "mailery: queue driver 'agenda' with sendRateLimit requires the 'bottleneck' peer dependency. Run `npm install bottleneck`.",
        )
      }
    }

    const retryBackoff = exp({ delay: 60_000, maxRetries: Math.max(0, opts.retryAttempts - 1), factor: 2 })

    this.agenda.define(QUEUE_NAMES.tick, async (job: Job) => {
      await opts.handlers.tick(job.attrs.data)
    }, { concurrency: 1 })

    this.agenda.define(QUEUE_NAMES.advance, async (job: Job) => {
      await opts.handlers.advance(job.attrs.data as any)
    }, { concurrency: 10, backoff: retryBackoff })

    this.agenda.define(QUEUE_NAMES.send, async (job: Job) => {
      const data = job.attrs.data as any
      if (this.sendLimiter) {
        await this.sendLimiter.schedule(() => opts.handlers.send(data))
      } else {
        await opts.handlers.send(data)
      }
    }, { concurrency: opts.concurrency.send, backoff: retryBackoff })

    this.agenda.define(QUEUE_NAMES.webhook, async (job: Job) => {
      await opts.handlers.webhook(job.attrs.data as any)
    }, { concurrency: 4, backoff: retryBackoff })

    if (!this.started) {
      await this.agenda.start()
      this.started = true
    }
  }

  async stopWorkers(): Promise<void> {
    if (!this.started) return
    await this.agenda.stop()
    this.started = false
    if (this.sendLimiter) {
      await this.sendLimiter.stop({ dropWaitingJobs: true }).catch(() => {})
      this.sendLimiter = null
    }
  }

  async close(): Promise<void> {
    await this.stopWorkers()
  }
}
