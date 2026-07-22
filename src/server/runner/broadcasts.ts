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
 * Broadcasts stuck in 'sending' with updatedAt older than this are assumed
 * dead (worker crashed mid-dispatch). dispatchBroadcast heartbeats updatedAt
 * on every page, so a stale timestamp means no live dispatcher.
 */
const STALLED_BROADCAST_THRESHOLD_MS = 10 * 60 * 1000

/**
 * Process scheduled broadcasts whose `scheduledAt` has passed. Called from the
 * tick. Marks each broadcast `sending` before dispatch so concurrent ticks
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
    await startBroadcastDispatch(claimed, ctx)
  }
}

/**
 * Hand the (potentially hours-long) recipient enqueue off the tick. With a
 * real queue driver, dispatch runs as an advance job so a large broadcast
 * can't starve trigger scans and sweeps — the tick worker has concurrency 1.
 * The noop driver has no workers (hosts drive the runner synchronously), so
 * dispatch stays inline there.
 */
async function startBroadcastDispatch(broadcast: BroadcastDoc, ctx: RunnerContext): Promise<void> {
  if (ctx.config.queue.driver === 'noop') {
    await runBroadcastDispatch(broadcast, ctx)
    return
  }
  await ctx.queues.advance.add(
    'advance',
    { broadcastId: String(broadcast._id) },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      jobId: `broadcast-dispatch:${broadcast._id}`,
    },
  )
}

/** Advance-worker entry point for `{ broadcastId }` jobs. */
export async function dispatchBroadcastById(broadcastId: ObjectId, ctx: RunnerContext): Promise<void> {
  const broadcast = await ctx.collections.broadcasts.findOne({ _id: broadcastId, status: 'sending' })
  if (!broadcast) return
  await runBroadcastDispatch(broadcast, ctx)
}

/**
 * Rescue broadcasts whose dispatcher died. Re-dispatch is idempotent: the
 * per-recipient dedupeKey unique index skips send rows already inserted, so
 * a resumed broadcast picks up where the dead worker left off.
 */
export async function resumeStalledBroadcasts(ctx: RunnerContext): Promise<void> {
  const cutoff = new Date(Date.now() - STALLED_BROADCAST_THRESHOLD_MS)
  const stalled = await ctx.collections.broadcasts
    .find({ status: 'sending', updatedAt: { $lt: cutoff } })
    .toArray()

  for (const b of stalled) {
    // Touch before re-dispatch so subsequent ticks don't stack rescues.
    await ctx.collections.broadcasts.updateOne(
      { _id: b._id },
      { $set: { updatedAt: new Date() } },
    )
    await startBroadcastDispatch(b, ctx)
  }
}

async function runBroadcastDispatch(broadcast: BroadcastDoc, ctx: RunnerContext): Promise<void> {
  try {
    await dispatchBroadcast(broadcast, ctx)
  } catch (err) {
    console.error('mailery: broadcast dispatch failed', { id: String(broadcast._id), err })
    await ctx.collections.broadcasts.updateOne(
      { _id: broadcast._id },
      { $set: { status: 'failed', updatedAt: new Date() } },
    )
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
    // Progress heartbeat — resumeStalledBroadcasts treats a stale updatedAt
    // as a dead dispatcher, so touch it every page (and during backpressure).
    await ctx.collections.broadcasts.updateOne(
      { _id: broadcast._id },
      { $set: { updatedAt: new Date() } },
    )

    const page = await ctx.adapter.query(hostFilter, { limit: batchSize, cursor })
    if (page.contacts.length === 0) break

    // Stage B: mailer-side post-filter.
    const eligible = await applyPostFilters(page.contacts, postFilters, ctx)

    if (eligible.length > 0) {
      // Backpressure: wait until the send queue's waiting set drains below cap.
      while ((await ctx.queues.send.getWaitingCount()) > maxWaiting) {
        await ctx.collections.broadcasts.updateOne(
          { _id: broadcast._id },
          { $set: { updatedAt: new Date() } },
        )
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

  // Per-recipient TZ delay calculation. Anchored to scheduledAt (not enqueue
  // time) so tick lag and backpressure pauses don't drift later batches.
  let delayMs = Math.max(0, scheduledMs - Date.now())
  if (respectTimezone && contact.timezone) {
    const offsetMs = perRecipientOffsetMs(scheduledMs, contact.timezone)
    delayMs = Math.max(0, scheduledMs + offsetMs - Date.now())
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
    updatedAt: new Date(),
    sentAt: null,
    deliveredAt: null,
  }
  void sha256Hex
  return { doc, delayMs }
}

/**
 * Offset to add to `scheduledMs` so the email arrives at the same WALL-CLOCK
 * time in the recipient's timezone.
 *
 * Example: broadcast `scheduledAt` is 10am UTC, contact is in PST (UTC-8).
 * Their 10am is 6pm UTC → offset +8h.
 *
 * Recipients EAST of the schedule's timezone would need a negative offset —
 * their 10am already passed when dispatch starts. Sending "now" would land at
 * the wrong local time, so instead the offset is normalized into [0, 24h):
 * they get the NEXT occurrence of the wall-clock slot, i.e. same time
 * tomorrow. (Berlin, UTC+2: raw offset −2h → +22h.)
 */
function perRecipientOffsetMs(scheduledMs: number, timezone: string): number {
  const DAY_MS = 24 * 60 * 60 * 1000
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

    return ((offsetMs % DAY_MS) + DAY_MS) % DAY_MS
  } catch {
    return 0
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
