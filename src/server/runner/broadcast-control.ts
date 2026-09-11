/**
 * Broadcast state that the runner, the webhook path and the HTTP routes all
 * need: per-broadcast delivery stats computed from `mailer_sends`.
 *
 * Stats are computed at read time (the `stats` sub-document stored on a
 * broadcast is never written after creation). Counts read the fields a send
 * carries rather than its `status` alone, because status is overwritten as
 * events arrive — an open after delivery, a complaint after delivery — while
 * `deliveredAt`, `bounceType`, `complainedAt` and `unsubscribedAt` stick.
 */

import type { ObjectId } from 'mongodb'

import type { Collections } from '../models/index.js'

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
