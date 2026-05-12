/**
 * Broadcast dispatch. Picks up scheduled broadcasts whose `scheduledAt` has
 * passed, streams the segment via the adapter cursor + mailer-side post-filter,
 * and bulk-enqueues Send docs + jobs. Per-provider rate limiting + bounded
 * enqueue (pause when waitingCount > broadcastEnqueueMaxWaiting).
 */

import { ObjectId } from 'mongodb'

import type { Contact, SegmentDefinition, SegmentFilter, AdapterFilter } from '../../shared/types.js'
import type { BroadcastDoc, SendDoc, TemplateDoc } from '../models/index.js'
import { isSuppressed } from './suppression.js'
import { sha256Hex } from '../tokens.js'
import type { RunnerContext } from './index.js'

/**
 * Process scheduled broadcasts whose `scheduledAt` has passed. Called from the
 * tick. Marks each broadcast `sending` before streaming so concurrent ticks
 * don't double-dispatch.
 */
export async function processScheduledBroadcasts(ctx: RunnerContext): Promise<void> {
  const now = new Date()
  const due = await ctx.collections.broadcasts
    .find({ status: 'scheduled', scheduledAt: { $lte: now } })
    .toArray()

  for (const b of due) {
    // Optimistic claim — only one worker takes this broadcast.
    const claimed = await ctx.collections.broadcasts.findOneAndUpdate(
      { _id: b._id, status: 'scheduled' },
      { $set: { status: 'sending', startedAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    )
    if (!claimed) continue

    try {
      await dispatchBroadcast(claimed, ctx)
    } catch (err) {
      console.error('mailery: broadcast dispatch failed', { id: String(b._id), err })
      await ctx.collections.broadcasts.updateOne(
        { _id: b._id },
        { $set: { status: 'failed', updatedAt: new Date() } },
      )
    }
  }
}

async function dispatchBroadcast(broadcast: BroadcastDoc, ctx: RunnerContext): Promise<void> {
  const template = await ctx.collections.templates.findOne({ slug: broadcast.templateSlug })
  if (!template) {
    await ctx.collections.broadcasts.updateOne(
      { _id: broadcast._id },
      { $set: { status: 'failed', updatedAt: new Date() } },
    )
    return
  }

  const hostFilter = toAdapterFilter(broadcast.segmentDefinition)
  const postFilters = broadcast.segmentDefinition.filters.filter((f) => isMailerSide(f))

  let cursor: string | undefined = undefined
  let total = 0
  const batchSize = ctx.config.broadcastEnqueueBatchSize
  const maxWaiting = ctx.config.broadcastEnqueueMaxWaiting
  const respectTimezone = broadcast.respectRecipientTimezone === true
  const scheduledMs = broadcast.scheduledAt?.getTime() ?? Date.now()

  for (;;) {
    const page = await ctx.adapter.query(hostFilter, { limit: batchSize, cursor })
    if (page.contacts.length === 0) break

    // Stage B: mailer-side post-filter.
    const eligible = await applyPostFilters(page.contacts, postFilters, ctx)

    if (eligible.length > 0) {
      // Backpressure: wait until the send queue's waiting set drains below cap.
      while ((await ctx.queues.send.getWaitingCount()) > maxWaiting) {
        await sleep(2000)
      }

      const sendDocs = await Promise.all(
        eligible.map(async (contact) => buildSendDoc(broadcast, template, contact, ctx, scheduledMs, respectTimezone)),
      )

      // Filter out suppressed (mailer-side suppression check is the same one
      // dispatchSend would do; we short-circuit here to avoid enqueuing).
      const inserted: Array<{ sendId: ObjectId; delayMs: number }> = []
      for (const { doc, delayMs } of sendDocs) {
        if (!doc) continue
        try {
          await ctx.collections.sends.insertOne(doc)
          inserted.push({ sendId: doc._id!, delayMs })
        } catch (err: any) {
          if (err?.code !== 11000) throw err
          // dup dedupeKey — already dispatched somewhere
        }
      }

      // Bulk enqueue.
      if (inserted.length > 0) {
        await Promise.all(
          inserted.map(({ sendId, delayMs }) =>
            ctx.queues.send.add(
              'send',
              { sendId: String(sendId) },
              {
                attempts: ctx.config.sendRetryAttempts,
                backoff: { type: 'exponential', delay: 60_000 },
                ...(delayMs > 0 ? { delay: delayMs } : {}),
              },
            ),
          ),
        )
      }

      total += inserted.length
    }

    if (!page.nextCursor) break
    cursor = page.nextCursor
  }

  await ctx.collections.broadcasts.updateOne(
    { _id: broadcast._id },
    {
      $set: {
        status: 'sent',
        completedAt: new Date(),
        recipientCount: total,
        updatedAt: new Date(),
      },
    },
  )
}

// ---------------------------------------------------------------------------
// Segment translation
// ---------------------------------------------------------------------------

function toAdapterFilter(seg: SegmentDefinition): AdapterFilter {
  const out: AdapterFilter = {}
  for (const f of seg.filters) {
    switch (f.kind) {
      case 'hasTag':
        out.hasTag = f.tag
        break
      case 'fieldEquals':
        out.fieldEquals = { field: f.field, value: f.value }
        break
      case 'fieldIn':
        out.fieldIn = { field: f.field, values: f.values }
        break
      case 'fieldExists':
        out.fieldExists = f.field
        break
      // notHasTag isn't a single-condition adapter filter, defer to post-filter
      // subscriptionStatus / firedEvent / opened are all mailer-side
    }
  }
  return out
}

function isMailerSide(f: SegmentFilter): boolean {
  return (
    f.kind === 'subscriptionStatus' ||
    f.kind === 'firedEvent' ||
    f.kind === 'notFiredEvent' ||
    f.kind === 'subscribedAfter' ||
    f.kind === 'subscribedBefore' ||
    f.kind === 'opened' ||
    f.kind === 'notOpened' ||
    f.kind === 'notHasTag' ||
    f.kind === 'any' ||
    f.kind === 'not'
  )
}

async function applyPostFilters(contacts: Contact[], filters: SegmentFilter[], ctx: RunnerContext): Promise<Contact[]> {
  if (filters.length === 0) return contacts
  const externalIds = contacts.map((c) => c.externalId)

  // Cache common lookups in one Mongo round-trip per filter.
  const cache: Record<string, Set<string>> = {}
  for (const f of filters) {
    if (f.kind === 'subscriptionStatus') {
      const docs = await ctx.collections.subscriptions
        .find({ externalId: { $in: externalIds }, status: f.equals })
        .project<{ externalId: string }>({ externalId: 1 })
        .toArray()
      cache[`sub:${f.equals}`] = new Set(docs.map((d) => d.externalId))
    }
    if (f.kind === 'firedEvent' || f.kind === 'notFiredEvent') {
      const query: any = { externalId: { $in: externalIds }, name: f.eventName }
      if (f.withinDays) {
        query.occurredAt = { $gt: new Date(Date.now() - f.withinDays * 86_400_000) }
      }
      const docs = await ctx.collections.events
        .find(query)
        .project<{ externalId: string }>({ externalId: 1 })
        .toArray()
      cache[`evt:${f.eventName}`] = new Set(docs.map((d) => d.externalId))
    }
  }

  return contacts.filter((c) => filters.every((f) => filterMatches(c, f, cache)))
}

function filterMatches(c: Contact, f: SegmentFilter, cache: Record<string, Set<string>>): boolean {
  switch (f.kind) {
    case 'subscriptionStatus':
      return cache[`sub:${f.equals}`]?.has(c.externalId) ?? false
    case 'firedEvent':
      return cache[`evt:${f.eventName}`]?.has(c.externalId) ?? false
    case 'notFiredEvent':
      return !cache[`evt:${f.eventName}`]?.has(c.externalId)
    case 'notHasTag':
      return !c.tags.includes(f.tag)
    case 'opened':
    case 'notOpened':
      // V1: not implemented in batch — would need a per-contact send lookup.
      // Treat as pass for now; suppress at dispatch time.
      return true
    case 'subscribedAfter':
    case 'subscribedBefore':
      return true // V2
    case 'any':
      return f.filters.some((sub) => filterMatches(c, sub, cache))
    case 'not':
      return !filterMatches(c, f.filter, cache)
    default:
      return true
  }
}

// ---------------------------------------------------------------------------
// Send doc construction
// ---------------------------------------------------------------------------

interface BuildResult {
  doc: SendDoc | null
  delayMs: number
}

async function buildSendDoc(
  broadcast: BroadcastDoc,
  template: TemplateDoc,
  contact: Contact,
  ctx: RunnerContext,
  scheduledMs: number,
  respectTimezone: boolean,
): Promise<BuildResult> {
  // Final suppression check before we insert.
  const supp = await isSuppressed(ctx.collections, contact.email, template.kind)
  if (supp.suppressed) return { doc: null, delayMs: 0 }

  const sendId = new ObjectId()
  const dedupeKey = `broadcast:${broadcast._id}:${contact.externalId}`

  // Per-recipient TZ delay calculation.
  let delayMs = Math.max(0, scheduledMs - Date.now())
  if (respectTimezone && contact.timezone) {
    delayMs = Math.max(0, perRecipientDelayMs(scheduledMs, contact.timezone))
  }

  const doc: SendDoc = {
    _id: sendId,
    dedupeKey,
    externalId: contact.externalId,
    emailAtSend: contact.email,
    templateId: template._id!,
    templateSlug: template.slug,
    flowRunId: null,
    broadcastId: broadcast._id!,
    manualSendBy: null,
    kind: template.kind,
    provider: template.providerOverride ?? ctx.config.defaultProvider,
    providerMessageId: null,
    fromName: template.fromName,
    fromEmail: template.fromEmail,
    subject: template.subject,
    bodyHash: '',
    status: 'queued',
    errorMessage: null,
    bounceType: null,
    bounceReason: null,
    links: [],
    vars: {},
    openedAt: null,
    openCount: 0,
    firstClickAt: null,
    clickCount: 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt: new Date(),
    sentAt: null,
    deliveredAt: null,
  }
  void sha256Hex
  return { doc, delayMs }
}

/**
 * Compute the delay so the recipient receives the email at `scheduledMs` in
 * their LOCAL timezone (rather than the configured scheduled UTC instant).
 *
 * Example: broadcast `scheduledAt` is 10am UTC, contact is in PST (UTC-8).
 * Without respect: contact gets it at 2am local. With respect: contact gets it
 * at 10am their time = 6pm UTC. delayMs = 8 hours.
 */
function perRecipientDelayMs(scheduledMs: number, timezone: string): number {
  try {
    // Get the offset between the scheduled UTC instant interpreted as a wall
    // clock and the same wall clock in the recipient's tz.
    const scheduled = new Date(scheduledMs)
    const utc = scheduled.toLocaleString('en-US', { timeZone: 'UTC', hour12: false })
    const local = scheduled.toLocaleString('en-US', { timeZone: timezone, hour12: false })

    // Parse both as Date objects in the runner's local tz and take the diff.
    const parse = (s: string) => {
      const m = s.match(/(\d+)\/(\d+)\/(\d+),\s*(\d+):(\d+):(\d+)/)
      if (!m) return 0
      return Date.UTC(+m[3]!, +m[1]! - 1, +m[2]!, +m[4]!, +m[5]!, +m[6]!)
    }
    const utcMs = parse(utc)
    const localMs = parse(local)
    const offsetMs = utcMs - localMs

    // Target = scheduledMs (as a wall-clock in tz) + (utc - local offset) so
    // it lands at the same WALL CLOCK in tz.
    return offsetMs
  } catch {
    return 0
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
