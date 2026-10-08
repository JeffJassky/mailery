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

import { ObjectId } from 'mongodb'

import type { Contact, ContactPolicy } from '../../shared/types.js'
import type { SendOrigin, TemplateKind } from '../../shared/enums.js'
import { CONTACT_POLICY_DEFAULTS, isValidTimeZone } from '../config.js'
import type { ContactPolicyReason, SendDoc } from '../models/index.js'
import { addLocalDays, localParts, utcFromLocal } from './delivery-window.js'
import type { RunnerContext } from './index.js'
import { sendOrigin } from './send-hooks.js'

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

export function decideContactPolicy(input: ContactPolicyInput): ContactPolicyDecision {
  const m = input.policy?.marketing
  if (!m || input.kind !== 'marketing') return { action: 'send' }

  const { now } = input
  const nowMs = now.getTime()
  const st: { t: number; reason: ContactPolicyReason | null } = { t: nowMs, reason: null }
  const consider = (candidate: number, why: ContactPolicyReason) => {
    if (candidate > st.t) {
      st.t = candidate
      st.reason = why
    }
  }

  // gap
  if (m.minGapHours !== undefined && input.history.length > 0) {
    const last = Math.max(...input.history.map((d) => d.getTime()))
    consider(last + m.minGapHours * HOUR_MS, 'min_gap')
  }

  // cap — window is (now − days, now]
  if (m.maxPerRollingDays) {
    const { days, count } = m.maxPerRollingDays
    const span = days * DAY_MS
    const inWindow = input.history
      .map((d) => d.getTime())
      .filter((ms) => ms > nowMs - span && ms <= nowMs)
      .sort((a, b) => b - a)
    if (inWindow.length >= count) consider(inWindow[count - 1]! + span, 'rolling_cap')
  }

  // priority — a strictly higher-priority origin is due now
  const order = input.policy?.sourcePriority ?? CONTACT_POLICY_DEFAULTS.sourcePriority
  const rank = (o: string) => {
    const i = (order as readonly string[]).indexOf(o)
    return i === -1 ? order.length : i
  }
  const myRank = rank(input.origin)
  if (input.pending.some((p) => rank(p.origin) < myRank && p.dueAt.getTime() <= nowMs)) {
    consider(nowMs + (m.minGapHours ?? 1) * HOUR_MS, 'priority')
  }

  // quiet hours — applied last, on the time the other rules produced
  if (m.quietHours) {
    const end = quietPeriodEnd(new Date(st.t), m.quietHours.start, m.quietHours.end, input.timezone)
    if (end !== null) {
      st.t = end.getTime()
      st.reason = 'quiet_hours'
    }
  }

  const { t, reason } = st
  if (reason === null) return { action: 'send' }

  const maxHours = m.deferral?.maxHours ?? CONTACT_POLICY_DEFAULTS.deferralMaxHours
  if (t > input.queuedAt.getTime() + maxHours * HOUR_MS) {
    return { action: 'drop', reason, wouldBe: new Date(t) }
  }
  return { action: 'defer', notBefore: new Date(t), reason }
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return h * 60 + m
}

/** If `at` is inside the recipient-local quiet period, the instant it ends; else null. */
function quietPeriodEnd(at: Date, start: string, end: string, timezone: string): Date | null {
  const s = minutesOf(start)
  const e = minutesOf(end)
  const local = localParts(at, timezone)
  const m = local.hh * 60 + local.mi
  const overnight = s > e
  const inside = overnight ? m >= s || m < e : m >= s && m < e
  if (!inside) return null
  // The period ends on the same local date unless it started before midnight.
  const endsNextDay = overnight && m >= s
  const day = endsNextDay ? addLocalDays(local, 1) : { y: local.y, mo: local.mo, d: local.d }
  return utcFromLocal(day.y, day.mo, day.d, Math.floor(e / 60), e % 60, timezone)
}

/** contact.timezone → send.timezoneHint → policy defaultTimezone → 'UTC'. Invalid zones are skipped. */
export function resolvePolicyTimezone(
  contactTz: string | null | undefined,
  hint: string | null | undefined,
  policyDefault: string | null | undefined,
): string {
  for (const tz of [contactTz, hint, policyDefault]) {
    if (tz && isValidTimeZone(tz)) return tz
  }
  return 'UTC'
}

export async function applyContactPolicy(
  ctx: RunnerContext,
  send: SendDoc,
  contact: Contact,
  now: Date,
): Promise<ContactPolicyDecision> {
  const policy = ctx.config.contactPolicy
  const m = policy?.marketing
  if (!m || send.kind !== 'marketing') return { action: 'send' }

  const origin = sendOrigin(send)
  const timezone = resolvePolicyTimezone(contact.timezone, send.timezoneHint, m.defaultTimezone)

  // Rows are matched on the address as stored and lower-cased: stores that
  // lower-case on write (the norm) match exactly; a mixed-case historical row
  // is still found when it has the same casing as this send's or the contact's.
  const lower = send.emailAtSend.toLowerCase()
  const addresses = [...new Set([lower, send.emailAtSend, contact.email, contact.email?.toLowerCase()].filter((x): x is string => !!x))]

  const lookbackMs = Math.max(
    m.minGapHours !== undefined ? m.minGapHours * HOUR_MS : 0,
    m.maxPerRollingDays ? m.maxPerRollingDays.days * DAY_MS : 0,
  )
  let history: Date[] = []
  if (lookbackMs > 0) {
    const rows = await ctx.collections.sends
      .find(
        {
          emailAtSend: { $in: addresses },
          kind: 'marketing',
          sentAt: { $gt: new Date(now.getTime() - lookbackMs), $lte: now },
          _id: { $ne: send._id },
        },
        { projection: { sentAt: 1 } },
      )
      .limit(1000)
      .toArray()
    history = rows.map((r) => r.sentAt).filter((d): d is Date => d instanceof Date)
  }

  const pendingRows = await ctx.collections.sends
    .find(
      {
        emailAtSend: { $in: addresses },
        kind: 'marketing',
        status: { $in: ['queued', 'sending', 'deferred'] },
        _id: { $ne: send._id },
      },
      { projection: { program: 1, broadcastId: 1, flowRunId: 1, notBefore: 1, queuedAt: 1 } },
    )
    .limit(200)
    .toArray()
  const pending = pendingRows.map((r) => ({
    origin: sendOrigin(r),
    dueAt: r.notBefore ?? r.queuedAt,
  }))

  return decideContactPolicy({
    policy,
    now,
    kind: send.kind,
    origin,
    queuedAt: send.queuedAt,
    timezone,
    history,
    pending,
  })
}

/** Whether `applyContactPolicy` can ever do anything for this send (decides if dispatch takes the recipient lock). */
export function contactPolicyApplies(ctx: RunnerContext, send: Pick<SendDoc, 'kind'>): boolean {
  return send.kind === 'marketing' && !!ctx.config.contactPolicy?.marketing
}

// ---------------------------------------------------------------------------
// Per-recipient lock
// ---------------------------------------------------------------------------

/** A holder that crashes frees the address after this long (the TTL index only tidies up). */
const LOCK_TTL_MS = 2 * 60_000
/** A dispatch gives up waiting for a busy address after this long and requeues itself. */
const LOCK_WAIT_MS = 45_000

/**
 * Take the recipient's policy mutex. The decision (read history → write
 * sent/deferred) must not interleave with another dispatch to the same
 * address, or two sends both see an empty history and both go out.
 *
 * Acquire is one atomic upsert that only matches an absent or expired lock;
 * on a live lock the upsert hits the `_id` unique constraint (E11000) and we
 * poll. Returns a release function, or null if the wait timed out.
 */
export async function acquireRecipientLock(
  ctx: RunnerContext,
  email: string,
): Promise<(() => Promise<void>) | null> {
  const _id = email.toLowerCase()
  const owner = new ObjectId().toHexString()
  const waitUntil = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const now = new Date()
    try {
      await ctx.collections.contactLocks.updateOne(
        { _id, expiresAt: { $lte: now } },
        { $set: { owner, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
        { upsert: true },
      )
      return async () => {
        await ctx.collections.contactLocks.deleteOne({ _id, owner }).catch(() => {})
      }
    } catch (err: any) {
      if (err?.code !== 11000) throw err
    }
    if (Date.now() >= waitUntil) return null
    await new Promise((r) => setTimeout(r, 15 + Math.random() * 25))
  }
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
