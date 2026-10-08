/**
 * Contact policy (0.21) — plans/15-programs.md §4.
 *
 * One stage in `dispatchSend`, after suppression, the circuit breaker and the
 * origin guard, before render and provider: send, defer, or drop.
 *
 *   decideContactPolicy  — pure. All the maths, no I/O. Vector-tested.
 *   applyContactPolicy   — loads the recipient's history and pending sends,
 *                          calls decideContactPolicy, returns the decision.
 *                          dispatchSend writes the result.
 *   releaseDueDeferredSends — flips `deferred` rows whose `notBefore` has
 *                          passed back to `queued` and enqueues them. Called
 *                          from the mailer tick and the test `drain`, so a
 *                          lost delayed job never strands a deferral.
 *
 * Rules (marketing only; transactional and an unset policy → always send):
 *
 *   gap       earliest = lastSentAt + minGapHours
 *   cap       if ≥ count sends in (now − days, now]: earliest = the
 *             count-th most recent sentAt + days
 *   priority  a pending send to the same address from a strictly higher
 *             priority origin, due at or before now → earliest = now + minGapHours
 *             (or now + 1h when minGapHours is unset)
 *   t         = max(now, gap, cap, priority)
 *   quiet     if t falls inside quiet hours (recipient-local) → t = the end of
 *             that quiet period
 *   expire    if t > queuedAt + deferral.maxHours → drop (policy_expired)
 *   result    t == now → send; else defer to t
 *
 * `reason` is the constraint that produced the latest `t` (quiet hours win a
 * tie because they are applied last). History is sends with `sentAt` set,
 * kind marketing, same `emailAtSend` (lower-cased), excluding the send itself.
 */

import type { ObjectId } from 'mongodb'

import type { Contact, ContactPolicy } from '../../shared/types.js'
import type { SendOrigin, TemplateKind } from '../../shared/enums.js'
import type { ContactPolicyReason, SendDoc } from '../models/index.js'
import { notImplemented } from '../not-implemented.js'
import type { RunnerContext } from './index.js'

export interface ContactPolicyInput {
  policy: ContactPolicy | undefined
  now: Date
  kind: TemplateKind
  origin: SendOrigin
  /** Deferral expiry is measured from here. */
  queuedAt: Date
  /** IANA zone for quiet hours, already resolved by `resolvePolicyTimezone`. */
  timezone: string
  /** `sentAt` of earlier marketing sends to this address. Any order. */
  history: Date[]
  /** Other marketing sends to this address not yet sent: queued, sending or deferred. */
  pending: Array<{ origin: SendOrigin; dueAt: Date }>
}

export type ContactPolicyDecision =
  | { action: 'send' }
  | { action: 'defer'; notBefore: Date; reason: ContactPolicyReason }
  | { action: 'drop'; reason: ContactPolicyReason; wouldBe: Date }

export function decideContactPolicy(_input: ContactPolicyInput): ContactPolicyDecision {
  return notImplemented('decideContactPolicy', 'PR3')
}

/** contact.timezone → send.timezoneHint → policy defaultTimezone → 'UTC'. Invalid zones are skipped. */
export function resolvePolicyTimezone(
  _contactTz: string | null | undefined,
  _hint: string | null | undefined,
  _policyDefault: string | null | undefined,
): string {
  return notImplemented('resolvePolicyTimezone', 'PR3')
}

export async function applyContactPolicy(
  _ctx: RunnerContext,
  _send: SendDoc,
  _contact: Contact,
  _now: Date,
): Promise<ContactPolicyDecision> {
  return notImplemented('applyContactPolicy', 'PR3')
}

/**
 * Re-queue deferred sends whose `notBefore` has passed. Returns how many were
 * released. A no-op on a database that has never deferred anything.
 */
export async function releaseDueDeferredSends(ctx: RunnerContext, now: Date = new Date()): Promise<number> {
  const due = await ctx.collections.sends
    .find({ status: 'deferred', notBefore: { $lte: now } }, { projection: { _id: 1 } })
    .limit(500)
    .toArray()
  let released = 0
  for (const row of due) {
    const res = await ctx.collections.sends.updateOne(
      { _id: row._id as ObjectId, status: 'deferred', notBefore: { $lte: now } },
      { $set: { status: 'queued', updatedAt: new Date() } },
    )
    if (res.modifiedCount === 0) continue
    released++
    await ctx.queues.send.add('send', { sendId: String(row._id) }, {
      attempts: ctx.config.sendRetryAttempts,
      backoff: { type: 'exponential', delay: 60_000 },
    })
  }
  return released
}
