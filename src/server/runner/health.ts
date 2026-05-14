/**
 * Circuit breaker. Tracks rolling counters in mailer_health per
 * (senderDomain, kind) bucket plus a single aggregate roll-up. Computes rates
 * on each tick and trips individual buckets when thresholds are exceeded.
 *
 *  status: 'healthy'   — normal
 *          'degraded'  — non-blocking warnings (e.g. high failed-to-send rate)
 *          'tripped'   — marketing sends held; transactional bypasses (INVARIANT 6)
 *
 * The aggregate doc is informational only — it never trips. Trips live on
 * buckets so one subdomain tanking doesn't hold mail for the others.
 *
 * Recovery is manual (admin UI: POST /api/health/resume[?domain&kind]).
 */

import type { TemplateKind } from '../../shared/enums.js'
import type { HealthDoc } from '../models/index.js'
import { HEALTH_AGG_ID, healthBucketId } from '../models/index.js'
import { extractDomain } from '../templates/sender-domain.js'
import type { RunnerContext } from './index.js'

type CounterKey =
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'hardBounced'
  | 'softBounced'
  | 'complained'
  | 'failedToSend'

export interface HealthDims {
  /** Caller passes the raw `fromEmail`; we extract the domain here. */
  fromEmail: string | null
  kind: TemplateKind
}

const ZERO_COUNTERS = {
  sent: 0,
  delivered: 0,
  bounced: 0,
  hardBounced: 0,
  softBounced: 0,
  complained: 0,
  failedToSend: 0,
}

const ZERO_RATES = {
  bounceRate: 0,
  hardBounceRate: 0,
  complaintRate: 0,
  failureRate: 0,
}

/**
 * Bump a counter on the relevant bucket doc plus the aggregate doc. Called
 * from the send / webhook paths. Idempotent at the document level (upsert).
 *
 * `dims` is null when we can't attribute the event (e.g. webhook event with
 * no matching send) — in that case only the aggregate is updated.
 */
export async function recordHealthCounter(
  ctx: RunnerContext,
  counter: CounterKey,
  dims: HealthDims | null,
  by = 1,
): Promise<void> {
  const windowMs = ctx.config.circuitBreaker.windowMinutes * 60 * 1000
  const writes: Array<Promise<unknown>> = []

  writes.push(upsertCounter(ctx, HEALTH_AGG_ID, null, null, counter, by, windowMs))

  if (dims) {
    // Skip the bucket write when we can't extract a real domain from
    // fromEmail rather than funneling unrelated invalid-sender sends into a
    // shared `_unknown` bucket — that bucket can collect bounces from many
    // unrelated sources and falsely trip them all at once.
    const domain = dims.fromEmail ? extractDomain(dims.fromEmail) : null
    if (domain) {
      const id = healthBucketId(domain, dims.kind)
      writes.push(upsertCounter(ctx, id, domain, dims.kind, counter, by, windowMs))
    }
  }

  await Promise.all(writes)
}

async function upsertCounter(
  ctx: RunnerContext,
  _id: string,
  senderDomain: string | null,
  kind: TemplateKind | null,
  counter: CounterKey,
  by: number,
  windowMs: number,
): Promise<void> {
  await ctx.collections.health.updateOne(
    { _id },
    {
      $inc: { [`counters.${counter}`]: by },
      $setOnInsert: {
        _id,
        senderDomain,
        kind,
        windowStartedAt: new Date(),
        windowDurationMs: windowMs,
        status: 'healthy',
        trippedAt: null,
        trippedReason: null,
        manuallyResumedAt: null,
        rates: { ...ZERO_RATES },
      } as Partial<HealthDoc>,
      $set: { updatedAt: new Date() },
    },
    { upsert: true },
  )
}

/**
 * Recompute rates from the rolling window for every bucket and trip individual
 * buckets when thresholds are exceeded. The aggregate doc is updated but never
 * tripped. Called from the tick.
 */
export async function evaluateHealth(ctx: RunnerContext): Promise<void> {
  const cb = ctx.config.circuitBreaker
  const windowMs = cb.windowMinutes * 60 * 1000

  const docs = await ctx.collections.health.find({}).toArray()
  if (docs.length === 0) return

  // Ensure the aggregate doc exists so the worker-heartbeat check has
  // something to look at as soon as any bucket exists.
  const hasAgg = docs.some((d) => d._id === HEALTH_AGG_ID)
  if (!hasAgg) {
    await upsertCounter(ctx, HEALTH_AGG_ID, null, null, 'sent', 0, windowMs)
  }

  for (const doc of docs) {
    const isAgg = doc._id === HEALTH_AGG_ID
    const windowAge = Date.now() - new Date(doc.windowStartedAt).getTime()

    if (windowAge > windowMs && doc.status !== 'tripped') {
      // Window roll: zero out counters AND reset status to healthy. A bucket
      // that was 'degraded' on the prior window but receives no samples in
      // the new window should not stay degraded — degraded is a function of
      // the current window's failureRate, not a sticky state.
      await ctx.collections.health.updateOne(
        { _id: doc._id },
        {
          $set: {
            windowStartedAt: new Date(),
            windowDurationMs: windowMs,
            counters: { ...ZERO_COUNTERS },
            rates: { ...ZERO_RATES },
            status: 'healthy',
            updatedAt: new Date(),
          },
        },
      )
      continue
    }

    const c = doc.counters
    const total = c.sent || 1
    const rates = {
      bounceRate: c.bounced / total,
      hardBounceRate: c.hardBounced / total,
      complaintRate: c.complained / total,
      failureRate: c.failedToSend / total,
    }

    await ctx.collections.health.updateOne(
      { _id: doc._id },
      { $set: { rates, updatedAt: new Date() } },
    )

    // Aggregate never trips, only reports.
    if (isAgg) continue

    if (c.sent < cb.minSendsBeforeEval) continue
    if (doc.status === 'tripped') continue

    let trippedReason: string | null = null
    if (rates.hardBounceRate * 100 >= cb.hardBounceRatePctTrip) {
      trippedReason = `hard bounce rate ${(rates.hardBounceRate * 100).toFixed(2)}% >= ${cb.hardBounceRatePctTrip}%`
    } else if (rates.complaintRate * 100 >= cb.complaintRatePctTrip) {
      trippedReason = `complaint rate ${(rates.complaintRate * 100).toFixed(2)}% >= ${cb.complaintRatePctTrip}%`
    } else if (rates.bounceRate * 100 >= cb.combinedBounceRatePctTrip) {
      trippedReason = `combined bounce rate ${(rates.bounceRate * 100).toFixed(2)}% >= ${cb.combinedBounceRatePctTrip}%`
    }

    if (trippedReason) {
      // Gate the trip write on the current non-tripped status so two
      // concurrent ticks can't both transition the same bucket. The
      // matchedCount check below tells us whether *this* tick was the one
      // that flipped it — only then do we fire the alert + audit log.
      const result = await ctx.collections.health.updateOne(
        { _id: doc._id, status: { $in: ['healthy', 'degraded'] } },
        { $set: { status: 'tripped', trippedAt: new Date(), trippedReason, updatedAt: new Date() } },
      )
      if (result.modifiedCount > 0) {
        // Audit log so the admin UI's "Recent trips" panel has rows to render.
        if (ctx.audit) {
          try {
            await ctx.audit({
              actor: 'system:circuit-breaker',
              action: 'health.trip',
              resource: {
                collection: 'mailer_health',
                id: String(doc._id),
                slug: `${doc.senderDomain ?? '_unknown'}|${doc.kind}`,
              },
              diffSummary: trippedReason,
            })
          } catch {
            /* swallow — audit failure must not block runner */
          }
        }
        if (ctx.config.onCircuitBreakerTrip) {
          try {
            await ctx.config.onCircuitBreakerTrip({
              reason: `[${doc.senderDomain ?? '_unknown'} / ${doc.kind}] ${trippedReason}`,
              rates,
            })
          } catch {
            /* swallow — alert hook failures don't propagate */
          }
        }
      }
      continue
    }

    if (rates.failureRate * 100 >= cb.failedToSendRatePctDegrade) {
      if (doc.status !== 'degraded') {
        await ctx.collections.health.updateOne(
          { _id: doc._id },
          { $set: { status: 'degraded', updatedAt: new Date() } },
        )
      }
    } else if (doc.status === 'degraded') {
      await ctx.collections.health.updateOne(
        { _id: doc._id },
        { $set: { status: 'healthy', updatedAt: new Date() } },
      )
    }
  }
}

/**
 * Look up the bucket status that gates a marketing send. Returns the
 * bucket doc when found, otherwise null (which the caller treats as healthy
 * — sends from a never-seen-before bucket flow through).
 */
export async function getBucketStatus(
  ctx: RunnerContext,
  fromEmail: string | null,
  kind: TemplateKind,
): Promise<HealthDoc | null> {
  const domain = fromEmail ? extractDomain(fromEmail) : null
  const id = healthBucketId(domain, kind)
  return ctx.collections.health.findOne({ _id: id })
}

/**
 * Derive an effective overall status across all buckets. The aggregate doc
 * itself never trips, so callers that want a single "is anything wrong"
 * answer use this. Returns null when no buckets exist yet (no tick has run).
 */
export function effectiveOverallStatus(docs: HealthDoc[]): HealthDoc['status'] | null {
  // Only canonical bucket docs (id prefix 'd:') participate. The aggregate
  // never trips and a legacy 'singleton' doc, if it survives the migration,
  // is ignored.
  const buckets = docs.filter((d) => typeof d._id === 'string' && d._id.startsWith('d:'))
  if (buckets.length === 0) {
    return docs.length === 0 ? null : 'healthy'
  }
  if (buckets.some((d) => d.status === 'tripped')) return 'tripped'
  if (buckets.some((d) => d.status === 'degraded')) return 'degraded'
  return 'healthy'
}
