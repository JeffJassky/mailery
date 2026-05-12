/**
 * The mailer:tick handler. Orchestrates all the periodic work that doesn't
 * fit a delayed-job model: event-trigger scanning, recovery sweep,
 * scheduled-broadcast dispatch, outbox draining, rollups.
 */

import { processNewlyFiredEventTriggers } from './triggers.js'
import { sweepStrandedFlowRuns } from './sweep.js'
import { processScheduledBroadcasts as dispatchScheduled } from './broadcasts.js'
import { evaluateHealth } from './health.js'
import { promoteSoftBounces } from './bounce-promotion.js'
import type { RunnerContext } from './index.js'

/**
 * Sends that entered the 'sending' state more than this long ago are assumed
 * to have been abandoned mid-dispatch (worker crash, OOM kill, ...). The tick
 * resets them to 'queued' and re-enqueues. Providers should treat the sendId
 * (passed in messageMeta) as an idempotency key to avoid duplicate delivery on
 * the rare case where the original call did reach the provider.
 */
const STRANDED_SEND_THRESHOLD_MS = 5 * 60 * 1000

export async function runTick(ctx: RunnerContext): Promise<void> {
  await processNewlyFiredEventTriggers(ctx).catch((err) => {
    console.error('mailery: triggers scan failed', err)
  })
  await sweepStrandedFlowRuns(ctx).catch((err) => {
    console.error('mailery: sweep failed', err)
  })
  await sweepStrandedSends(ctx).catch((err) => {
    console.error('mailery: stranded-send sweep failed', err)
  })
  await drainOutbox(ctx).catch((err) => {
    console.error('mailery: outbox drain failed', err)
  })
  await processScheduledBroadcasts(ctx).catch((err) => {
    console.error('mailery: broadcast dispatch failed', err)
  })
  await evaluateHealth(ctx).catch((err) => {
    console.error('mailery: health evaluation failed', err)
  })
  await promoteSoftBounces(ctx).catch((err) => {
    console.error('mailery: soft-bounce promotion failed', err)
  })
}

/**
 * Find sends stuck in 'sending' past the threshold (crashed mid-dispatch) and
 * re-enqueue them. Returning to 'queued' lets `dispatchSend` pick them back up.
 */
async function sweepStrandedSends(ctx: RunnerContext): Promise<void> {
  const cutoff = new Date(Date.now() - STRANDED_SEND_THRESHOLD_MS)
  const cursor = ctx.collections.sends.find(
    { status: 'sending', updatedAt: { $lt: cutoff } },
    { projection: { _id: 1 } },
  ).limit(500)
  for await (const row of cursor) {
    const reset = await ctx.collections.sends.updateOne(
      { _id: row._id, status: 'sending', updatedAt: { $lt: cutoff } },
      { $set: { status: 'queued', updatedAt: new Date() } },
    )
    if (reset.modifiedCount === 0) continue
    await ctx.queues.send.add('send', { sendId: String(row._id) }, {
      attempts: ctx.config.sendRetryAttempts,
      backoff: { type: 'exponential', delay: 60_000 },
    })
  }
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
  await dispatchScheduled(ctx)
}
