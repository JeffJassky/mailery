/**
 * Queue driver abstraction. Mailer talks to a `QueueDriver` whose only required
 * vocabulary is "add a job to one of four named queues" and "spin up a worker
 * per queue with these handlers." Concrete drivers (BullMQ, @hokify/agenda,
 * noop) implement this surface.
 *
 * Mailery targets single-process deployments; drivers are not expected to
 * coordinate state across processes. Rate-limit semantics are documented per
 * driver below.
 */

import type IORedis from 'ioredis'
import type { Db } from 'mongodb'

import type { RedisOptions } from '../config.js'

/** Per-call options passed to `queue.add(name, data, opts)`. */
export interface AddOptions {
  /** Defer execution by this many ms. */
  delay?: number
  /** Max attempts including the initial run. Driver may apply per-define instead of per-add. */
  attempts?: number
  /** Exponential backoff base delay (ms). Driver may apply per-define instead of per-add. */
  backoff?: { type: 'exponential'; delay: number }
  /** Idempotency key: if a pending job with this id already exists for this queue, the add is a no-op. */
  jobId?: string
}

export interface QueueAPI {
  add(name: string, data: unknown, opts?: AddOptions): Promise<unknown>
  /** Approximate count of jobs eligible-but-not-running. Used by broadcast backpressure. */
  getWaitingCount(): Promise<number>
  /** Active + waiting jobs (runnable now). Returns null when the driver can't expose it. */
  getInFlightCount?(): Promise<number | null>
  /** Delayed jobs scheduled for the future. Returns null when unsupported. */
  getDelayedCount?(): Promise<number | null>
  close(): Promise<void>
}

export interface Queues {
  tick: QueueAPI
  advance: QueueAPI
  send: QueueAPI
  webhook: QueueAPI
}

export interface QueueHandlers {
  tick: (data: unknown) => Promise<void>
  advance: (data: { flowRunId: string }) => Promise<void>
  send: (data: { sendId: string }) => Promise<void>
  webhook: (data: { provider: string }) => Promise<void>
}

export interface WorkerStartOptions {
  concurrency: { send: number }
  /** Cap sends to `max` per `durationMs`. Bull enforces this globally via Redis; Agenda enforces in-process via Bottleneck (single-process only). */
  sendRateLimit?: { max: number; durationMs: number }
  /** Max attempts for retryable jobs (send, advance, webhook). */
  retryAttempts: number
  handlers: QueueHandlers
}

export interface QueueDriver {
  readonly queues: Queues
  /** Register the repeating mailer-tick job. Idempotent. */
  scheduleRepeatingTick(intervalSeconds: number): Promise<void>
  startWorkers(opts: WorkerStartOptions): Promise<void>
  stopWorkers(): Promise<void>
  close(): Promise<void>
}

/**
 * Driver selection at Mailer.init time. The driver and its connection are
 * declared explicitly rather than inferred — this keeps the wiring obvious and
 * lets hosts mix-and-match (e.g. Bull in prod, noop in tests).
 */
export type QueueDriverConfig =
  | { driver: 'bull'; redis: RedisOptions | IORedis }
  | { driver: 'agenda'; db?: Db; processEverySeconds?: number; lockLifetimeSeconds?: number; collectionName?: string }
  | { driver: 'noop' }
