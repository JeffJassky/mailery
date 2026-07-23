/**
 * Shared types — used by both server and client. Stub placeholders for Phase 0.
 * Full shapes live in plans/02-data-model.md.
 */

// Contact identity / adapter ---------------------------------------------------

export interface Contact {
  externalId: string
  email: string
  tags: string[]
  fields: Record<string, unknown>
  timezone?: string
  locale?: string
}

export interface AdapterFilter {
  emailIn?: string[]
  externalIdIn?: string[]
  fieldEquals?: { field: string; value: unknown }
  fieldIn?: { field: string; values: unknown[] }
  fieldExists?: string
  hasTag?: string
  hasTagIn?: string[]
  createdAfter?: Date
  createdBefore?: Date
}

export interface ContactAdapter {
  getById(externalId: string): Promise<Contact | null>
  getByEmail(email: string): Promise<Contact | null>
  getBatch(externalIds: string[]): Promise<Map<string, Contact>>
  query(filter: AdapterFilter, opts: { limit: number; cursor?: string }): Promise<{ contacts: Contact[]; nextCursor?: string }>
  count(filter: AdapterFilter): Promise<number>
  addTags?(externalId: string, tags: string[]): Promise<void>
  removeTags?(externalId: string, tags: string[]): Promise<void>
}

// Flow definitions ------------------------------------------------------------

/**
 * Constrains WHEN a send step's email may go out. The flow's waits decide the
 * earliest moment (T + N days); the window then pushes that moment forward —
 * never backward — to the next allowed slot:
 *
 *  - `timeOfDay` — deliver at this local wall-clock time ('HH:mm'). A send
 *    arriving after that time waits for the next day's slot (with a short
 *    grace period so tick jitter doesn't add 24h).
 *  - `weekdaysOnly` — a slot landing on Saturday/Sunday moves to Monday.
 *  - `useContactTimezone` — interpret times in `contact.timezone` when set,
 *    else fall back to `timezone` (IANA name, default UTC).
 */
export interface DeliveryWindow {
  weekdaysOnly?: boolean
  timeOfDay?: string
  useContactTimezone?: boolean
  timezone?: string
}

export type FlowStep =
  | { type: 'wait'; value: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' }
  | { type: 'condition'; test: Predicate; ifFalse: 'continue' | 'exit' }
  | { type: 'branch'; test: Predicate; ifTrueSteps: FlowStep[]; ifFalseSteps: FlowStep[] }
  | { type: 'send'; templateSlug: string; providerOverride?: string; vars?: Record<string, unknown>; delivery?: DeliveryWindow }
  | { type: 'tag'; addTags?: string[]; removeTags?: string[] }
  | { type: 'fire_event'; eventName: string; properties?: Record<string, unknown> }
  | { type: 'webhook'; url: string; method?: 'POST' | 'PUT'; payload?: Record<string, unknown>; failureMode?: 'soft' | 'fail_run' }
  | { type: 'exit'; reason?: string }

export type Predicate =
  | { hasTag: string }
  | { notHasTag: string }
  | { fieldEquals: { field: string; value: unknown } }
  | { fieldExists: string }
  /**
   * Tests a property of the event that STARTED this run, so the answer is
   * per-run rather than per-contact. Use when the gate depends on what the run
   * is about (which account, plan, order) instead of a durable trait of the
   * person: a contact-level tag is shared by every concurrent run and the last
   * writer wins, which silently changes branching in runs already in flight.
   */
  | { triggerPropertyEquals: { key: string; value: string | number | boolean | null } }
  | { triggerPropertyTruthy: string }
  | { hasFiredEvent: string; sinceFlowStart?: boolean; withinDays?: number }
  | { notHasFiredEvent: string; withinDays?: number }
  | { subscriptionStatus: 'subscribed' | 'unsubscribed' | 'pending_doi' | 'bounced' | 'complained' }
  | { hasOpened: { templateSlug?: string; sinceFlowStart?: boolean; withinDays?: number } }
  | { hasClicked: { templateSlug?: string; sinceFlowStart?: boolean; withinDays?: number } }
  | { hasOpenedExcludingBots: { templateSlug?: string; sinceFlowStart?: boolean; withinDays?: number } }
  | { hasClickedExcludingBots: { templateSlug?: string; sinceFlowStart?: boolean; withinDays?: number } }
  | { openedAtLeastN: { count: number; withinDays: number } }
  | { clickedAtLeastN: { count: number; withinDays: number } }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }

// Segments --------------------------------------------------------------------

export interface SegmentDefinition {
  filters: SegmentFilter[]
}

export type SegmentFilter =
  | { kind: 'fieldEquals'; field: string; value: unknown }
  | { kind: 'fieldIn'; field: string; values: unknown[] }
  | { kind: 'fieldExists'; field: string }
  | { kind: 'hasTag'; tag: string }
  | { kind: 'notHasTag'; tag: string }
  | { kind: 'subscriptionStatus'; equals: 'subscribed' | 'unsubscribed' | 'pending_doi' | 'bounced' | 'complained' }
  | { kind: 'firedEvent'; eventName: string; withinDays?: number }
  | { kind: 'notFiredEvent'; eventName: string; withinDays?: number }
  | { kind: 'subscribedAfter'; date: Date }
  | { kind: 'subscribedBefore'; date: Date }
  | { kind: 'opened'; templateSlug?: string; withinDays?: number }
  | { kind: 'notOpened'; templateSlug?: string; withinDays?: number }
  | { kind: 'any'; filters: SegmentFilter[] }
  | { kind: 'not'; filter: SegmentFilter }

// Send provider --------------------------------------------------------------

export interface SendArgs {
  to: string
  fromName: string
  fromEmail: string
  replyTo?: string
  subject: string
  /** Omitted for `text_only` templates — send the text part alone. */
  html?: string
  text: string
  headers?: Record<string, string>
  messageMeta?: Record<string, string>
}

export interface SendResult {
  providerId: string
  status: 'accepted' | 'rejected'
  raw?: unknown
}

export interface NormalizedEvent {
  type: 'delivered' | 'open' | 'click' | 'bounce' | 'complaint' | 'unsubscribe' | 'spam_report'
  providerEventId: string
  providerMessageId: string
  email: string
  occurredAt: Date
  details: {
    bounceType?: 'hard' | 'soft'
    bounceReason?: string
    clickedUrl?: string
    userAgent?: string
    ipAddress?: string
  }
}

export interface MailProvider {
  readonly name: string
  /** Per-provider send rate cap (per second). Used by the send-queue rate limiter. */
  readonly sendRatePerSecond?: number
  send(args: SendArgs): Promise<SendResult>
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<boolean>
  parseWebhookEvents(payload: unknown, headers: Record<string, string>): NormalizedEvent[]
}
