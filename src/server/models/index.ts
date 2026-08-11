/**
 * Mongo collection helpers + indexes for every mailer-owned collection.
 *
 * The single source of truth for `mailer_*` schemas lives in
 * `plans/02-data-model.md`. The TS interfaces here track that doc.
 *
 *   const collections = getCollections(db)
 *   await ensureIndexes(db)
 *   await collections.events.insertOne({ ... })
 */

import type { Db, Collection, ObjectId } from 'mongodb'

import type {
  SubscriptionStatus,
  SendStatus,
  TemplateKind,
  TemplateBodyFormat,
  SuppressionScope,
  SuppressionReason,
  FlowRunStatus,
  BroadcastStatus,
  HealthStatus,
  FlowGoal,
} from '../../shared/enums.js'
import type { FlowStep, SegmentDefinition } from '../../shared/types.js'

// ---------------------------------------------------------------------------
// Document interfaces (per collection)
// ---------------------------------------------------------------------------

export interface SubscriptionDoc {
  _id?: ObjectId
  externalId: string
  status: SubscriptionStatus
  subscribedAt: Date | null
  unsubscribedAt: Date | null
  unsubscribeReason: string | null
  doiTokenHash: string | null
  doiRequestedAt: Date | null
  doiConfirmedAt: Date | null
  doiIp: string | null
  doiUserAgent: string | null
  source: string
  emailAtSubscribe: string
  createdAt: Date
  updatedAt: Date
}

export interface LeadDoc {
  _id?: ObjectId
  email: string
  source: string
  capturedFields: Record<string, unknown>
  status: 'lead' | 'promoted' | 'rejected'
  promotedToExternalId: string | null
  promotedAt: Date | null
  consentedAt: Date | null
  consentIp: string | null
  unsubscribedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface EventDoc {
  _id?: ObjectId
  externalId: string
  name: string
  properties: Record<string, unknown>
  dedupeKey: string
  occurredAt: Date
  createdAt: Date
}

export interface FlowTrigger {
  type: 'event' | 'segment_enter' | 'cron'
  eventName?: string
  segmentDefinition?: SegmentDefinition
  cronExpression?: string
  once: boolean
}

export interface FlowDraft {
  steps: FlowStep[]
  notes: string
  lastModifiedBy: string
  lastModifiedAt: Date
}

export interface FlowDoc {
  _id?: ObjectId
  slug: string
  name: string
  description: string
  trigger: FlowTrigger
  enabled: boolean
  steps: FlowStep[]
  version: number
  draft: FlowDraft | null
  goal: FlowGoal
  audience: string
  expectedVolumePerWeek: number | null
  stats: {
    activeRuns: number
    completedRuns: number
    sendsTotal: number
    sendsLast7Days: number
  }
  lastTriggerScanAt: Date | null
  publishedAt: Date | null
  publishedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface FlowVersionDoc {
  _id?: ObjectId
  flowId: ObjectId
  version: number
  steps: FlowStep[]
  trigger: FlowTrigger
  publishedAt: Date
  publishedBy: string
}

export interface FlowRunHistoryEntry {
  stepIndex: number
  action:
    | 'entered'
    | 'wait_started'
    | 'wait_completed'
    | 'condition_evaluated'
    | 'branch_taken'
    | 'sent'
    | 'send_skipped'
    | 'send_deferred'
    | 'tagged'
    | 'event_fired'
    | 'webhook_called'
    | 'exited'
    | 'failed'
  at: Date
  details?: Record<string, unknown>
}

export interface FlowRunDoc {
  _id?: ObjectId
  externalId: string
  flowId: ObjectId
  flowSlug: string
  flowVersion: number
  emailAtEntry: string
  /**
   * Snapshot of the event that triggered this run. Properties surface in
   * templates as `{{event.*}}` and in `varsAdapter.resolve` via
   * `info.eventProperties` — this is how account/topic-scoped flows know
   * which account or topic the run is about. Null for non-event entries.
   */
  triggerEvent?: { name: string; properties: Record<string, unknown>; occurredAt: Date } | null
  /**
   * Dedupe key of the triggering event. Unique per flow (partial index) so the
   * trigger scan's overlap window can re-read an event without creating a
   * second run. Null for non-event entries (manual/API).
   */
  triggerDedupeKey?: string | null
  enteredAt: Date
  status: FlowRunStatus
  currentStepIndex: number
  currentBranchPath: Array<number | 'true' | 'false'>
  nextActionAt: Date
  attemptsForCurrentStep: number
  history: FlowRunHistoryEntry[]
  exitedAt: Date | null
  exitReason: string | null
  createdAt: Date
  updatedAt: Date
}

export interface TemplateDraft {
  subject: string
  preheader: string
  /** MJML source (when template is authored as MJML). Empty string if Maily-authored. */
  mjml: string
  /** Maily editor JSON (when template is authored via the WYSIWYG editor). null otherwise. */
  editorJson: Record<string, unknown> | null
  notes: string
  lastModifiedBy: string
  lastModifiedAt: Date
}

export interface TemplateDoc {
  _id?: ObjectId
  slug: string
  name: string
  description: string
  kind: TemplateKind
  fromName: string
  fromEmail: string
  replyTo: string | null
  providerOverride: string | null
  subject: string
  preheader: string
  body: {
    /** MJML source (set when published from MJML). */
    mjml: string
    /** Maily editor JSON (set when published from the WYSIWYG editor). null otherwise. */
    editorJson: Record<string, unknown> | null
    html: string
    plainText: string
    compiledAt: Date | null
  }
  variablesSchema: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean' | 'date' | 'url'
      required: boolean
      description?: string
      defaultValue?: unknown
    }
  >
  draft: TemplateDraft | null
  tags: string[]
  /** Wire format for the body. Absent on documents written before 0.11. */
  bodyFormat?: TemplateBodyFormat
  trackOpens: boolean
  trackClicks: boolean
  stats: {
    sent: number
    delivered: number
    opened: number
    clicked: number
    bounced: number
    complained: number
    unsubscribed: number
    lastSentAt: Date | null
  }
  publishedAt: Date | null
  publishedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface TemplateVersionDoc {
  _id?: ObjectId
  templateId: ObjectId
  version: number
  mjml: string
  html: string
  plainText: string
  subject: string
  preheader: string
  publishedAt: Date
  publishedBy: string
}

export interface SendDoc {
  _id?: ObjectId
  dedupeKey: string
  externalId: string
  emailAtSend: string
  templateId: ObjectId
  templateSlug: string
  flowRunId: ObjectId | null
  broadcastId: ObjectId | null
  manualSendBy: string | null
  kind: TemplateKind
  provider: string
  providerMessageId: string | null
  fromName: string
  fromEmail: string
  subject: string
  bodyHash: string
  status: SendStatus
  errorMessage: string | null
  bounceType: 'hard' | 'soft' | null
  bounceReason: string | null
  /** Pre-send map: every rewritten link's linkId → original URL. Lookup target on click. */
  links: Array<{ linkId: string; url: string }>
  /** Render-time vars from the flow step or one-off send. Re-applied at dispatch. */
  vars: Record<string, unknown>
  openedAt: Date | null
  openCount: number
  /**
   * Per-open history, capped at the most recent `MAX_TRACKED_OPENS`. Exists so
   * the bot filter (`hasOpenedExcludingBots`) has something to filter on —
   * `openCount` alone cannot distinguish a scanner from a reader.
   *
   * `userAgent` is null when the requesting client sent no `User-Agent`, which
   * is common for image fetches; see `predicate.ts` for how unknown is scored.
   * Absent entirely on sends recorded before the field existed.
   */
  opens?: Array<{ openedAt: Date; userAgent: string | null }>
  firstClickAt: Date | null
  clickCount: number
  /** History of actual clicks (a linkId may appear multiple times). */
  clickedLinks: Array<{ url: string; linkId: string; clickedAt: Date; userAgent?: string | null }>
  unsubscribedAt: Date | null
  complainedAt: Date | null
  queuedAt: Date
  /** Last time the row was mutated; used by the stranded-send sweep. */
  updatedAt: Date
  sentAt: Date | null
  deliveredAt: Date | null
}

export interface SuppressionDoc {
  _id?: ObjectId
  email: string | null
  emailHash: string
  scope: SuppressionScope
  reason: SuppressionReason
  source: string
  notes: string | null
  addedAt: Date
  expiresAt: Date | null
}

export interface BroadcastDoc {
  _id?: ObjectId
  slug: string
  name: string
  templateSlug: string
  segmentDefinition: SegmentDefinition
  status: BroadcastStatus
  scheduledAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  confirmationRequired: boolean
  confirmedCount: number | null
  confirmedAt: Date | null
  confirmedBy: string | null
  recipientCount: number | null
  /** When true, dispatch fires each recipient at their local-timezone equivalent of `scheduledAt`. */
  respectRecipientTimezone?: boolean
  stats: {
    sent: number
    delivered: number
    opened: number
    clicked: number
    bounced: number
    complained: number
    unsubscribed: number
  }
  createdAt: Date
  createdBy: string
  updatedAt: Date
}

export interface OutboxDoc {
  _id?: ObjectId
  payload: {
    type: 'event' | 'upsert_subscription' | 'unsubscribe'
    data: Record<string, unknown>
    dedupeKey: string
  }
  status: 'pending' | 'processed' | 'failed' | 'duplicate'
  attempts: number
  lastAttemptAt: Date | null
  lastError: string | null
  enqueuedAt: Date
  processedAt: Date | null
}

export interface AuditLogDoc {
  _id?: ObjectId
  actor: string
  action: string
  resource: { collection: string; id?: ObjectId | string; slug?: string }
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  diffSummary: string | null
  ip: string | null
  userAgent: string | null
  requestId: string | null
  occurredAt: Date
}

export interface WebhookEventDoc {
  _id?: ObjectId
  provider: string
  providerEventId: string
  eventType: string
  normalizedType: 'delivered' | 'open' | 'click' | 'bounce' | 'complaint' | 'unsubscribe' | 'spam_report'
  providerMessageId: string
  email: string
  occurredAt: Date
  receivedAt: Date
  processed: boolean
  raw: unknown
}

/**
 * Health bucket. One doc per (senderDomain, kind) pair plus a single aggregate
 * doc with _id='agg' that rolls up everything.
 *
 *   _id: 'agg'                              // cross-domain, cross-kind roll-up
 *   _id: 'd:<senderDomain>|k:<kind>'        // per-bucket
 *
 * The aggregate is informational only — it never trips. Trips live on
 * buckets so one subdomain tanking doesn't hold mail for the others.
 */
export interface HealthDoc {
  _id: string
  /** null on the aggregate doc, set on bucket docs. */
  senderDomain: string | null
  /** null on the aggregate doc, set on bucket docs. */
  kind: TemplateKind | null
  windowStartedAt: Date
  windowDurationMs: number
  counters: {
    sent: number
    delivered: number
    bounced: number
    hardBounced: number
    softBounced: number
    complained: number
    failedToSend: number
  }
  rates: {
    bounceRate: number
    hardBounceRate: number
    complaintRate: number
    failureRate: number
  }
  status: HealthStatus
  trippedAt: Date | null
  trippedReason: string | null
  manuallyResumedAt: Date | null
  updatedAt: Date
}

export const HEALTH_AGG_ID = 'agg'

export function healthBucketId(senderDomain: string | null, kind: TemplateKind): string {
  return `d:${senderDomain ?? '_unknown'}|k:${kind}`
}

export type PostmasterReputation = 'HIGH' | 'MEDIUM' | 'LOW' | 'BAD' | 'REPUTATION_CATEGORY_UNSPECIFIED'

/**
 * One day's traffic stats for a domain from Google Postmaster Tools.
 * Stored per (domain, date) so we can chart trends.
 */
export interface PostmasterSnapshotDoc {
  _id?: ObjectId
  domain: string
  /** Reporting date in YYYY-MM-DD per Postmaster's stat day. */
  date: string
  domainReputation: PostmasterReputation | null
  ipReputations: Array<{ reputation: PostmasterReputation; ipCount: number }> | null
  userReportedSpamRatio: number | null
  spfSuccessRatio: number | null
  dkimSuccessRatio: number | null
  dmarcSuccessRatio: number | null
  outboundEncryptionRatio: number | null
  inboundEncryptionRatio: number | null
  deliveryErrors: Array<{ errorType: string; errorClass: string; errorRatio: number }> | null
  spammyFeedbackLoops: Array<{ id: string; spamRatio: number }> | null
  fetchedAt: Date
}

export interface MailTesterFeedback {
  category: string
  severity: 'info' | 'warning' | 'error'
  message: string
}

/**
 * Cached Mail-Tester deliverability score for a given (template content)
 * fingerprint. Operators don't burn a credit re-running on identical
 * content within cacheHours.
 */
export interface MailTesterScoreDoc {
  _id?: ObjectId
  templateSlug: string
  /** Hash of bodyHash + subject + fromEmail — the cache key. */
  contentKey: string
  checkId: string
  score: number
  feedback: MailTesterFeedback[]
  rawSummary: string | null
  fetchedAt: Date
  expiresAt: Date
}

export type DmarcPolicy = 'none' | 'quarantine' | 'reject'
export type DmarcAuthResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'temperror' | 'permerror' | 'none' | 'unknown'

/**
 * One DMARC RUA aggregate report. Receivers (Google, Yahoo, Microsoft, etc.)
 * email one per day per sending domain. We store one DmarcReportDoc per
 * incoming report, plus one DmarcFailureDoc per non-aligned record row.
 */
export interface DmarcReportDoc {
  _id?: ObjectId
  reportId: string
  /** Reporting org, e.g. 'google.com', 'enterprise.protection.outlook.com'. */
  orgName: string
  /** Reporter contact email from <report_metadata>. */
  email: string
  /** The domain we publish DMARC for, from <policy_published><domain>. */
  domain: string
  policyP: DmarcPolicy
  /** % of mail subject to the policy (1-100). */
  policyPct: number
  /** Activity window the report covers. */
  rangeStart: Date
  rangeEnd: Date
  /** Sum of <count> across all records. */
  totalMessages: number
  /** Messages that passed DMARC (DKIM aligned OR SPF aligned). */
  passCount: number
  failCount: number
  receivedAt: Date
}

/**
 * One alignment-failing source × day. Composite key `(sourceIp, domain, day)`
 * lets us roll up "this IP sent N misaligned messages over the past week."
 * Failures from multiple reports for the same key get counted once per
 * report (we de-dupe on reportId × sourceIp).
 */
export interface DmarcFailureDoc {
  _id?: ObjectId
  reportId: string
  domain: string
  sourceIp: string
  count: number
  headerFrom: string
  dkimResult: DmarcAuthResult
  spfResult: DmarcAuthResult
  dispositionApplied: 'none' | 'quarantine' | 'reject' | string
  /** YYYY-MM-DD bucket derived from the reporting window's mid-point. */
  day: string
  receivedAt: Date
}

/**
 * Operator-set DMARC source tag. Created/updated/deleted from the admin UI
 * so operators can mark "this IP is our SendGrid", "this is Hubspot", etc.
 * Merged with `MailerConfig.dmarc.knownSources` at read time — the config
 * version is read-only baseline, the collection is mutable runtime state.
 */
export interface DmarcSourceTagDoc {
  _id?: ObjectId
  ip: string
  label: string
  ignored: boolean
  setBy: string
  setAt: Date
}

export type SndsFilterResult = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN'

/**
 * One row from a Microsoft SNDS data export covering a single activity
 * window for one sending IP. Stored unique per (ip, activityStart) so
 * historical windows accumulate without re-writing.
 */
export interface SndsSnapshotDoc {
  _id?: ObjectId
  ip: string
  activityStart: Date
  activityEnd: Date
  rcptCommands: number
  dataCommands: number
  messageRecipients: number
  filterResult: SndsFilterResult
  /** 0-1 fraction. SNDS reports as "<0.1%", "0.1-0.3%", etc; we store the upper bound. null when unknown. */
  complaintRate: number | null
  trapMessageCount: number
  sampleHelo: string | null
  sampleMailFrom: string | null
  fetchedAt: Date
}

export type DnsblResult = 'clean' | 'listed' | 'error'
export type DnsblTargetKind = 'domain' | 'ip'

/**
 * Latest DNSBL check result per (target, list). Replaced in-place on each run
 * so the collection stays small. History (if needed later) lives in audit_log.
 */
export interface DnsblCheckDoc {
  _id?: ObjectId
  /** Domain (e.g. `mkt.example.com`) or dotted-quad IP (e.g. `203.0.113.5`). */
  target: string
  targetKind: DnsblTargetKind
  /** DNS suffix queried (e.g. `dbl.spamhaus.org`). */
  list: string
  /** Display label for the UI (e.g. `Spamhaus DBL`). */
  listLabel: string
  result: DnsblResult
  /** A records returned by the lookup, when listed. */
  returnCodes: string[]
  /** When result is 'error', the message; otherwise null. */
  errorMessage: string | null
  runAt: Date
}

export interface ContactTagDoc {
  _id?: ObjectId
  externalId: string
  tag: string
  appliedBy: 'flow' | 'admin' | 'script' | 'import'
  appliedAt: Date
}

// ---------------------------------------------------------------------------
// Collection factory
// ---------------------------------------------------------------------------

export interface Collections {
  subscriptions: Collection<SubscriptionDoc>
  leads: Collection<LeadDoc>
  events: Collection<EventDoc>
  flows: Collection<FlowDoc>
  flowVersions: Collection<FlowVersionDoc>
  flowRuns: Collection<FlowRunDoc>
  templates: Collection<TemplateDoc>
  templateVersions: Collection<TemplateVersionDoc>
  sends: Collection<SendDoc>
  suppressions: Collection<SuppressionDoc>
  broadcasts: Collection<BroadcastDoc>
  outbox: Collection<OutboxDoc>
  auditLog: Collection<AuditLogDoc>
  webhookEvents: Collection<WebhookEventDoc>
  health: Collection<HealthDoc>
  contactTags: Collection<ContactTagDoc>
  dnsblChecks: Collection<DnsblCheckDoc>
  postmasterSnapshots: Collection<PostmasterSnapshotDoc>
  sndsSnapshots: Collection<SndsSnapshotDoc>
  dmarcReports: Collection<DmarcReportDoc>
  dmarcFailures: Collection<DmarcFailureDoc>
  dmarcSourceTags: Collection<DmarcSourceTagDoc>
  mailTesterScores: Collection<MailTesterScoreDoc>
}

export function getCollections(db: Db, prefix = 'mailer_'): Collections {
  return {
    subscriptions: db.collection<SubscriptionDoc>(`${prefix}subscriptions`),
    leads: db.collection<LeadDoc>(`${prefix}leads`),
    events: db.collection<EventDoc>(`${prefix}events`),
    flows: db.collection<FlowDoc>(`${prefix}flows`),
    flowVersions: db.collection<FlowVersionDoc>(`${prefix}flow_versions`),
    flowRuns: db.collection<FlowRunDoc>(`${prefix}flow_runs`),
    templates: db.collection<TemplateDoc>(`${prefix}templates`),
    templateVersions: db.collection<TemplateVersionDoc>(`${prefix}template_versions`),
    sends: db.collection<SendDoc>(`${prefix}sends`),
    suppressions: db.collection<SuppressionDoc>(`${prefix}suppressions`),
    broadcasts: db.collection<BroadcastDoc>(`${prefix}broadcasts`),
    outbox: db.collection<OutboxDoc>(`${prefix}outbox`),
    auditLog: db.collection<AuditLogDoc>(`${prefix}audit_log`),
    webhookEvents: db.collection<WebhookEventDoc>(`${prefix}webhook_events`),
    health: db.collection<HealthDoc>(`${prefix}health`),
    contactTags: db.collection<ContactTagDoc>(`${prefix}contact_tags`),
    dnsblChecks: db.collection<DnsblCheckDoc>(`${prefix}dnsbl_checks`),
    postmasterSnapshots: db.collection<PostmasterSnapshotDoc>(`${prefix}postmaster_snapshots`),
    sndsSnapshots: db.collection<SndsSnapshotDoc>(`${prefix}snds_snapshots`),
    dmarcReports: db.collection<DmarcReportDoc>(`${prefix}dmarc_reports`),
    dmarcFailures: db.collection<DmarcFailureDoc>(`${prefix}dmarc_failures`),
    dmarcSourceTags: db.collection<DmarcSourceTagDoc>(`${prefix}dmarc_source_tags`),
    mailTesterScores: db.collection<MailTesterScoreDoc>(`${prefix}mail_tester_scores`),
  }
}

// ---------------------------------------------------------------------------
// Index ensurer
// ---------------------------------------------------------------------------

export async function ensureIndexes(db: Db, prefix = 'mailer_'): Promise<void> {
  const c = getCollections(db, prefix)

  await Promise.all([
    c.subscriptions.createIndexes([
      { key: { externalId: 1 }, unique: true },
      { key: { status: 1, unsubscribedAt: -1 } },
    ]),
    c.leads.createIndexes([
      { key: { email: 1 }, unique: true },
      { key: { status: 1, createdAt: -1 } },
    ]),
    c.events.createIndexes([
      { key: { dedupeKey: 1 }, unique: true },
      { key: { externalId: 1, occurredAt: -1 } },
      { key: { name: 1, occurredAt: -1 } },
      { key: { name: 1, createdAt: 1 } },
      { key: { externalId: 1, name: 1 } },
    ]),
    c.flows.createIndexes([
      { key: { slug: 1 }, unique: true },
      { key: { enabled: 1, 'trigger.type': 1, 'trigger.eventName': 1 } },
    ]),
    c.flowVersions.createIndexes([{ key: { flowId: 1, version: 1 }, unique: true }]),
    c.flowRuns.createIndexes([
      { key: { status: 1, nextActionAt: 1 } },
      { key: { externalId: 1, flowId: 1 } },
      { key: { flowId: 1, status: 1 } },
      {
        key: { flowId: 1, triggerDedupeKey: 1 },
        unique: true,
        partialFilterExpression: { triggerDedupeKey: { $type: 'string' } },
      },
    ]),
    c.templates.createIndexes([
      { key: { slug: 1 }, unique: true },
      { key: { tags: 1 } },
      { key: { kind: 1 } },
    ]),
    c.templateVersions.createIndexes([{ key: { templateId: 1, version: 1 }, unique: true }]),
    c.sends.createIndexes([
      { key: { dedupeKey: 1 }, unique: true },
      { key: { externalId: 1, sentAt: -1 } },
      { key: { templateId: 1, sentAt: -1 } },
      { key: { flowRunId: 1 }, sparse: true },
      { key: { broadcastId: 1 }, sparse: true },
      { key: { providerMessageId: 1 }, sparse: true },
      { key: { status: 1, queuedAt: 1 } },
      { key: { status: 1, updatedAt: 1 } },
    ]),
    c.suppressions.createIndexes([
      { key: { email: 1, scope: 1 }, unique: true, partialFilterExpression: { email: { $type: 'string' } } },
      { key: { emailHash: 1 } },
      { key: { addedAt: -1 } },
    ]),
    c.broadcasts.createIndexes([
      { key: { slug: 1 }, unique: true },
      { key: { status: 1, scheduledAt: 1 } },
    ]),
    c.outbox.createIndexes([
      { key: { status: 1, enqueuedAt: 1 } },
      { key: { 'payload.dedupeKey': 1 }, unique: true },
    ]),
    c.auditLog.createIndexes([
      { key: { occurredAt: -1 } },
      { key: { 'resource.collection': 1, 'resource.id': 1, occurredAt: -1 } },
      { key: { actor: 1, occurredAt: -1 } },
    ]),
    c.webhookEvents.createIndexes([
      { key: { provider: 1, providerEventId: 1 }, unique: true },
      { key: { providerMessageId: 1 } },
      { key: { processed: 1, receivedAt: 1 } },
    ]),
    c.contactTags.createIndexes([
      { key: { externalId: 1, tag: 1 }, unique: true },
      { key: { tag: 1 } },
    ]),
    c.health.createIndexes([
      { key: { senderDomain: 1, kind: 1 } },
      { key: { status: 1 } },
      // setup-status reads the most-recently-touched health doc as a heartbeat.
      { key: { updatedAt: -1 } },
    ]),
    c.dnsblChecks.createIndexes([
      { key: { target: 1, list: 1 }, unique: true },
      // Supports the admin /dnsbl GET sort: result asc, then target asc, list asc.
      { key: { result: 1, target: 1, list: 1 } },
      // TTL — stale rows for targets the operator removed disappear after
      // 60 days without manual cleanup. The puller refreshes runAt on
      // every active target so existing targets stay indefinitely.
      { key: { runAt: 1 }, expireAfterSeconds: 60 * 24 * 60 * 60 },
    ]),
    c.postmasterSnapshots.createIndexes([
      { key: { domain: 1, date: 1 }, unique: true },
      { key: { domain: 1, fetchedAt: -1 } },
      { key: { domainReputation: 1 } },
    ]),
    c.sndsSnapshots.createIndexes([
      { key: { ip: 1, activityStart: 1 }, unique: true },
      { key: { ip: 1, fetchedAt: -1 } },
      { key: { filterResult: 1 } },
    ]),
    c.dmarcReports.createIndexes([
      { key: { reportId: 1, orgName: 1 }, unique: true },
      { key: { domain: 1, rangeEnd: -1 } },
      // Cross-domain "most recent reports" queries scan a lot without this.
      { key: { rangeEnd: -1 } },
      { key: { receivedAt: -1 } },
    ]),
    c.dmarcFailures.createIndexes([
      { key: { reportId: 1, sourceIp: 1 }, unique: true },
      { key: { domain: 1, day: -1 } },
      { key: { sourceIp: 1, day: -1 } },
      { key: { receivedAt: 1 } }, // for retention pruning
    ]),
    c.dmarcSourceTags.createIndexes([
      { key: { ip: 1 }, unique: true },
    ]),
    c.mailTesterScores.createIndexes([
      { key: { contentKey: 1 }, unique: true },
      { key: { templateSlug: 1, fetchedAt: -1 } },
      // TTL — Mongo auto-deletes expired scores so we never serve stale data.
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ]),
  ])

  // One-shot migrations — run after indexes are in place so any DELETE
  // plan can use them. Idempotent at MongoDB level (returns 0 when
  // nothing is there).
  await c.health.deleteOne({ _id: 'singleton' as any }).catch(() => {})
}
