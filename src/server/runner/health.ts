/**
 * Circuit breaker. Tracks rolling counters in mailer_health, computes rates
 * on each tick, trips the breaker when thresholds are exceeded.
 *
 *  status: 'healthy'   — normal
 *          'degraded'  — non-blocking warnings (e.g. high failed-to-send rate)
 *          'tripped'   — marketing sends held; transactional bypasses (INVARIANT 6)
 *
 * Recovery is manual (admin UI: POST /api/health/resume).
 */

import type { HealthDoc } from '../models/index.js'
import type { RunnerContext } from './index.js'

type CounterKey =
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'hardBounced'
  | 'softBounced'
  | 'complained'
  | 'failedToSend'

/**
 * Bump a counter on the singleton health doc. Called from the send / webhook
 * paths. Idempotent at the document level (upsert).
 */
export async function recordHealthCounter(ctx: RunnerContext, counter: CounterKey, by = 1): Promise<void> {
  await ctx.collections.health.updateOne(
    { _id: 'singleton' },
    {
      $inc: { [`counters.${counter}`]: by },
      $setOnInsert: {
        _id: 'singleton',
        windowStartedAt: new Date(),
        windowDurationMs: ctx.config.circuitBreaker.windowMinutes * 60 * 1000,
        status: 'healthy',
        trippedAt: null,
        trippedReason: null,
        manuallyResumedAt: null,
        rates: { bounceRate: 0, hardBounceRate: 0, complaintRate: 0, failureRate: 0 },
      } as Partial<HealthDoc>,
      $set: { updatedAt: new Date() },
    },
    { upsert: true },
  )
}

/**
 * Recompute rates from the rolling window and trip the breaker if thresholds
 * are exceeded. Called from the tick.
 */
export async function evaluateHealth(ctx: RunnerContext): Promise<void> {
  const cb = ctx.config.circuitBreaker
  const windowMs = cb.windowMinutes * 60 * 1000

  // Reset the window if we've rolled past it. Simple "window of length N" —
  // when the window expires, we reset counters to 0 and start fresh. This
  // matches the conservative behavior described in the spec.
  const doc = await ctx.collections.health.findOne({ _id: 'singleton' })
  if (!doc) return

  const windowAge = Date.now() - new Date(doc.windowStartedAt).getTime()
  if (windowAge > windowMs && doc.status !== 'tripped') {
    // Roll the window.
    await ctx.collections.health.updateOne(
      { _id: 'singleton' },
      {
        $set: {
          windowStartedAt: new Date(),
          windowDurationMs: windowMs,
          counters: { sent: 0, delivered: 0, bounced: 0, hardBounced: 0, softBounced: 0, complained: 0, failedToSend: 0 },
          rates: { bounceRate: 0, hardBounceRate: 0, complaintRate: 0, failureRate: 0 },
          updatedAt: new Date(),
        },
      },
    )
    return
  }

  const c = doc.counters
  const total = c.sent || 1 // avoid div-by-zero; rates against `sent` total
  const rates = {
    bounceRate: c.bounced / total,
    hardBounceRate: c.hardBounced / total,
    complaintRate: c.complained / total,
    failureRate: c.failedToSend / total,
  }

  await ctx.collections.health.updateOne(
    { _id: 'singleton' },
    { $set: { rates, updatedAt: new Date() } },
  )

  // Don't evaluate trips on tiny sample sizes.
  if (c.sent < cb.minSendsBeforeEval) return
  if (doc.status === 'tripped') return // already tripped; wait for manual resume

  // Trip rules — first matching rule wins.
  let trippedReason: string | null = null
  if (rates.hardBounceRate * 100 >= cb.hardBounceRatePctTrip) {
    trippedReason = `hard bounce rate ${(rates.hardBounceRate * 100).toFixed(2)}% >= ${cb.hardBounceRatePctTrip}%`
  } else if (rates.complaintRate * 100 >= cb.complaintRatePctTrip) {
    trippedReason = `complaint rate ${(rates.complaintRate * 100).toFixed(2)}% >= ${cb.complaintRatePctTrip}%`
  } else if (rates.bounceRate * 100 >= cb.combinedBounceRatePctTrip) {
    trippedReason = `combined bounce rate ${(rates.bounceRate * 100).toFixed(2)}% >= ${cb.combinedBounceRatePctTrip}%`
  }

  if (trippedReason) {
    await ctx.collections.health.updateOne(
      { _id: 'singleton' },
      { $set: { status: 'tripped', trippedAt: new Date(), trippedReason, updatedAt: new Date() } },
    )
    if (ctx.config.onCircuitBreakerTrip) {
      try {
        await ctx.config.onCircuitBreakerTrip({ reason: trippedReason, rates })
      } catch {
        /* swallow — alert hook failures don't propagate */
      }
    }
    return
  }

  // Degraded?
  if (rates.failureRate * 100 >= cb.failedToSendRatePctDegrade) {
    if (doc.status !== 'degraded') {
      await ctx.collections.health.updateOne(
        { _id: 'singleton' },
        { $set: { status: 'degraded', updatedAt: new Date() } },
      )
    }
  } else if (doc.status === 'degraded') {
    await ctx.collections.health.updateOne(
      { _id: 'singleton' },
      { $set: { status: 'healthy', updatedAt: new Date() } },
    )
  }
}
