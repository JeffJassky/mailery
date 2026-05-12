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
  mjml: string
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
    mjml: string
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
  openedAt: Date | null
  openCount: number
  firstClickAt: Date | null
  clickCount: number
  /** History of actual clicks (a linkId may appear multiple times). */
  clickedLinks: Array<{ url: string; linkId: string; clickedAt: Date }>
  unsubscribedAt: Date | null
  complainedAt: Date | null
  queuedAt: Date
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

export interface HealthDoc {
  _id: 'singleton'
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
  ])
}
