/**
 * The mailer:tick handler. Orchestrates all the periodic work that doesn't
 * fit a delayed-job model: event-trigger scanning, recovery sweep,
 * scheduled-broadcast dispatch, outbox draining, rollups.
 */

import { processNewlyFiredEventTriggers } from './triggers.js'
import { processWebhookBacklog } from './webhook.js'
import { sweepStrandedFlowRuns } from './sweep.js'
import { processScheduledBroadcasts as dispatchScheduled } from './broadcasts.js'
import { evaluateHealth } from './health.js'
import { promoteSoftBounces } from './bounce-promotion.js'
import { runDnsblChecks } from './dnsbl.js'
import { runPostmasterPull } from './postmaster.js'
import { runSndsPull } from './snds.js'
import { pruneDmarcFailures } from './dmarc.js'
import { HEALTH_AGG_ID } from '../models/index.js'
import type { RunnerContext } from './index.js'

/**
 * Sends that entered the 'sending' state more than this long ago are assumed
 * to have been abandoned mid-dispatch (worker crash, OOM kill, ...). The tick
 * resets them to 'queued' and re-enqueues. Providers should treat the sendId
 * (passed in messageMeta) as an idempotency key to avoid duplicate delivery on
 * the rare case where the original call did reach the provider.
 */
const STRANDED_SEND_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Webhook events older than this and still unprocessed are assumed stranded
 * (the ingest-time queue add failed). The tick drains them; fresher rows are
 * left to the webhook worker to avoid racing it in the normal path.
 */
const STRANDED_WEBHOOK_THRESHOLD_MS = 5 * 60 * 1000

export async function runTick(ctx: RunnerContext): Promise<void> {
  // Heartbeat: ensure the aggregate health doc exists with an up-to-date
  // `updatedAt` so the setup-status check can detect "workers are running."
  // Wrapped in try/catch — a Mongo blip should never abort the whole tick.
  try {
    await ctx.collections.health.updateOne(
      { _id: HEALTH_AGG_ID },
      {
        $set: { updatedAt: new Date() },
        $setOnInsert: {
          _id: HEALTH_AGG_ID,
          senderDomain: null,
          kind: null,
          windowStartedAt: new Date(),
          windowDurationMs: ctx.config.circuitBreaker.windowMinutes * 60 * 1000,
          status: 'healthy',
          trippedAt: null,
          trippedReason: null,
          manuallyResumedAt: null,
          counters: { sent: 0, delivered: 0, bounced: 0, hardBounced: 0, softBounced: 0, complained: 0, failedToSend: 0 },
          rates: { bounceRate: 0, hardBounceRate: 0, complaintRate: 0, failureRate: 0 },
        },
      },
      { upsert: true },
    )
  } catch (err) {
    console.error('mailery: heartbeat write failed', err)
  }

  // Core runners: order matters (sweep before send dispatch, drain outbox
  // before triggers re-scan, etc). Keep these serial.
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
  await processWebhookBacklog(ctx, { olderThanMs: STRANDED_WEBHOOK_THRESHOLD_MS }).catch((err) => {
    console.error('mailery: stranded-webhook drain failed', err)
  })

  // Independent reputation pollers + housekeeping — run in parallel so tick
  // latency is max() not sum(). Each is already throttled internally and
  // catches its own errors.
  await Promise.all([
    runDnsblChecks(ctx).catch((err) => {
      console.error('mailery: dnsbl checks failed', err)
    }),
    runPostmasterPull(ctx).catch((err) => {
      console.error('mailery: postmaster pull failed', err)
    }),
    runSndsPull(ctx).catch((err) => {
      console.error('mailery: snds pull failed', err)
    }),
    pruneDmarcFailures(ctx).catch((err) => {
      console.error('mailery: dmarc prune failed', err)
    }),
  ])
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
