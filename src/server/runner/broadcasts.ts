/**
 * Broadcast dispatch. Picks up scheduled broadcasts whose `scheduledAt` has
 * passed, streams the segment via the adapter cursor + mailer-side post-filter,
 * and bulk-enqueues Send docs + jobs. Per-provider rate limiting + bounded
 * enqueue (pause when waitingCount > broadcastEnqueueMaxWaiting).
 *
 * Who a broadcast reaches is decided in exactly one place,
 * `eligibleRecipientPages`: the host filter, the mailer-side post-filters,
 * a sendable address, and the suppression check. Dispatch and
 * `countBroadcastRecipients` both consume it, which is what lets the agent
 * API refuse a `confirmedCount` that differs from what dispatch will send.
 */

import { ObjectId } from 'mongodb'

import type { Contact } from '../../shared/types.js'
import type { TemplateKind } from '../../shared/enums.js'
import type { BroadcastDoc, SendDoc, TemplateDoc } from '../models/index.js'
import { suppressedEmails } from './suppression.js'
import { applyPostFilters, planSegment } from './segment.js'
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

// ---------------------------------------------------------------------------
// Who a broadcast reaches
// ---------------------------------------------------------------------------

export function broadcastDedupeKey(broadcastId: ObjectId | string, externalId: string): string {
  return `broadcast:${broadcastId}:${externalId}`
}

/** Anything a provider would reject outright is never enqueued. */
const SENDABLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isSendableEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && SENDABLE_EMAIL_RE.test(email)
}

/**
 * Stream the broadcast's eligible recipients, one adapter page at a time:
 * the host filter (stage A), the mailer-side post-filters (stage B), a
 * sendable address, and not suppressed for the template's kind. A yielded
 * page may be empty; the stream ends when the adapter's cursor does.
 */
export async function* eligibleRecipientPages(
  broadcast: Pick<BroadcastDoc, 'segmentDefinition'>,
  kind: TemplateKind,
  ctx: RunnerContext,
): AsyncGenerator<Contact[]> {
  const { hostFilter, postFilters } = planSegment(broadcast.segmentDefinition)
  let cursor: string | undefined
  for (;;) {
    const page = await ctx.adapter.query(hostFilter, { limit: ctx.config.broadcastEnqueueBatchSize, cursor })
    if (page.contacts.length === 0) break
    const passed = (await applyPostFilters(page.contacts, postFilters, ctx)).filter((c) => isSendableEmail(c.email))
    const suppressed = await suppressedEmails(ctx.collections, passed.map((c) => c.email), kind)
    yield passed.filter((c) => !suppressed.has(c.email.toLowerCase()))
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
}

/** Which of `contacts` already have a send row for this broadcast. */
async function alreadyDispatched(ctx: RunnerContext, broadcastId: ObjectId, contacts: Contact[]): Promise<Set<string>> {
  if (contacts.length === 0) return new Set()
  const keys = contacts.map((c) => broadcastDedupeKey(broadcastId, c.externalId))
  const found = await ctx.collections.sends.distinct('dedupeKey', { dedupeKey: { $in: keys } })
  return new Set(found.map(String))
}

export interface BroadcastRecipientCount {
  /** Stage A alone: what the host filter matches. An upper bound. */
  hostMatched: number
  /** After post-filters, the sendable-address check and suppression. */
  eligible: number
  /** Eligible contacts that already have a send row for this broadcast. */
  alreadySent: number
  /** What dispatch would enqueue now: eligible, minus already sent. */
  recipientCount: number
  computedMs: number
}

/**
 * The true recipient count: the same stream dispatch consumes, counted
 * instead of enqueued. Costs one pass over the host filter's matches.
 */
export async function countBroadcastRecipients(
  broadcast: Pick<BroadcastDoc, '_id' | 'segmentDefinition'>,
  kind: TemplateKind,
  ctx: RunnerContext,
): Promise<BroadcastRecipientCount> {
  const t0 = Date.now()
  const { hostFilter } = planSegment(broadcast.segmentDefinition)
  const hostMatched = await ctx.adapter.count(hostFilter)
  let eligible = 0
  let alreadySent = 0
  for await (const page of eligibleRecipientPages(broadcast, kind, ctx)) {
    eligible += page.length
    if (broadcast._id) alreadySent += (await alreadyDispatched(ctx, broadcast._id, page)).size
  }
  return { hostMatched, eligible, alreadySent, recipientCount: eligible - alreadySent, computedMs: Date.now() - t0 }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchBroadcast(broadcast: BroadcastDoc, ctx: RunnerContext): Promise<void> {
  const template = await ctx.collections.templates.findOne({ slug: broadcast.templateSlug })
  if (!template) {
    await ctx.collections.broadcasts.updateOne(
      { _id: broadcast._id },
      { $set: { status: 'failed', updatedAt: new Date() } },
    )
    return
  }

  const maxWaiting = ctx.config.broadcastEnqueueMaxWaiting
  const respectTimezone = broadcast.respectRecipientTimezone === true
  const scheduledMs = broadcast.scheduledAt?.getTime() ?? Date.now()
  const heartbeat = () =>
    ctx.collections.broadcasts.updateOne({ _id: broadcast._id }, { $set: { updatedAt: new Date() } })

  // Progress heartbeat — resumeStalledBroadcasts treats a stale updatedAt
  // as a dead dispatcher, so touch it every page (and during backpressure).
  await heartbeat()
  for await (const eligible of eligibleRecipientPages(broadcast, template.kind, ctx)) {
    await heartbeat()
    const seen = await alreadyDispatched(ctx, broadcast._id!, eligible)
    const fresh = eligible.filter((c) => !seen.has(broadcastDedupeKey(broadcast._id!, c.externalId)))
    if (fresh.length === 0) continue

    // Backpressure: wait until the send queue's waiting set drains below cap.
    while ((await ctx.queues.send.getWaitingCount()) > maxWaiting) {
      await heartbeat()
      await sleep(2000)
    }

    const inserted: Array<{ sendId: ObjectId; delayMs: number }> = []
    for (const contact of fresh) {
      const { doc, delayMs } = buildSendDoc(broadcast, template, contact, ctx, scheduledMs, respectTimezone)
      try {
        await ctx.collections.sends.insertOne(doc)
        inserted.push({ sendId: doc._id!, delayMs })
      } catch (err: any) {
        if (err?.code !== 11000) throw err
        // dup dedupeKey — a concurrent dispatcher got there first
      }
    }

    // Bulk enqueue.
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

  await ctx.collections.broadcasts.updateOne(
    { _id: broadcast._id },
    {
      $set: {
        status: 'sent',
        completedAt: new Date(),
        // Every send row this broadcast has, across re-dispatches.
        recipientCount: await ctx.collections.sends.countDocuments({ broadcastId: broadcast._id }),
        updatedAt: new Date(),
      },
    },
  )
}

// ---------------------------------------------------------------------------
// Send doc construction
// ---------------------------------------------------------------------------

interface BuildResult {
  doc: SendDoc
  delayMs: number
}

function buildSendDoc(
  broadcast: BroadcastDoc,
  template: TemplateDoc,
  contact: Contact,
  ctx: RunnerContext,
  scheduledMs: number,
  respectTimezone: boolean,
): BuildResult {
  const sendId = new ObjectId()
  const dedupeKey = broadcastDedupeKey(broadcast._id!, contact.externalId)

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
