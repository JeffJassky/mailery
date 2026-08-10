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
import type { SenderDomainRegistry } from './templates/sender-domain.js'
import type { VarsAdapter } from './adapters/vars.js'

export type { SenderDomainConfig, SenderDomainRegistry } from './templates/sender-domain.js'

export interface RedisOptions {
  host?: string
  port?: number
  password?: string
  url?: string
  db?: number
  username?: string
  tls?: boolean
}

export interface DnsblListSpec {
  /** DNS suffix to query, e.g. `'dbl.spamhaus.org'`. */
  host: string
  /** Display label for the UI, e.g. `'Spamhaus DBL'`. */
  label: string
}

export interface DnsblConfig {
  /** Domain block lists (DBLs) — queried as `<domain>.<host>`. */
  domainLists?: DnsblListSpec[]
  /** IP block lists — queried as `<reversed-octets>.<host>`. */
  ipLists?: DnsblListSpec[]
  /** Dedicated sending IPs to check. Most operators on shared ESPs leave empty. */
  dedicatedIps?: string[]
  /** Hours between automatic runs. Default 24. Set to 0 to disable scheduled runs. */
  intervalHours?: number
}

export const DEFAULT_DOMAIN_DNSBL_LISTS: DnsblListSpec[] = [
  { host: 'dbl.spamhaus.org', label: 'Spamhaus DBL' },
  { host: 'multi.surbl.org', label: 'SURBL' },
  { host: 'multi.uribl.com', label: 'URIBL' },
]

export const DEFAULT_IP_DNSBL_LISTS: DnsblListSpec[] = [
  { host: 'zen.spamhaus.org', label: 'Spamhaus ZEN' },
  { host: 'b.barracudacentral.org', label: 'Barracuda' },
  { host: 'dnsbl.sorbs.net', label: 'SORBS' },
  { host: 'bl.spamcop.net', label: 'SpamCop' },
]

export interface MailTesterConfig {
  /** API key from your Mail-Tester paid plan. */
  apiKey: string
  /** Minimum score (0-10) below which publish is blocked. Default 8.0. */
  minScore?: number
  /**
   * When true, publishing content that has no cached score is blocked too —
   * the operator must run a deliverability check for that exact content first.
   * Default false, which only blocks content already known to score below
   * `minScore`; in that mode any edit (even whitespace) changes the content
   * key, misses the cache, and publishes freely.
   */
  requireScore?: boolean
  /**
   * How long a successful score remains cached for the same content. Default 24.
   * Re-publishing the same body within the window does not burn a credit.
   */
  cacheHours?: number
  /** API base URL. Defaults to `https://mail-tester.com/api`. Override for staging or alternate provider. */
  baseUrl?: string
}

export interface DmarcSourceTag {
  /** Source IP, e.g. `'149.72.45.10'`. */
  ip: string
  /** Operator-provided label, e.g. `'SendGrid (transactional)'` or `'Hubspot'`. */
  label: string
  /** When true, ignore failures from this source in the alignment-trend headline. */
  ignored?: boolean
}

export interface DmarcConfig {
  /**
   * Operator-tagged sources. After RUA reports start arriving, the operator
   * marks each source IP as known/legit (with a label) or rogue. Tagged
   * sources are excluded from the headline failure count, surfacing only
   * unknown senders.
   */
  knownSources?: DmarcSourceTag[]
  /**
   * How many days of failure rows to retain. Default 90. Older rows are
   * trimmed by the daily tick to keep the collection bounded.
   */
  retentionDays?: number
}

export interface SndsConfig {
  /**
   * SNDS automated-access key. Obtained per-account from the SNDS portal at
   * https://sendersupport.olc.protection.outlook.com/snds/ once each
   * sending IP has been added and verified.
   */
  accessKey: string
  /**
   * Optional IP filter — when set, only rows for these IPs are persisted.
   * Useful when an SNDS account covers a wider IP pool than this mailery
   * deployment uses. Defaults to keeping all rows the API returns.
   */
  ips?: string[]
  /** Hours between automatic pulls. Default 24. Set to 0 to disable scheduled pulls. */
  intervalHours?: number
}

export interface PostmasterConfig {
  /** OAuth client ID from a Google Cloud project with Postmaster Tools API enabled. */
  clientId: string
  clientSecret: string
  /**
   * A refresh token obtained via the OAuth consent flow with scope
   * `https://www.googleapis.com/auth/postmaster.readonly` for the user that
   * verified the domain(s) in Postmaster Tools. See
   * docs/guide/deliverability.md → "Google Postmaster Tools" for the
   * one-time setup procedure.
   */
  refreshToken: string
  /**
   * Domains to pull data for. When omitted, mailery uses every domain from the
   * senderDomains registry plus the From defaults. Each must be verified in
   * Postmaster Tools under the same Google account.
   */
  domains?: string[]
  /** Hours between automatic pulls. Default 24. Set to 0 to disable scheduled pulls. */
  intervalHours?: number
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

export interface BotFilterConfig {
  /**
   * User agents matching this pattern are treated as automated. Applied to
   * recorded open and click user agents alike.
   *
   * Default: `/Mimecast|SafeLinks|proofpoint|HeadlessChrome|Googlebot|bingbot/i`
   * (`DEFAULT_BOT_UA_RE`). Replace it to cover your own corporate scanners;
   * extend rather than replace if you want to keep the built-ins.
   */
  userAgentPattern?: RegExp
  /**
   * Opens recorded within this many milliseconds of the send being queued are
   * treated as automated regardless of user agent — corporate scanners and
   * gateway prefetchers fetch the pixel within seconds of delivery, and a
   * human cannot.
   *
   * Default `0` — disabled. It is off by default because it is a heuristic
   * with a real false-positive tail (a recipient already reading their inbox
   * when the mail lands) and because enabling it silently changes the counts
   * every existing flow branches on. `10000` (10s) is the value worth trying
   * first if your open counts look implausible.
   */
  minOpenDelayMs?: number
}

export interface MailerConfig {
  // ---- Storage --------------------------------------------------------------
  db: Db
  collectionPrefix?: string
  adapter: ContactAdapter
  /**
   * Optional host-provided template variables. `resolve(contact)` runs at
   * send/preview/test render time; its result is merged into the template
   * context root (schema key `user` → `{{user.name}}`). The zod schema
   * drives admin-editor autocomplete and the `unknown_variable` lint rule.
   * Build one with `defineVars({ schema, resolve })`.
   */
  varsAdapter?: VarsAdapter<any>

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
  /**
   * Optional registry of sender domains by kind. When set, mailery enforces at
   * template publish time that a template's `fromEmail` domain is declared and
   * matches the template's `kind`. Used to keep marketing reputation isolated
   * from transactional reputation by sending from separate verified domains.
   *
   * Domains are case-insensitive. If unset, no enforcement happens.
   */
  senderDomains?: SenderDomainRegistry

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

  // ---- DNSBL monitoring -----------------------------------------------------
  /**
   * Daily DNS-based block-list checks on sender domains and (optionally) any
   * dedicated sending IPs. Results surface in setup-status and on the Health
   * screen. No external API needed — plain DNS lookups.
   */
  dnsbl?: DnsblConfig

  // ---- Google Postmaster Tools ---------------------------------------------
  /**
   * Pulls daily reputation tiers + spam ratio + auth pass rates from Google
   * Postmaster Tools. Trips the (domain × marketing) circuit breaker when a
   * domain falls to reputation `BAD`. Only meaningful at >100/day to Gmail.
   */
  postmaster?: PostmasterConfig

  // ---- Microsoft SNDS ------------------------------------------------------
  /**
   * Pulls daily Outlook/Hotmail/Live IP reputation from Microsoft's Smart
   * Network Data Services. IP-level rather than domain-level — only useful
   * if you send from a dedicated IP. Visibility-only: RED filter results
   * surface as a setup-status error, no auto-trip.
   */
  snds?: SndsConfig

  // ---- Mail-Tester deliverability check ------------------------------------
  /**
   * Optional Mail-Tester integration. When set, the template editor exposes
   * a "Run deliverability check" button that sends a copy of the rendered
   * draft to a Mail-Tester address and polls for a score (0-10) covering
   * SpamAssassin verdict, auth alignment, content red flags, and link
   * reputation. Score < minScore blocks publish until re-run or overridden.
   */
  mailTester?: MailTesterConfig

  // ---- DMARC aggregate report ingestion ------------------------------------
  /**
   * DMARC RUA aggregate reports tell you who is sending mail that claims to
   * be from your domain — both legitimate sources and spoofers. Operator
   * uploads the report attachments (or POSTs them via SendGrid Inbound Parse
   * to /admin/mailer/api/dmarc/upload). Mailery decompresses, parses, and
   * surfaces alignment failures + unknown senders.
   */
  dmarc?: DmarcConfig

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
  /**
   * Reject `/m/open` and `/m/click` hits that carry no signature.
   *
   * Default `false` — grace mode. Newly rendered mail is always signed; this
   * flag only decides what happens to the *unsigned* URLs sitting in mail that
   * was already delivered. In grace mode they are still counted and each one is
   * logged (`mailery: unsigned tracking URL accepted`) so the operator can watch
   * the legacy rate fall to zero and then flip this to `true`.
   *
   * A signature that is *present but wrong* is always rejected, in both modes.
   */
  requireSignedTrackingUrls?: boolean
  /**
   * How long a tracking URL stays valid, in days, measured from the send's
   * `queuedAt`. Default `0` — never expires.
   *
   * Never-expire is the right default: an email sits in an inbox for years and
   * a legitimate open six months later is real data, not an attack. The
   * signature already proves the caller was handed the URL. Operators with a
   * data-retention policy can set a window; because the deadline is derived
   * from the send row rather than baked into the token, changing this value
   * takes effect immediately for already-delivered mail and costs no URL bytes.
   */
  trackingUrlLifetimeDays?: number
  /**
   * Tuning for `hasOpenedExcludingBots` / `hasClickedExcludingBots` /
   * `openedAtLeastN` / `clickedAtLeastN`. See `BotFilterConfig`.
   */
  botFilter?: BotFilterConfig

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
    | 'requireSignedTrackingUrls'
    | 'trackingUrlLifetimeDays'
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
  requireSignedTrackingUrls: false,
  trackingUrlLifetimeDays: 0,
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
    requireSignedTrackingUrls: c.requireSignedTrackingUrls ?? DEFAULTS.requireSignedTrackingUrls,
    trackingUrlLifetimeDays: c.trackingUrlLifetimeDays ?? DEFAULTS.trackingUrlLifetimeDays,
    circuitBreaker: { ...CIRCUIT_BREAKER_DEFAULTS, ...(c.circuitBreaker ?? {}) },
  }
}
