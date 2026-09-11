/**
 * Broadcast state that the runner, the webhook path and the HTTP routes all
 * need: per-broadcast delivery stats, the automatic stop rules, and pausing
 * (with its held sends) and releasing them.
 *
 * Stats are computed at read time (the `stats` sub-document stored on a
 * broadcast is never written after creation). Counts read the fields a send
 * carries rather than its `status` alone, because status is overwritten as
 * events arrive — an open after delivery, a complaint after delivery — while
 * `deliveredAt`, `bounceType`, `complainedAt` and `unsubscribedAt` stick.
 *
 * Stop rules are evaluated when an event that can raise a rate arrives (a
 * bounce, complaint or unsubscribe webhook; a one-click unsubscribe
 * attributed to a broadcast send) and on every tick, which is what catches a
 * rate that was already over threshold when the sample reached `minSample`.
 */

import { ObjectId } from 'mongodb'

import type { BroadcastDoc, BroadcastPauseReason, Collections, StopRuleBreach } from '../models/index.js'
import type { BroadcastStopRules } from '../config.js'
import type { RunnerContext } from './index.js'

export interface BroadcastStats {
  /** Every send row the broadcast has. */
  total: number
  /** Accepted by the provider (`sentAt` set). */
  accepted: number
  delivered: number
  bounced: number
  hardBounced: number
  softBounced: number
  complained: number
  unsubscribed: number
  opened: number
  clicked: number
  /**
   * Sends whose outcome is known: delivered or bounced. The denominator of
   * the bounce, complaint and unsubscribe rates — and the sample the
   * per-broadcast stop rules wait for.
   */
  outcomes: number
  /** Percentages, two decimals. 0 when the denominator is 0. */
  rates: {
    /** delivered / accepted */
    deliveryRatePct: number
    /** bounced / outcomes */
    bounceRatePct: number
    /** hardBounced / outcomes */
    hardBounceRatePct: number
    /** complained / outcomes */
    complaintRatePct: number
    /** unsubscribed / outcomes */
    unsubscribeRatePct: number
    /** opened / delivered — directional: Apple Mail Privacy Protection opens every message */
    openRatePct: number
    /** clicked / delivered */
    clickRatePct: number
  }
}

export function emptyBroadcastStats(): BroadcastStats {
  return withRates({
    total: 0,
    accepted: 0,
    delivered: 0,
    bounced: 0,
    hardBounced: 0,
    softBounced: 0,
    complained: 0,
    unsubscribed: 0,
    opened: 0,
    clicked: 0,
    outcomes: 0,
  })
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) / 100 : 0)

function withRates(c: Omit<BroadcastStats, 'rates'>): BroadcastStats {
  return {
    ...c,
    rates: {
      deliveryRatePct: pct(c.delivered, c.accepted),
      bounceRatePct: pct(c.bounced, c.outcomes),
      hardBounceRatePct: pct(c.hardBounced, c.outcomes),
      complaintRatePct: pct(c.complained, c.outcomes),
      unsubscribeRatePct: pct(c.unsubscribed, c.outcomes),
      openRatePct: pct(c.opened, c.delivered),
      clickRatePct: pct(c.clicked, c.delivered),
    },
  }
}

const set = (field: string) => ({ $ifNull: [field, false] })
const DELIVERED = {
  $or: [set('$deliveredAt'), { $eq: ['$status', 'delivered'] }, set('$complainedAt'), { $eq: ['$status', 'complained'] }],
}
const BOUNCED = { $or: [{ $eq: ['$status', 'bounced'] }, { $in: [{ $ifNull: ['$bounceType', null] }, ['hard', 'soft']] }] }
const count = (expr: unknown) => ({ $sum: { $cond: [expr, 1, 0] } })

/** Stats for every broadcast with sends, or for one. Test sends carry no broadcastId and never count. */
export async function aggregateBroadcastStats(
  collections: Collections,
  broadcastId?: ObjectId,
): Promise<Map<string, BroadcastStats>> {
  const rows = await collections.sends
    .aggregate<Omit<BroadcastStats, 'rates'> & { _id: ObjectId }>([
      { $match: broadcastId ? { broadcastId } : { broadcastId: { $ne: null } } },
      {
        $group: {
          _id: '$broadcastId',
          total: { $sum: 1 },
          accepted: count(set('$sentAt')),
          delivered: count(DELIVERED),
          bounced: count(BOUNCED),
          hardBounced: count({ $eq: ['$bounceType', 'hard'] }),
          softBounced: count({ $eq: ['$bounceType', 'soft'] }),
          complained: count({ $or: [set('$complainedAt'), { $eq: ['$status', 'complained'] }] }),
          unsubscribed: count(set('$unsubscribedAt')),
          opened: count(set('$openedAt')),
          clicked: count(set('$firstClickAt')),
          outcomes: count({ $or: [DELIVERED, BOUNCED] }),
        },
      },
    ])
    .toArray()
  const out = new Map<string, BroadcastStats>()
  for (const { _id, ...c } of rows) {
    if (_id) out.set(String(_id), withRates(c))
  }
  return out
}

export async function broadcastStatsFor(collections: Collections, broadcastId: ObjectId): Promise<BroadcastStats> {
  return (await aggregateBroadcastStats(collections, broadcastId)).get(String(broadcastId)) ?? emptyBroadcastStats()
}

// ---------------------------------------------------------------------------
// Stop rules
// ---------------------------------------------------------------------------

export function effectiveStopRules(
  config: { broadcastStopRules: BroadcastStopRules },
  b: Pick<BroadcastDoc, 'stopRules'>,
): BroadcastStopRules {
  return { ...config.broadcastStopRules, ...(b.stopRules ?? {}) }
}

export interface StopRuleEvaluation {
  rules: BroadcastStopRules
  /** Sends with a known outcome (delivered or bounced). */
  sample: number
  /** False while disabled or below `minSample`: no rule can fire yet. */
  evaluated: boolean
  breaches: StopRuleBreach[]
}

const RULE_COUNTS: Array<[StopRuleBreach['rule'], keyof BroadcastStats]> = [
  ['complaintRatePct', 'complained'],
  ['hardBounceRatePct', 'hardBounced'],
  ['unsubscribeRatePct', 'unsubscribed'],
]

export function evaluateStopRules(stats: BroadcastStats, rules: BroadcastStopRules): StopRuleEvaluation {
  const sample = stats.outcomes
  const evaluated = rules.enabled && sample > 0 && sample >= rules.minSample
  const breaches: StopRuleBreach[] = []
  if (evaluated) {
    for (const [rule, key] of RULE_COUNTS) {
      const n = stats[key] as number
      const exactPct = (n / sample) * 100
      if (exactPct > rules[rule]) {
        breaches.push({ rule, count: n, ratePct: Math.round(exactPct * 100) / 100, thresholdPct: rules[rule] })
      }
    }
  }
  return { rules, sample, evaluated, breaches }
}

const RULE_LABEL: Record<StopRuleBreach['rule'], string> = {
  complaintRatePct: 'complaint rate',
  hardBounceRatePct: 'hard bounce rate',
  unsubscribeRatePct: 'unsubscribe rate',
}

/**
 * Stronger reasons replace weaker ones: a wave parked at its cap (or paused
 * by hand) that then crosses a stop rule is re-labelled `stop_rule`, so
 * raising the cap alone cannot re-open it.
 */
const PAUSE_PRECEDENCE: Record<BroadcastPauseReason['code'], number> = {
  manual: 1,
  cap_reached: 1,
  stop_rule: 2,
  circuit_breaker: 2,
}

/**
 * Pause a broadcast and hold its queued sends. From 'sending' or 'sent' (a
 * sent broadcast may still have time-zone-delayed sends queued), or from
 * 'paused' for a weaker reason. Returns whether this call paused it.
 */
export async function pauseBroadcast(
  ctx: RunnerContext,
  broadcastId: ObjectId,
  reason: BroadcastPauseReason,
  actor = 'system:broadcast',
): Promise<{ paused: boolean; heldSends: number }> {
  const weaker = (Object.keys(PAUSE_PRECEDENCE) as Array<BroadcastPauseReason['code']>).filter(
    (k) => PAUSE_PRECEDENCE[k] < PAUSE_PRECEDENCE[reason.code],
  )
  const b = await ctx.collections.broadcasts.findOneAndUpdate(
    {
      _id: broadcastId,
      $or: [{ status: { $in: ['sending', 'sent'] } }, { status: 'paused', 'pauseReason.code': { $in: weaker } }],
    },
    { $set: { status: 'paused', pausedAt: reason.at, pauseReason: reason, updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
  if (!b) return { paused: false, heldSends: 0 }
  const held = await holdQueuedSends(ctx, broadcastId, reason.code)
  if (ctx.audit) {
    await ctx
      .audit({
        actor,
        action: 'broadcast.pause',
        resource: { collection: 'mailer_broadcasts', id: String(broadcastId), slug: b.slug },
        diffSummary: `${reason.code}: ${reason.message} · held ${held} queued send(s)`,
      })
      .catch(() => {})
  }
  if (ctx.config.onBroadcastPaused) {
    try {
      await ctx.config.onBroadcastPaused({ broadcastId: String(broadcastId), slug: b.slug, reason, heldSends: held })
    } catch {
      /* alert hook failures don't propagate */
    }
  }
  return { paused: true, heldSends: held }
}

async function holdQueuedSends(ctx: RunnerContext, broadcastId: ObjectId, code: string): Promise<number> {
  const res = await ctx.collections.sends.updateMany(
    { broadcastId, status: 'queued' },
    { $set: { status: 'held', errorMessage: `held: broadcast paused (${code})`, updatedAt: new Date() } },
  )
  return res.modifiedCount
}

/** Re-queue a broadcast's held sends, each with whatever delay remains until its `notBefore`. */
export async function releaseHeldSends(ctx: RunnerContext, broadcastId: ObjectId): Promise<number> {
  const held = await ctx.collections.sends
    .find({ broadcastId, status: 'held' }, { projection: { _id: 1, notBefore: 1 } })
    .toArray()
  if (held.length === 0) return 0
  await ctx.collections.sends.updateMany(
    { _id: { $in: held.map((s) => s._id!) }, status: 'held' },
    { $set: { status: 'queued', errorMessage: null, updatedAt: new Date() } },
  )
  const now = Date.now()
  await Promise.all(
    held.map((s) => {
      const delay = s.notBefore ? Math.max(0, new Date(s.notBefore).getTime() - now) : 0
      return ctx.queues.send.add(
        'send',
        { sendId: String(s._id) },
        {
          attempts: ctx.config.sendRetryAttempts,
          backoff: { type: 'exponential', delay: 60_000 },
          ...(delay > 0 ? { delay } : {}),
        },
      )
    }),
  )
  return held.length
}

/**
 * Evaluate one broadcast's stop rules and pause it on a breach. A no-op for
 * broadcasts that are not live (draft, scheduled, cancelled, failed) or are
 * already paused for a stop rule or the circuit breaker.
 */
export async function evaluateBroadcastStopRules(
  ctx: RunnerContext,
  broadcastId: ObjectId,
): Promise<StopRuleEvaluation | null> {
  const b = await ctx.collections.broadcasts.findOne({ _id: broadcastId })
  if (!b || !['sending', 'sent', 'paused'].includes(b.status)) return null
  if (b.status === 'paused' && b.pauseReason && PAUSE_PRECEDENCE[b.pauseReason.code] >= 2) return null

  const stats = await broadcastStatsFor(ctx.collections, broadcastId)
  const evaluation = evaluateStopRules(stats, effectiveStopRules(ctx.config, b))
  if (evaluation.breaches.length === 0) return evaluation

  const now = new Date()
  if (b.status === 'sent' && (await ctx.collections.sends.countDocuments({ broadcastId, status: 'queued' })) === 0) {
    // Everything already went out: nothing to hold. Record the first breach.
    await ctx.collections.broadcasts.updateOne(
      { _id: broadcastId, stopRuleBreach: { $in: [null] } },
      { $set: { stopRuleBreach: { at: now, sample: evaluation.sample, breaches: evaluation.breaches } } },
    )
    return evaluation
  }

  const first = evaluation.breaches[0]!
  await pauseBroadcast(ctx, broadcastId, {
    code: 'stop_rule',
    message: `${RULE_LABEL[first.rule]} ${first.ratePct}% is over ${first.thresholdPct}% (${first.count} of ${evaluation.sample} sends with an outcome)`,
    at: now,
    details: { breaches: evaluation.breaches, sample: evaluation.sample, rules: evaluation.rules },
  })
  return evaluation
}

const STOP_RULE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** Tick entry point: every live broadcast started in the last two weeks. */
export async function evaluateActiveBroadcastStopRules(ctx: RunnerContext): Promise<void> {
  const live = await ctx.collections.broadcasts
    .find(
      { status: { $in: ['sending', 'sent', 'paused'] }, startedAt: { $gte: new Date(Date.now() - STOP_RULE_WINDOW_MS) } },
      { projection: { _id: 1 } },
    )
    .limit(200)
    .toArray()
  for (const { _id } of live) {
    await evaluateBroadcastStopRules(ctx, _id!).catch((err) => {
      console.error('mailery: broadcast stop-rule evaluation failed', { id: String(_id), err })
    })
  }
}

/**
 * A one-click unsubscribe whose token names the send it came from: mark that
 * send unsubscribed (so the broadcast's unsubscribe count and stop rule see
 * it) and evaluate its broadcast. Tokens from before 0.18 name no send and
 * are not attributed.
 */
export async function attributeUnsubscribeToSend(ctx: RunnerContext, sendId: string, email: string): Promise<void> {
  if (!ObjectId.isValid(sendId)) return
  const _id = new ObjectId(sendId)
  const send = await ctx.collections.sends.findOne({ _id }, { projection: { emailAtSend: 1, broadcastId: 1 } })
  if (!send || send.emailAtSend.toLowerCase() !== email.toLowerCase()) return
  await ctx.collections.sends.updateOne({ _id, unsubscribedAt: null }, { $set: { unsubscribedAt: new Date() } })
  if (send.broadcastId) await evaluateBroadcastStopRules(ctx, send.broadcastId)
}
