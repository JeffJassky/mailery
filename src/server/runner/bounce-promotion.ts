/**
 * Soft → hard bounce promotion. Configurable threshold + window:
 *
 *   softBouncePromotionThreshold soft bounces for the same email within
 *   softBouncePromotionWindowDays → insert a hard suppression + mark
 *   the subscription bounced.
 *
 * Runs on each tick. Idempotent: if a hard suppression already exists for
 * that email, we skip.
 */

import { sha256Hex } from '../tokens.js'
import { recordHealthCounter } from './health.js'
import type { RunnerContext } from './index.js'

export async function promoteSoftBounces(ctx: RunnerContext): Promise<void> {
  const threshold = ctx.config.softBouncePromotionThreshold
  const windowDays = ctx.config.softBouncePromotionWindowDays
  if (threshold <= 0 || windowDays <= 0) return

  const cutoff = new Date(Date.now() - windowDays * 86_400_000)

  // Aggregate: count soft bounces per emailAtSend since cutoff, hitting the
  // threshold. Bounded limit to keep the tick fast.
  const offenders = await ctx.collections.sends
    .aggregate<{ _id: string; count: number }>([
      { $match: { status: 'bounced', bounceType: 'soft', queuedAt: { $gt: cutoff } } },
      { $group: { _id: '$emailAtSend', count: { $sum: 1 } } },
      { $match: { count: { $gte: threshold } } },
      { $limit: 200 },
    ])
    .toArray()

  for (const o of offenders) {
    const email = String(o._id ?? '').toLowerCase()
    if (!email) continue

    // Skip if already hard-suppressed.
    const existing = await ctx.collections.suppressions.findOne({
      email,
      scope: 'all',
    })
    if (existing) continue

    await ctx.collections.suppressions.updateOne(
      { email, scope: 'all' },
      {
        $setOnInsert: {
          email,
          emailHash: sha256Hex(email),
          scope: 'all',
          reason: 'hard_bounce',
          source: 'soft_promotion',
          notes: `${o.count} soft bounces in last ${windowDays} days`,
          addedAt: new Date(),
          expiresAt: null,
        },
      },
      { upsert: true },
    )

    await ctx.collections.subscriptions.updateOne(
      { emailAtSubscribe: email },
      { $set: { status: 'bounced', updatedAt: new Date() } },
    )

    await recordHealthCounter(ctx, 'hardBounced')
  }
}
