/**
 * Broadcast operations shared by the admin JSON API and the agent router.
 *
 * Both surfaces create, edit, schedule and cancel broadcasts; before this
 * module the logic lived inline in admin.ts, so the agent router would have
 * needed a second copy — and a second copy is how the two start disagreeing
 * about what "scheduled" means. Every function here takes the Mailer, the
 * audit actor and plain inputs, and reports failure by throwing
 * `BroadcastOperationError`, which each router maps to its own response shape.
 */

import { ObjectId } from 'mongodb'
import { z } from 'zod'

import type { Mailer } from '../mailer.js'
import type { BroadcastDoc } from '../models/index.js'
import type { SegmentDefinition } from '../../shared/types.js'
import { slugSchema } from '../../shared/schemas.js'

/** A typed failure the HTTP layer can map to a status code without guessing. */
export class BroadcastOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'BroadcastOperationError'
  }
}

export const DEFAULT_SEGMENT: SegmentDefinition = {
  filters: [{ kind: 'subscriptionStatus', equals: 'subscribed' }],
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateBroadcastInput {
  slug: string
  name: string
  templateSlug: string
  segmentDefinition?: SegmentDefinition
  respectRecipientTimezone?: boolean
}

export interface PatchBroadcastInput {
  name?: string
  templateSlug?: string
  segmentDefinition?: SegmentDefinition
  respectRecipientTimezone?: boolean
}

export interface ScheduleBroadcastInput {
  scheduledAt: unknown
  confirmedCount: unknown
  respectRecipientTimezone?: boolean
}

/** Agent-path request bodies. The admin routes keep their historical, looser parsing. */
export const agentCreateBroadcastSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  templateSlug: slugSchema,
  segmentDefinition: z.object({ filters: z.array(z.any()) }).optional(),
  respectRecipientTimezone: z.boolean().optional(),
})

export const agentPatchBroadcastSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  templateSlug: slugSchema.optional(),
  segmentDefinition: z.object({ filters: z.array(z.any()) }).optional(),
  respectRecipientTimezone: z.boolean().optional(),
})

export const agentScheduleBroadcastSchema = z.object({
  scheduledAt: z.string().min(1),
  confirmedCount: z.number().int().nonnegative(),
  respectRecipientTimezone: z.boolean().optional(),
})

/** Options that differ between the admin path and the agent path. */
export interface BroadcastOpOptions {
  /**
   * Refuse any segment that is not restricted, at the top level, to
   * `subscriptionStatus: subscribed`. The agent path sets this.
   */
  requireSubscribed?: boolean
}

/**
 * The agent-path guard. A segment's host filter streams the host's contact
 * store — for a Mongo-backed host, the `users` collection, every account ever
 * created — and only a mailer-side `subscriptionStatus` filter narrows that to
 * people who opted in. A segment without it mails every account the host
 * filter matches, consented or not. The filter has to sit at the TOP level
 * (AND-ed): nested inside `any` or `not` it no longer restricts anything.
 */
export function assertSubscribedSegment(seg: SegmentDefinition | undefined | null): void {
  const filters = Array.isArray(seg?.filters) ? seg!.filters : []
  const ok = filters.some((f) => f && f.kind === 'subscriptionStatus' && f.equals === 'subscribed')
  if (!ok) {
    throw new BroadcastOperationError(
      'segment_requires_subscribed',
      'the agent API only schedules broadcasts to subscribed contacts: add {"kind": "subscriptionStatus", "equals": "subscribed"} to segmentDefinition.filters (top level)',
      422,
    )
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function loadBroadcast(mailer: Mailer, slug: string): Promise<BroadcastDoc> {
  const b = await mailer.collections.broadcasts.findOne({ slug })
  if (!b) throw new BroadcastOperationError('not_found', `no broadcast with slug "${slug}"`, 404)
  return b
}

// ---------------------------------------------------------------------------
// Create / patch / schedule / cancel
// ---------------------------------------------------------------------------

export async function createBroadcast(
  mailer: Mailer,
  input: CreateBroadcastInput,
  actor: string,
  opts: BroadcastOpOptions = {},
): Promise<BroadcastDoc> {
  const { slug, name, templateSlug } = input
  if (!slug || !name || !templateSlug) {
    throw new BroadcastOperationError('validation_failed', 'slug, name, templateSlug required')
  }
  if (opts.requireSubscribed) assertSubscribedSegment(input.segmentDefinition ?? DEFAULT_SEGMENT)
  const now = new Date()
  const doc: BroadcastDoc = {
    slug,
    name,
    templateSlug,
    segmentDefinition: input.segmentDefinition ?? DEFAULT_SEGMENT,
    status: 'draft',
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    confirmationRequired: true,
    confirmedCount: null,
    confirmedAt: null,
    confirmedBy: null,
    recipientCount: null,
    stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
    createdAt: now,
    createdBy: actor,
    updatedAt: now,
  }
  if (input.respectRecipientTimezone) doc.respectRecipientTimezone = true
  try {
    const res = await mailer.collections.broadcasts.insertOne(doc)
    doc._id = res.insertedId
  } catch (err: any) {
    if (err?.code === 11000) throw new BroadcastOperationError('slug_taken', `slug "${slug}" is taken`, 409)
    throw err
  }
  await mailer.audit({
    actor,
    action: 'broadcast.create',
    resource: { collection: 'mailer_broadcasts', id: doc._id, slug },
  })
  return doc
}

export async function patchBroadcast(
  mailer: Mailer,
  slug: string,
  patch: PatchBroadcastInput,
  actor: string,
  opts: BroadcastOpOptions = {},
): Promise<BroadcastDoc> {
  const b = await loadBroadcast(mailer, slug)
  if (b.status !== 'draft') {
    throw new BroadcastOperationError('not_draft', `broadcast is ${b.status}; only a draft can be edited`, 409)
  }
  if (opts.requireSubscribed && patch.segmentDefinition) assertSubscribedSegment(patch.segmentDefinition)
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (typeof patch.name === 'string') set.name = patch.name
  if (typeof patch.templateSlug === 'string') set.templateSlug = patch.templateSlug
  if (patch.segmentDefinition) set.segmentDefinition = patch.segmentDefinition
  if (typeof patch.respectRecipientTimezone === 'boolean') set.respectRecipientTimezone = patch.respectRecipientTimezone
  // Conditional on draft so a concurrent schedule cannot be edited underneath.
  const res = await mailer.collections.broadcasts.findOneAndUpdate(
    { _id: b._id, status: 'draft' },
    { $set: set },
    { returnDocument: 'after' },
  )
  if (!res) throw new BroadcastOperationError('not_draft', 'broadcast left draft while being edited', 409)
  await mailer.audit({
    actor,
    action: 'broadcast.update',
    resource: { collection: 'mailer_broadcasts', id: b._id, slug },
    diffSummary: Object.keys(set).filter((k) => k !== 'updatedAt').join(', '),
  })
  return res
}

export async function scheduleBroadcast(
  mailer: Mailer,
  slug: string,
  input: ScheduleBroadcastInput,
  actor: string,
  opts: BroadcastOpOptions = {},
): Promise<BroadcastDoc> {
  const b = await loadBroadcast(mailer, slug)
  if (b.status !== 'draft') {
    throw new BroadcastOperationError('not_draft', `broadcast is ${b.status}; only a draft can be scheduled`, 409)
  }
  // Checked again at schedule: a draft created or edited through the admin
  // API never passed the agent-path guard.
  if (opts.requireSubscribed) assertSubscribedSegment(b.segmentDefinition)
  if (!input.scheduledAt) throw new BroadcastOperationError('scheduledAt_required', 'scheduledAt is required')
  const scheduled = new Date(input.scheduledAt as string)
  if (Number.isNaN(scheduled.getTime())) throw new BroadcastOperationError('bad_scheduledAt', 'scheduledAt is not a date')
  if (typeof input.confirmedCount !== 'number') {
    throw new BroadcastOperationError('confirmedCount_required', 'confirmedCount (number) is required')
  }
  const confirmedCount = input.confirmedCount
  const threshold = mailer.config.broadcastConfirmationThreshold

  const set: Record<string, unknown> = {
    status: 'scheduled',
    scheduledAt: scheduled,
    confirmedCount,
    confirmedAt: new Date(),
    confirmedBy: actor,
    updatedAt: new Date(),
  }
  if (input.respectRecipientTimezone) set.respectRecipientTimezone = true

  const res = await mailer.collections.broadcasts.findOneAndUpdate(
    { _id: b._id, status: 'draft' },
    { $set: set },
    { returnDocument: 'after' },
  )
  if (!res) throw new BroadcastOperationError('not_draft', 'broadcast left draft while being scheduled', 409)
  await mailer.audit({
    actor,
    action: 'broadcast.schedule',
    resource: { collection: 'mailer_broadcasts', id: b._id, slug: b.slug },
    diffSummary: `scheduled at ${scheduled.toISOString()} · confirmedCount=${confirmedCount} · threshold=${threshold}`,
  })
  return res
}

export async function cancelBroadcast(
  mailer: Mailer,
  slug: string,
  actor: string,
): Promise<{ broadcast: BroadcastDoc; cancelledSends: number }> {
  const b = await loadBroadcast(mailer, slug)
  await mailer.collections.broadcasts.updateOne({ _id: b._id }, { $set: { status: 'cancelled', updatedAt: new Date() } })
  await mailer.audit({
    actor,
    action: 'broadcast.cancel',
    resource: { collection: 'mailer_broadcasts', id: b._id, slug: b.slug },
  })
  const after = await mailer.collections.broadcasts.findOne({ _id: b._id })
  return { broadcast: after ?? b, cancelledSends: 0 }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface BroadcastStats {
  delivered: number
  opened: number
  clicked: number
  bounced: number
}

export function emptyBroadcastStats(): BroadcastStats {
  return { delivered: 0, opened: 0, clicked: 0, bounced: 0 }
}

/**
 * Per-broadcast stats computed from `mailer_sends` at read time. Test sends
 * (`POST /broadcasts/:slug/test-send`) carry no `broadcastId` and so never
 * count here.
 */
export async function computeBroadcastStats(
  mailer: Mailer,
  idFilter?: ObjectId,
): Promise<Map<string, BroadcastStats>> {
  const out = new Map<string, BroadcastStats>()
  const match: Record<string, unknown> = { broadcastId: { $ne: null } }
  if (idFilter) match.broadcastId = idFilter

  const rows = await mailer.collections.sends
    .aggregate<{
      _id: ObjectId
      delivered: number
      opened: number
      clicked: number
      bounced: number
    }>([
      { $match: match },
      {
        $group: {
          _id: '$broadcastId',
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          opened: { $sum: { $cond: [{ $ifNull: ['$openedAt', false] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ifNull: ['$firstClickAt', false] }, 1, 0] } },
          bounced: { $sum: { $cond: [{ $eq: ['$status', 'bounced'] }, 1, 0] } },
        },
      },
    ])
    .toArray()
  for (const row of rows) {
    if (!row._id) continue
    out.set(String(row._id), {
      delivered: row.delivered,
      opened: row.opened,
      clicked: row.clicked,
      bounced: row.bounced,
    })
  }
  return out
}

/** Send rows for one broadcast, counted by status. */
export async function broadcastStatusBreakdown(mailer: Mailer, broadcastId: ObjectId): Promise<Record<string, number>> {
  const rows = await mailer.collections.sends
    .aggregate<{ _id: string; n: number }>([
      { $match: { broadcastId } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
    .toArray()
  return Object.fromEntries(rows.map((r) => [r._id, r.n]))
}

/** The agent-facing view of a broadcast document. */
export function broadcastSummary(b: BroadcastDoc) {
  return {
    id: String(b._id),
    slug: b.slug,
    name: b.name,
    templateSlug: b.templateSlug,
    status: b.status,
    segmentDefinition: b.segmentDefinition,
    respectRecipientTimezone: b.respectRecipientTimezone === true,
    scheduledAt: b.scheduledAt,
    startedAt: b.startedAt,
    completedAt: b.completedAt,
    confirmedCount: b.confirmedCount,
    confirmedAt: b.confirmedAt,
    confirmedBy: b.confirmedBy,
    recipientCount: b.recipientCount,
    createdAt: b.createdAt,
    createdBy: b.createdBy,
    updatedAt: b.updatedAt,
  }
}
