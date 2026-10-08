/**
 * Shared enums — string-literal unions for status fields and other discriminators.
 * Kept separate from types.ts so the client can import these without pulling in
 * server-shaped interfaces.
 */

export type SubscriptionStatus = 'subscribed' | 'pending_doi' | 'unsubscribed' | 'bounced' | 'complained'

export type SendStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'suppressed'
  | 'cancelled'
  /**
   * A broadcast send parked because its broadcast is paused (stop rule,
   * circuit breaker, operator). Never dispatched while held; resuming the
   * broadcast re-queues it.
   */
  | 'held'
  /**
   * Held back by the contact policy (0.21). Carries `notBefore` and
   * `policyDeferral`; re-dispatched once `notBefore` passes, when suppression,
   * the originating system's guard and the policy all run again. A deferral
   * that would land past `contactPolicy.marketing.deferral.maxHours` becomes
   * `cancelled` with `exitReason: 'policy_expired'` instead.
   */
  | 'deferred'
  /**
   * A Program send to a subject in the holdout arm (0.21): the decision was
   * made and logged exactly as for treatment, the row exists so the control
   * group has a denominator, and no provider was ever called.
   */
  | 'holdout'

export type TemplateKind = 'transactional' | 'marketing'

/**
 * How a template's body goes on the wire.
 *
 *   multipart — HTML + plain-text alternative (the default, and what almost
 *               every template wants).
 *   text_only — plain text alone, no HTML part at all. For mail that should
 *               read as if it were typed by a person. Open tracking is
 *               impossible without an HTML part to carry the pixel, and click
 *               tracking is skipped too (rewriting bare URLs in text produces
 *               the opaque redirect links this format exists to avoid), so a
 *               text_only send reports no opens and no clicks — by design.
 */
export type TemplateBodyFormat = 'multipart' | 'text_only'
export const TEMPLATE_BODY_FORMATS: readonly TemplateBodyFormat[] = ['multipart', 'text_only'] as const

/**
 * What a suppression row blocks. See `blockingScopes` in
 * `server/runner/suppression.ts` for the rule:
 *
 *   transactional             ← all, transactional
 *   marketing, no category    ← all, marketing
 *   marketing, category C     ← all, marketing, category:C
 *
 * `category:<id>` (0.21) blocks only marketing mail whose template carries
 * that category. INVARIANT 22.
 */
export type SuppressionScope = 'all' | 'marketing' | 'transactional' | CategoryScope

/** A category-scoped suppression, e.g. `category:lifecycle.onboarding`. */
export type CategoryScope = `category:${string}`

/**
 * Where a send came from. Drives contact-policy priority and selects the
 * per-origin hooks (`RunnerContext.sendHooks`) dispatch calls.
 *
 * `transactional` is never an origin — it is a template kind. A transactional
 * template sent from a flow has origin `flow` and bypasses the contact policy
 * because of its kind, not its origin.
 */
export type SendOrigin = 'flow' | 'broadcast' | 'program' | 'oneoff'

/**
 * Why a send that never reached the provider stopped (0.21). Set together
 * with `status: 'cancelled'`.
 *
 *   policy_expired          — contact policy would have deferred it past
 *                             `deferral.maxHours`; sending that late is stale
 *   satisfied_before_send   — Program re-verify: the action is already done
 *   ineligible_before_send  — Program re-verify: the action no longer applies
 *   run_inactive            — Program re-verify: the run exited/completed
 */
export type SendExitReason =
  | 'policy_expired'
  | 'satisfied_before_send'
  | 'ineligible_before_send'
  | 'run_inactive'

export type ProgramRunStatus = 'active' | 'completed' | 'exited' | 'sunset'

export type ProgramActionStatus = 'pending' | 'satisfied' | 'exhausted' | 'cooldown'

export type ProgramArm = 'treatment' | 'holdout'

/**
 * Why a tick ended the way it did. One per decision row.
 *
 *   highest-rank        — chose the top candidate and enqueued a send
 *   none-eligible       — no candidate; run stays active and re-checks later
 *   completed           — every action satisfied or permanently skipped
 *   exited              — an exit event fired since entry
 *   in-flight           — the previous decision's send has not resolved yet
 *   min-gap             — a candidate exists but the program gap has not elapsed
 *   delivery-window     — gap elapsed, waiting for the delivery window slot
 *   no-recipients       — recipients resolved to nobody deliverable
 *   session-suppressed  — the subject is in the app right now
 *   sunset              — sunset stage 2 reached, or the run is sunset
 *   holdout             — chose a candidate; holdout arm, no provider call
 *   policy-silence      — written onto the decision by the dispatch hook when
 *                         the contact policy deferred or dropped its send
 */
export type ProgramDecisionReason =
  | 'highest-rank'
  | 'none-eligible'
  | 'completed'
  | 'exited'
  | 'in-flight'
  | 'min-gap'
  | 'delivery-window'
  | 'no-recipients'
  | 'session-suppressed'
  | 'sunset'
  | 'holdout'
  | 'policy-silence'

export type SuppressionReason =
  | 'unsubscribed'
  | 'hard_bounce'
  | 'complaint'
  | 'manual'
  | 'list_cleaning'
  | 'gdpr_forget'

export type FlowRunStatus = 'active' | 'completed' | 'exited' | 'failed'

/**
 * `paused` — dispatch stopped with the broadcast re-openable: a wave reached
 * its `recipientCap`, a stop rule or the circuit breaker fired, or an
 * operator paused it. `pauseReason` says which; `resume` re-opens it.
 */
export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'sent' | 'cancelled' | 'failed'

export type HealthStatus = 'healthy' | 'degraded' | 'tripped'

export type FlowGoal = 'activation' | 'conversion' | 'retention' | 'reactivation' | 'transactional' | 'broadcast'
