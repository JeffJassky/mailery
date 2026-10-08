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

/**
 * Order for `ContactAdapter.query`. `field` names a field on the host's
 * contact record (for MongoContactAdapter, a document path such as
 * `updatedAt`), not a key of the `Contact` projection. Ties break on the
 * contact id, ascending, so the order is total and pagination is stable.
 */
export interface AdapterSort {
  field: string
  direction: 'asc' | 'desc'
}

export interface ContactAdapter {
  getById(externalId: string): Promise<Contact | null>
  getByEmail(email: string): Promise<Contact | null>
  getBatch(externalIds: string[]): Promise<Map<string, Contact>>
  /**
   * One page of contacts matching `filter`. Without `opts.sort` the order is
   * the adapter's own and must be stable across calls (MongoContactAdapter:
   * by id). `opts.sort` is honoured only by adapters that declare
   * `supportsSort: true`; mailery never passes it to one that does not.
   */
  query(
    filter: AdapterFilter,
    opts: { limit: number; cursor?: string; sort?: AdapterSort },
  ): Promise<{ contacts: Contact[]; nextCursor?: string }>
  /**
   * True when `query` honours `opts.sort` (with an opaque cursor that
   * encodes the sort position). Optional: adapters written before 0.18 omit
   * it, and a broadcast with an `order` is then refused at create time
   * rather than silently sent in id order.
   */
  readonly supportsSort?: boolean
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
  /**
   * Program predicates only (0.21): tests one host fact from the tick's facts
   * snapshot. Every operator present must hold (AND). With no operator the
   * leaf is a truthiness test. Dates compare by instant; `gte`/`lte` accept a
   * number, or an ISO string / Date for date facts. `exists: true` means
   * neither `undefined` nor `null`. Rejected in flow steps at publish.
   */
  | FactPredicate

export interface FactPredicate {
  fact: string
  equals?: string | number | boolean | null
  gte?: number | string
  lte?: number | string
  in?: Array<string | number | boolean | null>
  exists?: boolean
}

// Categories (0.21) -----------------------------------------------------------

/**
 * A named stream of marketing email a recipient can opt out of on its own.
 * Declared in `MailerConfig.categories`; config is the source of truth.
 *
 * `id` is a dotted slug (`lifecycle.onboarding`). It appears in suppression
 * scopes (`category:<id>`), unsubscribe tokens and the `List-ID` header, so it
 * is permanent once mail carrying it has gone out.
 *
 * `defaultOptIn` is reserved: 0.21 supports opt-out categories only (every
 * recipient starts subscribed). `false` is rejected at `Mailer.init`.
 */
export interface CategoryDef {
  id: string
  label: string
  description?: string
  defaultOptIn?: true
}

/** `mailer.getPreferences(email)`. Transactional mail is never listed. */
export interface PreferenceState {
  /** False when an `all` or `marketing` suppression is live for the address. */
  marketing: boolean
  /** One entry per declared category. False when marketing is false. */
  categories: Record<string, boolean>
}

/** `mailer.setPreferences(email, prefs)` — the preference page's save. */
export interface PreferenceUpdate {
  /** false writes a `marketing` opt-out and ignores `categories`. */
  marketing?: boolean
  /** Per category: false writes `category:<id>`, true clears it. Unknown ids are rejected. */
  categories?: Record<string, boolean>
}

// Contact policy (0.21) -------------------------------------------------------

/**
 * Cross-system send rules, applied at dispatch to every marketing send
 * (flows, broadcasts, programs, one-offs). Transactional mail bypasses it.
 * Unset → the stage is a no-op.
 *
 * Windows are rolling, measured from `sentAt` of earlier marketing sends to
 * the same address (`emailAtSend`). Quiet hours are evaluated in the first
 * of: contact.timezone → send.timezoneHint → `defaultTimezone` → UTC.
 */
export interface ContactPolicy {
  marketing?: {
    /** Minimum hours between two marketing sends to one recipient. */
    minGapHours?: number
    /** At most `count` marketing sends in any rolling `days`-day window. */
    maxPerRollingDays?: { days: number; count: number }
    /** Local wall-clock 'HH:mm'. `start > end` spans midnight. */
    quietHours?: { start: string; end: string }
    /** IANA zone used when neither the contact nor the send names one. */
    defaultTimezone?: string
    /**
     * A send whose earliest allowed time is more than `maxHours` after it was
     * queued is dropped (`exitReason: 'policy_expired'`) rather than sent
     * stale. Default 72.
     */
    deferral?: { maxHours: number }
  }
  /**
   * Highest priority first. When a lower-priority send meets a pending
   * higher-priority send for the same recipient that is due now, the lower one
   * defers by `minGapHours`. Origins not listed rank below every listed one.
   * Default `['transactional', 'flow', 'oneoff', 'broadcast', 'program']`.
   */
  sourcePriority?: Array<'transactional' | 'flow' | 'broadcast' | 'program' | 'oneoff'>
}

// Programs (0.21) -------------------------------------------------------------

/** One piece of host state about a subject. Never computed from `mailer_*`. INVARIANT 20. */
export type FactValue = string | number | boolean | Date | null
export type Facts = Record<string, FactValue | undefined>

export interface FactDecl {
  type: 'boolean' | 'number' | 'string' | 'date' | 'enum'
  /** Required for `enum`. */
  values?: string[]
  description?: string
}

export type RecipientRule = 'owners' | 'admins' | 'all_members' | { adapter: string }

/**
 * Host adapter that answers "what is true about this subject right now" and
 * "who should hear about it". Required when any Program is enabled.
 *
 * Reserved fact name: `last_session_at` (date) — read by
 * `policy.suppressIfSessionWithinHours` and by the sunset engagement check.
 * Optional fact `timezone` (string, IANA) — copied to `send.timezoneHint`.
 */
export interface FactsAdapter {
  declare: Record<string, FactDecl>
  resolve(subjectId: string): Promise<Facts>
  /** Contacts to email for a subject. Must return contacts the ContactAdapter also knows. */
  recipients(subjectId: string, rule: RecipientRule): Promise<Contact[]>
}

export interface ProgramAttempt {
  /** Exactly one in 0.21. The array shape is reserved for multi-channel attempts. */
  deliveries: Array<{ channel: 'email'; templateSlug: string }>
  /** Overrides `policy.minGapDays` for the gap before this attempt. */
  minGapDays?: number
}

export interface ProgramAction {
  /** Stable, never reused. kebab-case. */
  id: string
  /** Bump when eligible/satisfied/copy semantics change. Logged on decisions and sends. */
  version: number
  /** Checklist label; `{{action.title}}` in templates. */
  title: string
  cta?: { label: string; url: string }
  /** Higher wins. Ties break by position in `actions`. */
  priority: number
  /** Reserved ranker inputs, unused in 0.21. */
  group?: string
  tags?: string[]
  value?: number
  /** Relevant now? Default: always. */
  eligible?: Predicate
  /** Done? State, not event. */
  satisfied: Predicate
  /** Action ids that must be satisfied first. DAG, validated acyclic at publish. */
  requires?: string[]
  /** Ordered ladder: attempt 1 asks, 2 reminds, last is last call. ≥ 1. */
  attempts: ProgramAttempt[]
  /** `hold`: while exhausted (or cooling down), nothing lower-priority may send. */
  onExhaust: 'skip' | 'hold'
  /** After exhaustion, wait this long and then start a fresh ladder. */
  cooldownDays?: number
}

export interface ProgramSunset {
  /** unansweredAttempts at which the gap is multiplied by `slowFactor`. */
  slowAfter: number
  slowFactor: number
  /** unansweredAttempts at which `askTemplateSlug` is sent once, then the run goes `sunset`. */
  askAfter: number
  askTemplateSlug: string
}

export interface ProgramPolicy {
  /** Days between two Program sends to the same subject. */
  minGapDays: number
  delivery?: DeliveryWindow
  /** `last_session_at` within this many hours → silent tick (`session-suppressed`). */
  suppressIfSessionWithinHours?: number
  sunset?: ProgramSunset
}

/**
 * A next-best-action program. See plans/15-programs.md §5.
 *
 * Program predicates (`eligible`, `satisfied`) may use `fact`,
 * `hasFiredEvent`, `notHasFiredEvent` (evaluated with `externalId =
 * subjectId`), `all`, `any`, `not`. Contact-scoped leaves (tags, fields,
 * opens) have no subject to read from and are rejected at publish.
 */
export interface ProgramDefinition {
  slug: string
  name: string
  description?: string
  /** A declared category. Every template the program sends must carry it. */
  category: string
  /** 0.21: always 'account'. */
  subject: 'account'
  recipients: RecipientRule
  /** Event (fired with `externalId = subjectId`) that enters a subject. */
  entry: { eventName: string }
  exit: {
    /** Any of these fired for the subject after entry → run exits. */
    eventNames?: string[]
    /** Fired once (externalId = subjectId) when the run completes. */
    onComplete?: { fireEvent: string }
  }
  policy: ProgramPolicy
  /** 0–100. Deterministic per (slug, subjectId); fixed for the run's life. */
  holdoutPct?: number
  actions: ProgramAction[]
}

/** One row of `getProgramState` — what the host's in-app checklist renders. */
export interface ProgramChecklistItem {
  actionId: string
  title: string
  cta: { label: string; url: string } | null
  status: 'pending' | 'satisfied' | 'exhausted' | 'cooldown'
  /** The action the next send would be about. At most one item. */
  isNext: boolean
  attempts: number
  completedAt: Date | null
}

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
