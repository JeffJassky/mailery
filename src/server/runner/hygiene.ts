/**
 * List hygiene aggregations. Reports the engagement health of the
 * subscriber list: how many contacts engaged recently, how many are
 * stale, and what the bounce/complaint impact of sunsetting the stale
 * cohort would be.
 *
 * Pure read — no writes. Caller decides when to run.
 */

import type { RunnerContext } from './index.js'

const DAY_MS = 86_400_000

export const HYGIENE_BUCKETS = [
  { label: 'Engaged (last 30 days)', maxDays: 30 },
  { label: 'Engaged (31-60 days)', minDays: 30, maxDays: 60 },
  { label: 'Engaged (61-90 days)', minDays: 60, maxDays: 90 },
  { label: 'Engaged (91-180 days)', minDays: 90, maxDays: 180 },
  { label: 'Inactive (>180 days)', minDays: 180 },
  { label: 'Never engaged', neverEngaged: true },
] as const

export interface HygieneBucket {
  label: string
  /** Lower bound of "days since last engagement" inclusive. Null for never-engaged. */
  minDays?: number | null
  /** Upper bound of "days since last engagement" exclusive. Null = unbounded. */
  maxDays?: number | null
  /** True for the "never engaged" bucket (sent but no open/click ever). */
  neverEngaged?: boolean
  count: number
  pctOfTotal: number
}

export interface HygieneReport {
  totalSubscribers: number
  totalWithSends: number
  buckets: HygieneBucket[]
  sunsetCandidate: {
    /** Cohort: subscribed contacts whose lastEngagedAt is >180 days ago, or who have never engaged after >180 days of being subscribed. */
    count: number
    pctOfTotal: number
    /** Lifetime metrics for the cohort, when data exists. */
    cohortLifetime: {
      totalSends: number
      bouncedRate: number
      hardBouncedRate: number
      complaintRate: number
    } | null
    /** Projected impact: how recent (90d) rates would change if this cohort were sunset. */
    projectedImpact: {
      recentTotalSends: number
      recentBounced: number
      recentComplained: number
      cohortRecentSends: number
      cohortRecentBounced: number
      cohortRecentComplained: number
      currentOverallBounceRate: number
      projectedBounceRate: number
      currentOverallComplaintRate: number
      projectedComplaintRate: number
    } | null
  }
  computedAt: string
}

export interface ComputeHygieneOptions {
  /** Override now() for tests. */
  now?: number
  /** Days of inactivity considered "stale" enough to sunset. Default 180. */
  sunsetThresholdDays?: number
  /** Window for projected-impact calculations. Default 90. */
  recentWindowDays?: number
}

export async function computeListHygiene(
  ctx: RunnerContext,
  opts: ComputeHygieneOptions = {},
): Promise<HygieneReport> {
  const now = opts.now ?? Date.now()
  const sunsetDays = opts.sunsetThresholdDays ?? 180
  const recentDays = opts.recentWindowDays ?? 90
  const recentCutoff = new Date(now - recentDays * DAY_MS)

  const totalSubscribers = await ctx.collections.subscriptions.countDocuments({ status: 'subscribed' })

  // Restrict the engagement aggregation to currently-subscribed contacts.
  // We materialize the subscriber externalId set in memory (one short
  // string per row). At ~10M subscribers this would be ~hundreds of MB —
  // a real concern at that scale. Below ~1M it's negligible. If list
  // sizes ever push past that, move to a server-side $lookup join inside
  // the sends aggregation.
  const subscribedIds = new Set<string>()
  {
    const cursor = ctx.collections.subscriptions
      .find({ status: 'subscribed' }, { projection: { externalId: 1 } })
    for await (const s of cursor) subscribedIds.add(s.externalId)
  }

  type EngagementRow = {
    _id: string
    lastOpened: Date | null
    lastClicked: Date | null
    firstSent: Date | null
    totalSends: number
    bounced: number
    hardBounced: number
    complained: number
    recentSends: number
    recentBounced: number
    recentComplained: number
  }

  // Single aggregation: group by externalId, computing engagement + lifetime
  // counts + recent-window counts in one pass. Cursor iteration avoids
  // loading the full per-contact map at once; allowDiskUse keeps Mongo from
  // OOMing on the $group stage at scale.
  const cursor = ctx.collections.sends.aggregate<EngagementRow>(
    [
      {
        $group: {
          _id: '$externalId',
          lastOpened: { $max: '$openedAt' },
          lastClicked: { $max: '$firstClickAt' },
          firstSent: { $min: '$queuedAt' },
          totalSends: { $sum: 1 },
          bounced: { $sum: { $cond: [{ $eq: ['$status', 'bounced'] }, 1, 0] } },
          hardBounced: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$status', 'bounced'] }, { $eq: ['$bounceType', 'hard'] }] },
                1,
                0,
              ],
            },
          },
          complained: { $sum: { $cond: [{ $ne: ['$complainedAt', null] }, 1, 0] } },
          recentSends: { $sum: { $cond: [{ $gte: ['$queuedAt', recentCutoff] }, 1, 0] } },
          recentBounced: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$status', 'bounced'] }, { $gte: ['$queuedAt', recentCutoff] }] },
                1,
                0,
              ],
            },
          },
          recentComplained: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$complainedAt', null] }, { $gte: ['$queuedAt', recentCutoff] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ],
    { allowDiskUse: true },
  )

  const buckets: HygieneBucket[] = HYGIENE_BUCKETS.map((b) => ({
    label: b.label,
    minDays: 'minDays' in b ? b.minDays : null,
    maxDays: 'maxDays' in b ? b.maxDays : null,
    neverEngaged: 'neverEngaged' in b && b.neverEngaged,
    count: 0,
    pctOfTotal: 0,
  }))

  let totalWithSends = 0
  let sunsetCount = 0

  const cohortLifetimeAcc = { totalSends: 0, bounced: 0, hardBounced: 0, complained: 0 }
  const cohortRecentAcc = { totalSends: 0, bounced: 0, complained: 0 }

  for await (const row of cursor) {
    if (!subscribedIds.has(row._id)) continue
    totalWithSends++

    const lastOpened = row.lastOpened ? new Date(row.lastOpened).getTime() : null
    const lastClicked = row.lastClicked ? new Date(row.lastClicked).getTime() : null
    const lastEngaged = lastOpened == null && lastClicked == null
      ? null
      : Math.max(lastOpened ?? 0, lastClicked ?? 0)

    let isSunset = false
    if (lastEngaged == null) {
      const firstSent = row.firstSent ? new Date(row.firstSent).getTime() : null
      buckets[5]!.count++
      if (firstSent != null && now - firstSent > sunsetDays * DAY_MS) {
        isSunset = true
      }
    } else {
      const daysSince = (now - lastEngaged) / DAY_MS
      if (daysSince <= 30) buckets[0]!.count++
      else if (daysSince <= 60) buckets[1]!.count++
      else if (daysSince <= 90) buckets[2]!.count++
      else if (daysSince <= 180) buckets[3]!.count++
      else {
        buckets[4]!.count++
        isSunset = true
      }
    }

    if (isSunset) {
      sunsetCount++
      cohortLifetimeAcc.totalSends += row.totalSends
      cohortLifetimeAcc.bounced += row.bounced
      cohortLifetimeAcc.hardBounced += row.hardBounced
      cohortLifetimeAcc.complained += row.complained
      cohortRecentAcc.totalSends += row.recentSends
      cohortRecentAcc.bounced += row.recentBounced
      cohortRecentAcc.complained += row.recentComplained
    }
  }

  for (const b of buckets) {
    b.pctOfTotal = totalSubscribers === 0 ? 0 : b.count / totalSubscribers
  }

  const cohortLifetime: HygieneReport['sunsetCandidate']['cohortLifetime'] =
    cohortLifetimeAcc.totalSends > 0
      ? {
          totalSends: cohortLifetimeAcc.totalSends,
          bouncedRate: cohortLifetimeAcc.bounced / cohortLifetimeAcc.totalSends,
          hardBouncedRate: cohortLifetimeAcc.hardBounced / cohortLifetimeAcc.totalSends,
          complaintRate: cohortLifetimeAcc.complained / cohortLifetimeAcc.totalSends,
        }
      : null

  // Recent-window overall stats are bounded by the date window and small at
  // any realistic volume.
  let projectedImpact: HygieneReport['sunsetCandidate']['projectedImpact'] = null
  const recentAll = await ctx.collections.sends
    .aggregate<{ totalSends: number; bounced: number; complained: number }>([
      { $match: { queuedAt: { $gte: recentCutoff } } },
      {
        $group: {
          _id: null,
          totalSends: { $sum: 1 },
          bounced: { $sum: { $cond: [{ $eq: ['$status', 'bounced'] }, 1, 0] } },
          complained: { $sum: { $cond: [{ $ne: ['$complainedAt', null] }, 1, 0] } },
        },
      },
    ])
    .toArray()

  if (recentAll[0] && recentAll[0].totalSends > 0) {
    const all = recentAll[0]
    const cohort = cohortRecentAcc
    const currentBounceRate = all.bounced / all.totalSends
    const currentComplaintRate = all.complained / all.totalSends
    const remainingSends = all.totalSends - cohort.totalSends
    const remainingBounces = all.bounced - cohort.bounced
    const remainingComplaints = all.complained - cohort.complained
    const projectedBounceRate = remainingSends > 0 ? remainingBounces / remainingSends : 0
    const projectedComplaintRate = remainingSends > 0 ? remainingComplaints / remainingSends : 0

    projectedImpact = {
      recentTotalSends: all.totalSends,
      recentBounced: all.bounced,
      recentComplained: all.complained,
      cohortRecentSends: cohort.totalSends,
      cohortRecentBounced: cohort.bounced,
      cohortRecentComplained: cohort.complained,
      currentOverallBounceRate: currentBounceRate,
      projectedBounceRate,
      currentOverallComplaintRate: currentComplaintRate,
      projectedComplaintRate,
    }
  }

  return {
    totalSubscribers,
    totalWithSends,
    buckets,
    sunsetCandidate: {
      count: sunsetCount,
      pctOfTotal: totalSubscribers === 0 ? 0 : sunsetCount / totalSubscribers,
      cohortLifetime,
      projectedImpact,
    },
    computedAt: new Date(now).toISOString(),
  }
}
