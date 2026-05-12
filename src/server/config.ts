/**
 * Mailer configuration shape. Required + optional surfaces with sane defaults.
 */

import type { Db } from 'mongodb'
import type Handlebars from 'handlebars'
import type {
  ContactAdapter,
  MailProvider,
} from '../shared/types.js'
import type { QueueDriverConfig } from './queues/types.js'

export interface RedisOptions {
  host?: string
  port?: number
  password?: string
  url?: string
  db?: number
  username?: string
  tls?: boolean
}

export interface CircuitBreakerThresholds {
  /** Trip when last-hour hard-bounce rate >= this percent (e.g. 2 = 2%). */
  hardBounceRatePctTrip: number
  complaintRatePctTrip: number
  combinedBounceRatePctTrip: number
  failedToSendRatePctDegrade: number
  windowMinutes: number
  minSendsBeforeEval: number
}

export interface MailerConfig {
  // ---- Storage --------------------------------------------------------------
  db: Db
  collectionPrefix?: string
  adapter: ContactAdapter

  // ---- Queue ----------------------------------------------------------------
  /**
   * Queue driver selection. One of:
   *   - `{ driver: 'bull', redis: ... }` — BullMQ (default for prod; requires Redis)
   *   - `{ driver: 'agenda' }` — @hokify/agenda using this Mongo (no Redis required, single-process)
   *   - `{ driver: 'noop' }` — no background workers (tests, synchronous-only hosts)
   */
  queue: QueueDriverConfig

  // ---- Providers ------------------------------------------------------------
  providers: Record<string, MailProvider>
  defaultProvider: string
  defaultTransactionalProvider?: string

  // ---- Identity / URLs ------------------------------------------------------
  publicUrl: string
  unsubscribeSecret: string
  senderAddress?: string
  fromDefaults?: { name: string; email: string }
  transactionalFromDefaults?: { name: string; email: string }

  // ---- Compliance -----------------------------------------------------------
  requireDoubleOptIn?: boolean
  unsubscribeTokenLifetimeDays?: number
  transactionalRespectUnsubscribe?: boolean
  /** Slug of the transactional template sent for DOI confirmation. Defaults to 'doi-confirmation'. */
  doiTemplateSlug?: string
  /** How long the DOI token stays valid. Default 7 days. */
  doiTokenLifetimeDays?: number

  // ---- Circuit breaker ------------------------------------------------------
  circuitBreaker?: Partial<CircuitBreakerThresholds>

  // ---- Broadcast safety + throughput ---------------------------------------
  broadcastConfirmationThreshold?: number
  broadcastEnqueueBatchSize?: number
  broadcastEnqueueMaxWaiting?: number

  // ---- Worker behavior ------------------------------------------------------
  workerless?: boolean
  tickIntervalSeconds?: number
  sendConcurrency?: number
  sendRatePerSecond?: number
  softBouncePromotionThreshold?: number
  softBouncePromotionWindowDays?: number
  webhookRetryAttempts?: number
  sendRetryAttempts?: number

  // ---- Tracking -------------------------------------------------------------
  trackOpens?: boolean
  trackClicks?: boolean
  storeTrackingIp?: boolean
  storeRenderedBody?: boolean

  // ---- Hooks ----------------------------------------------------------------
  getAdminActor?: (req: any) => string
  onCircuitBreakerTrip?: (info: { reason: string; rates: Record<string, number> }) => Promise<void> | void
  onSendFailure?: (info: { send: any; error: Error }) => Promise<void> | void
  handlebarsHelpers?: Record<string, Handlebars.HelperDelegate>
}

export type ResolvedConfig = Required<
  Pick<
    MailerConfig,
    | 'collectionPrefix'
    | 'requireDoubleOptIn'
    | 'unsubscribeTokenLifetimeDays'
    | 'transactionalRespectUnsubscribe'
    | 'doiTemplateSlug'
    | 'doiTokenLifetimeDays'
    | 'broadcastConfirmationThreshold'
    | 'broadcastEnqueueBatchSize'
    | 'broadcastEnqueueMaxWaiting'
    | 'workerless'
    | 'tickIntervalSeconds'
    | 'sendConcurrency'
    | 'sendRatePerSecond'
    | 'softBouncePromotionThreshold'
    | 'softBouncePromotionWindowDays'
    | 'webhookRetryAttempts'
    | 'sendRetryAttempts'
    | 'trackOpens'
    | 'trackClicks'
    | 'storeTrackingIp'
    | 'storeRenderedBody'
  >
> & {
  circuitBreaker: CircuitBreakerThresholds
} & MailerConfig

export const DEFAULTS = {
  collectionPrefix: 'mailer_',
  requireDoubleOptIn: false,
  unsubscribeTokenLifetimeDays: 90,
  transactionalRespectUnsubscribe: false,
  doiTemplateSlug: 'doi-confirmation',
  doiTokenLifetimeDays: 7,
  broadcastConfirmationThreshold: 1000,
  broadcastEnqueueBatchSize: 1000,
  broadcastEnqueueMaxWaiting: 5000,
  workerless: false,
  tickIntervalSeconds: 60,
  sendConcurrency: 5,
  sendRatePerSecond: 10,
  softBouncePromotionThreshold: 3,
  softBouncePromotionWindowDays: 30,
  webhookRetryAttempts: 3,
  sendRetryAttempts: 4,
  trackOpens: true,
  trackClicks: true,
  storeTrackingIp: false,
  storeRenderedBody: false,
} as const

export const CIRCUIT_BREAKER_DEFAULTS: CircuitBreakerThresholds = {
  hardBounceRatePctTrip: 2,
  complaintRatePctTrip: 0.3,
  combinedBounceRatePctTrip: 5,
  failedToSendRatePctDegrade: 10,
  windowMinutes: 60,
  minSendsBeforeEval: 100,
}

export function resolveConfig(c: MailerConfig): ResolvedConfig {
  return {
    ...c,
    collectionPrefix: c.collectionPrefix ?? DEFAULTS.collectionPrefix,
    requireDoubleOptIn: c.requireDoubleOptIn ?? DEFAULTS.requireDoubleOptIn,
    unsubscribeTokenLifetimeDays: c.unsubscribeTokenLifetimeDays ?? DEFAULTS.unsubscribeTokenLifetimeDays,
    transactionalRespectUnsubscribe: c.transactionalRespectUnsubscribe ?? DEFAULTS.transactionalRespectUnsubscribe,
    doiTemplateSlug: c.doiTemplateSlug ?? DEFAULTS.doiTemplateSlug,
    doiTokenLifetimeDays: c.doiTokenLifetimeDays ?? DEFAULTS.doiTokenLifetimeDays,
    broadcastConfirmationThreshold: c.broadcastConfirmationThreshold ?? DEFAULTS.broadcastConfirmationThreshold,
    broadcastEnqueueBatchSize: c.broadcastEnqueueBatchSize ?? DEFAULTS.broadcastEnqueueBatchSize,
    broadcastEnqueueMaxWaiting: c.broadcastEnqueueMaxWaiting ?? DEFAULTS.broadcastEnqueueMaxWaiting,
    workerless: c.workerless ?? DEFAULTS.workerless,
    tickIntervalSeconds: c.tickIntervalSeconds ?? DEFAULTS.tickIntervalSeconds,
    sendConcurrency: c.sendConcurrency ?? DEFAULTS.sendConcurrency,
    sendRatePerSecond: c.sendRatePerSecond ?? DEFAULTS.sendRatePerSecond,
    softBouncePromotionThreshold: c.softBouncePromotionThreshold ?? DEFAULTS.softBouncePromotionThreshold,
    softBouncePromotionWindowDays: c.softBouncePromotionWindowDays ?? DEFAULTS.softBouncePromotionWindowDays,
    webhookRetryAttempts: c.webhookRetryAttempts ?? DEFAULTS.webhookRetryAttempts,
    sendRetryAttempts: c.sendRetryAttempts ?? DEFAULTS.sendRetryAttempts,
    trackOpens: c.trackOpens ?? DEFAULTS.trackOpens,
    trackClicks: c.trackClicks ?? DEFAULTS.trackClicks,
    storeTrackingIp: c.storeTrackingIp ?? DEFAULTS.storeTrackingIp,
    storeRenderedBody: c.storeRenderedBody ?? DEFAULTS.storeRenderedBody,
    circuitBreaker: { ...CIRCUIT_BREAKER_DEFAULTS, ...(c.circuitBreaker ?? {}) },
  }
}
