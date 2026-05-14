/**
 * Apply a normalized provider event to the corresponding Send + cascading
 * suppression / subscription updates. Called from the webhook worker.
 */

import type { NormalizedEvent } from '../../shared/types.js'
import type { SendDoc } from '../models/index.js'
import type { RunnerContext } from './index.js'
import { sha256Hex } from '../tokens.js'
import { recordHealthCounter, type HealthDims } from './health.js'

function dimsFromSend(send: SendDoc | null | undefined): HealthDims | null {
  if (!send) return null
  return { fromEmail: send.fromEmail, kind: send.kind }
}

export async function applyWebhookEvent(event: NormalizedEvent, ctx: RunnerContext): Promise<void> {
  const send = await ctx.collections.sends.findOne(
    event.providerMessageId
      ? { $or: [{ providerMessageId: event.providerMessageId }, { emailAtSend: event.email }] }
      : { emailAtSend: event.email },
    { sort: { queuedAt: -1 } },
  )

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
