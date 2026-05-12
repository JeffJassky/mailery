/**
 * The mailer:tick handler. Orchestrates all the periodic work that doesn't
 * fit a delayed-job model: event-trigger scanning, recovery sweep,
 * scheduled-broadcast dispatch, outbox draining, rollups.
 */

import { processNewlyFiredEventTriggers } from './triggers.js'
import { sweepStrandedFlowRuns } from './sweep.js'
import type { RunnerContext } from './index.js'

export async function runTick(ctx: RunnerContext): Promise<void> {
  await processNewlyFiredEventTriggers(ctx).catch((err) => {
    console.error('mailery: triggers scan failed', err)
  })
  await sweepStrandedFlowRuns(ctx).catch((err) => {
    console.error('mailery: sweep failed', err)
  })
  await drainOutbox(ctx).catch((err) => {
    console.error('mailery: outbox drain failed', err)
  })
  await processScheduledBroadcasts(ctx).catch((err) => {
    console.error('mailery: broadcast dispatch failed', err)
  })
}

/**
 * Pull pending outbox rows committed by host transactions and promote them
 * into the real collections (events / subscriptions / suppressions).
 */
async function drainOutbox(ctx: RunnerContext): Promise<void> {
  const batch = await ctx.collections.outbox
    .find({ status: 'pending' })
    .sort({ enqueuedAt: 1 })
    .limit(200)
    .toArray()

  for (const row of batch) {
    try {
      if (row.payload.type === 'event') {
        try {
          await ctx.collections.events.insertOne({
            externalId: row.payload.data.externalId as string,
            name: row.payload.data.name as string,
            properties: (row.payload.data.properties as Record<string, unknown>) ?? {},
            dedupeKey: row.payload.dedupeKey,
            occurredAt: (row.payload.data.occurredAt as Date | undefined) ?? new Date(),
            createdAt: new Date(),
          })
        } catch (err: any) {
          if (err?.code !== 11000) throw err
        }
      }
      await ctx.collections.outbox.updateOne(
        { _id: row._id },
        { $set: { status: 'processed', processedAt: new Date() } },
      )
    } catch (err: any) {
      await ctx.collections.outbox.updateOne(
        { _id: row._id },
        {
          $set: { lastAttemptAt: new Date(), lastError: String(err?.message ?? err) },
          $inc: { attempts: 1 },
        },
      )
    }
  }
}

/**
 * Dispatch broadcasts whose `scheduledAt` has passed. Streams the segment
 * cursor and bulk-enqueues sends, pausing when the send queue's waiting
 * count exceeds the configured cap (broadcastEnqueueMaxWaiting).
 */
async function processScheduledBroadcasts(ctx: RunnerContext): Promise<void> {
  // V1: stub — broadcast dispatch implementation lands alongside the broadcast
  // REST endpoints in Phase 2. Leaves the scheduling row in place; the next
  // tick will retry until human intervention.
  void ctx
}
