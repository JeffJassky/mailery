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
 *
 * Retention: Agenda keeps every job document forever by default, which for a
 * mailer means one doc per send/advance/webhook accumulating in Mongo without
 * bound. Succeeded one-shot jobs are removed on completion (`removeOnComplete`);
 * failed ones are swept on an interval, since Agenda's auto-remove only fires
 * on success. The repeating tick is a single document whose `nextRunAt` is
 * recomputed in place, so it is never a source of growth — and the sweep
 * explicitly skips repeating jobs so it can't delete it.
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

/** Default jobs collection. Kept as-is when no prefix is configured. */
const DEFAULT_COLLECTION = '_mailerJobs'

/** How long a failed job document is kept before the sweep deletes it. */
const DEFAULT_FAILED_RETENTION_DAYS = 7

/** How often the failed-job sweep runs. */
const FAILED_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface AgendaDriverOptions {
  db: Db
  processEverySeconds?: number
  lockLifetimeSeconds?: number
  collectionName?: string
  /**
   * Namespaces the jobs collection so multiple mailery instances can share one
   * Mongo database — the Agenda counterpart to the Bull driver's Redis key
   * prefix. Ignored when `collectionName` is given explicitly.
   */
  prefix?: string
  /** Days to keep failed job documents. 0 disables the sweep. */
  failedJobRetentionDays?: number
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

    const collectionName = opts.collectionName ?? collectionFor(opts.prefix)
    const backend = new backendMod.MongoBackend({
      mongo: opts.db,
      collection: collectionName,
    })

    const agenda = new agendaMod.Agenda({
      backend,
      processEvery: `${opts.processEverySeconds ?? 5} seconds`,
      defaultLockLifetime: (opts.lockLifetimeSeconds ?? 10 * 60) * 1000,
      maxConcurrency: 50,
      defaultConcurrency: 5,
      // Drop succeeded one-shot jobs instead of retaining them forever.
      // Agenda guards this on `!nextRunAt`, so repeating jobs survive.
      removeOnComplete: true,
    } as any)

    const retentionDays = opts.failedJobRetentionDays ?? DEFAULT_FAILED_RETENTION_DAYS

    // The sweep filters on failedAt; without an index it's a collection scan
    // every hour. Non-fatal — a driver that can't index still works.
    try {
      await opts.db.collection(collectionName).createIndex({ failedAt: 1 }, { sparse: true })
    } catch (err) {
      console.error('mailery: could not index the Agenda jobs collection on failedAt', err)
    }

    return new AgendaDriver(agenda, agendaMod, opts.db, collectionName, retentionDays)
  }

  private db: Db
  private collName: string
  private failedRetentionDays: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  private constructor(
    agenda: Agenda,
    agendaMod: AgendaModule,
    db: Db,
    collectionName: string,
    failedRetentionDays: number,
  ) {
    this.agenda = agenda
    this.agendaMod = agendaMod
    this.db = db
    this.collName = collectionName
    this.failedRetentionDays = failedRetentionDays
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
    return this.db.collection(this.collName)
  }

  private async findPending(name: string, jobId: string): Promise<unknown> {
    return this.jobsCollection().findOne({
      name,
      'data.__jobId': jobId,
      $or: [{ lastFinishedAt: null }, { lastFinishedAt: { $exists: false } }],
    })
  }

  async scheduleRepeatingTick(intervalSeconds: number): Promise<void> {
    // Persist the repeating job only — do NOT start Agenda here. Starting with
    // a placeholder tick handler would let a process that never calls
    // startWorkers (API-only process in a web/worker split) lock and complete
    // tick jobs as no-ops, silently swallowing real ticks. Agenda starts in
    // startWorkers, after the real handlers are defined.
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
      this.startFailedJobSweep()
    }
  }

  /**
   * Agenda's auto-remove only fires on success, so failed documents would
   * otherwise be retained forever. Runs once on worker start, then hourly.
   */
  private startFailedJobSweep(): void {
    if (this.failedRetentionDays <= 0 || this.sweepTimer) return
    void this.sweepFailedJobs()
    this.sweepTimer = setInterval(() => void this.sweepFailedJobs(), FAILED_SWEEP_INTERVAL_MS)
    // Don't hold the event loop open on an otherwise-idle process.
    this.sweepTimer.unref?.()
  }

  /** Delete failed, fully-retired job documents older than the retention window. */
  async sweepFailedJobs(): Promise<number> {
    const cutoff = new Date(Date.now() - this.failedRetentionDays * 24 * 3600 * 1000)
    try {
      const res = await this.jobsCollection().deleteMany({
        failedAt: { $lt: cutoff },
        // Never touch the repeating tick.
        repeatInterval: { $in: [null, undefined] },
        // Leave anything still scheduled for a retry, and anything a worker
        // currently holds a lock on.
        $and: [
          { $or: [{ nextRunAt: null }, { nextRunAt: { $exists: false } }, { nextRunAt: { $lt: cutoff } }] },
          { $or: [{ lockedAt: null }, { lockedAt: { $exists: false } }, { lockedAt: { $lt: cutoff } }] },
        ],
      })
      return res.deletedCount ?? 0
    } catch (err) {
      console.error('mailery: failed-job sweep failed', err)
      return 0
    }
  }

  async stopWorkers(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
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

/**
 * Resolve the jobs collection from an optional prefix. No prefix keeps the
 * historical `_mailerJobs` name — changing that default would strand queued
 * jobs in the old collection on upgrade.
 */
export function collectionFor(prefix?: string): string {
  if (!prefix) return DEFAULT_COLLECTION
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
    throw new Error(
      `mailery: queue prefix "${prefix}" must contain only letters, digits, '_' or '-' — it becomes part of a MongoDB collection name.`,
    )
  }
  return `${DEFAULT_COLLECTION}_${prefix}`
}
