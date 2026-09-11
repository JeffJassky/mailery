/**
 * Apply a normalized provider event to the corresponding Send + cascading
 * suppression / subscription updates. Called from the webhook worker.
 */

import type { NormalizedEvent } from '../../shared/types.js'
import type { Filter } from 'mongodb'

import type { SendDoc, WebhookEventDoc } from '../models/index.js'
import type { RunnerContext } from './index.js'
import { sha256Hex } from '../tokens.js'
import { recordHealthCounter, type HealthDims } from './health.js'
import { evaluateBroadcastStopRules } from './broadcast-control.js'

function dimsFromSend(send: SendDoc | null | undefined): HealthDims | null {
  if (!send) return null
  return { fromEmail: send.fromEmail, kind: send.kind }
}

/**
 * Apply unprocessed rows from mailer_webhook_events. Called by the webhook
 * worker (no age filter) and by the tick as a fallback (`olderThanMs` set) for
 * events whose enqueue failed at ingest — those would otherwise sit unprocessed
 * until the next webhook happened to arrive. The tick's age filter keeps it out
 * of the webhook worker's way in the normal path.
 */
export async function processWebhookBacklog(
  ctx: RunnerContext,
  opts: { olderThanMs?: number } = {},
): Promise<void> {
  const filter: Record<string, unknown> = { processed: false }
  if (opts.olderThanMs) {
    filter.receivedAt = { $lt: new Date(Date.now() - opts.olderThanMs) }
  }
  const batch = await ctx.collections.webhookEvents.find(filter).limit(500).toArray()

  for (const evt of batch) {
    // At-most-once: claim the event BEFORE applying. Concurrent workers scan
    // the same unprocessed batch; without the claim each would apply the same
    // event, double-counting bounces/complaints into the circuit-breaker
    // health counters. Losing an event to a crash mid-apply is the cheaper
    // failure mode.
    const claimed = await ctx.collections.webhookEvents.findOneAndUpdate(
      { _id: evt._id, processed: false },
      { $set: { processed: true } },
    )
    if (!claimed) continue

    try {
      // The stored `raw` wraps the normalized event we captured at ingest;
      // pull details back out so applyWebhookEvent has the bounce reason etc.
      const normalized = (evt.raw as any)?.normalized
      const details = normalized?.details ?? {}
      await applyWebhookEvent(
        {
          type: evt.normalizedType,
          providerEventId: evt.providerEventId,
          providerMessageId: evt.providerMessageId,
          email: evt.email,
          occurredAt: evt.occurredAt,
          details,
        },
        ctx,
      )
    } catch (err) {
      console.error('mailery: webhook apply failed', { id: String(evt._id), err })
    }
  }
}

/**
 * Which send does a provider event belong to? The provider message id is the
 * only reliable link, so it wins outright when it matches. Only when nothing
 * carries that id (a provider that rewrites ids, an id we never stored) do we
 * fall back to the newest send to that address that actually reached the
 * provider. The previous single `$or` query sorted by queue time let the
 * newest send for the address outrank an exact id match, and could pick a row
 * still being dispatched — whose `sent` write then clobbered `delivered`.
 */
export async function findSendForEvent(event: NormalizedEvent, ctx: RunnerContext): Promise<SendDoc | null> {
  if (event.providerMessageId) {
    const byId = await ctx.collections.sends.findOne({ providerMessageId: event.providerMessageId })
    if (byId) return byId
  }
  if (!event.email) return null
  return ctx.collections.sends.findOne({ emailAtSend: event.email, sentAt: { $ne: null } }, { sort: { sentAt: -1 } })
}

/**
 * Filter for the webhook events behind one send: the exact id, plus rows
 * ingested before ids were normalised, where the provider's routing suffix
 * is still attached (`<id>.filterdrecv-…`).
 */
export function webhookEventsForMessageId(providerMessageId: string): Filter<WebhookEventDoc> {
  const escaped = providerMessageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return { $or: [{ providerMessageId }, { providerMessageId: { $regex: `^${escaped}\\.` } }] }
}

export async function applyWebhookEvent(event: NormalizedEvent, ctx: RunnerContext): Promise<void> {
  const send = await findSendForEvent(event, ctx)

  switch (event.type) {
    case 'delivered':
      if (send) {
        await ctx.collections.sends.updateOne(
          { _id: send._id },
          { $set: { status: 'delivered', deliveredAt: event.occurredAt } },
        )
      }
      await recordHealthCounter(ctx, 'delivered', dimsFromSend(send))
      break

    case 'open':
      if (send) {
        await ctx.collections.sends.updateOne(
          { _id: send._id },
          {
            $set: {
              openedAt: send.openedAt ?? event.occurredAt,
              status: send.status === 'sent' ? 'delivered' : send.status,
            },
            $inc: { openCount: 1 },
          },
        )
      }
      break

    case 'click':
      if (send) {
        await ctx.collections.sends.updateOne(
          { _id: send._id },
          {
            $set: { firstClickAt: send.firstClickAt ?? event.occurredAt },
            $inc: { clickCount: 1 },
            $push: {
              clickedLinks: {
                url: event.details.clickedUrl ?? '',
                linkId: '',
                clickedAt: event.occurredAt,
              },
            },
          },
        )
      }
      break

    case 'bounce': {
      const bounceType = event.details.bounceType ?? 'hard'
      if (send) {
        await ctx.collections.sends.updateOne(
          { _id: send._id },
          {
            $set: {
              status: 'bounced',
              bounceType,
              bounceReason: event.details.bounceReason ?? null,
            },
          },
        )
      }
      if (bounceType === 'hard') {
        await suppressOnce(ctx, event.email, 'hard_bounce', 'all')
        await ctx.collections.subscriptions.updateOne(
          { emailAtSubscribe: event.email },
          { $set: { status: 'bounced', updatedAt: new Date() } },
        )
      }
      {
        const dims = dimsFromSend(send)
        await recordHealthCounter(ctx, 'bounced', dims)
        await recordHealthCounter(ctx, bounceType === 'hard' ? 'hardBounced' : 'softBounced', dims)
      }
      break
    }

    case 'complaint':
    case 'spam_report':
      if (send) {
        await ctx.collections.sends.updateOne(
          { _id: send._id },
          { $set: { complainedAt: event.occurredAt, status: 'complained' } },
        )
      }
      await suppressOnce(ctx, event.email, 'complaint', 'all')
      await ctx.collections.subscriptions.updateOne(
        { emailAtSubscribe: event.email },
        { $set: { status: 'complained', updatedAt: new Date() } },
      )
      await recordHealthCounter(ctx, 'complained', dimsFromSend(send))
      break

    case 'unsubscribe':
      if (send) {
        await ctx.collections.sends.updateOne({ _id: send._id }, { $set: { unsubscribedAt: event.occurredAt } })
      }
      await suppressOnce(ctx, event.email, 'unsubscribed', 'marketing')
      await ctx.collections.subscriptions.updateOne(
        { emailAtSubscribe: event.email },
        {
          $set: {
            status: 'unsubscribed',
            unsubscribedAt: event.occurredAt,
            unsubscribeReason: 'user_request',
            updatedAt: new Date(),
          },
        },
      )
      break
  }

  // The events that can push a broadcast over a stop rule. Delivered events
  // only grow the sample; the tick catches a rate that crosses minSample.
  if (
    send?.broadcastId &&
    (event.type === 'bounce' || event.type === 'complaint' || event.type === 'spam_report' || event.type === 'unsubscribe')
  ) {
    await evaluateBroadcastStopRules(ctx, send.broadcastId).catch((err) => {
      console.error('mailery: broadcast stop-rule evaluation failed', { id: String(send.broadcastId), err })
    })
  }
}

async function suppressOnce(
  ctx: RunnerContext,
  email: string,
  reason: 'hard_bounce' | 'complaint' | 'unsubscribed',
  scope: 'all' | 'marketing' | 'transactional',
): Promise<void> {
  const normalized = email.toLowerCase()
  await ctx.collections.suppressions.updateOne(
    { email: normalized, scope },
    {
      $setOnInsert: {
        email: normalized,
        emailHash: sha256Hex(normalized),
        scope,
        reason,
        source: 'provider_webhook',
        notes: null,
        addedAt: new Date(),
        expiresAt: null,
      },
    },
    { upsert: true },
  )
}
