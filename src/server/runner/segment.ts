/**
 * Segment evaluation for broadcasts: split a `SegmentDefinition` into the part
 * the host adapter evaluates (stage A) and the part mailery evaluates over
 * each streamed page (stage B), then run stage B with one batched lookup per
 * distinct filter per page.
 *
 * Stage A takes at most one condition per adapter slot — `AdapterFilter` has a
 * single `hasTag`, a single `fieldEquals` and so on — and only from the top
 * level of the segment, where filters are AND-ed. Everything else is stage B:
 * mailer-side kinds (subscription status, events, opens, subscription dates),
 * a second `hasTag`, a field filter whose field the host filter already uses,
 * and every filter nested inside `any` / `not`. Host-side kinds evaluated in
 * stage B read the adapter's `Contact` projection: `tags`, and `fields`
 * (dotted paths allowed). For MongoContactAdapter's default projection that
 * is every document field; a custom `toContact` decides what is visible.
 *
 * Before 0.18 stage B treated `opened`, `notOpened`, `subscribedAfter`,
 * `subscribedBefore` and any nested host-side filter as a pass — true for
 * every contact — and a second top-level `hasTag` silently replaced the first.
 * Each of those widened a broadcast. An unrecognised kind now throws instead.
 */

import type { AdapterFilter, Contact, SegmentDefinition, SegmentFilter } from '../../shared/types.js'
import type { Collections } from '../models/index.js'

export interface SegmentPlan {
  /** Stage A: handed to `adapter.query` / `adapter.count`. */
  hostFilter: AdapterFilter
  /** Stage B: every top-level filter the host filter did not take. */
  postFilters: SegmentFilter[]
}

export function planSegment(seg: SegmentDefinition): SegmentPlan {
  const hostFilter: AdapterFilter = {}
  const postFilters: SegmentFilter[] = []
  // A Mongo-backed adapter writes each field condition as `query[field] = …`,
  // so two conditions on one field would overwrite each other there. Only the
  // first condition per field goes to the host.
  const hostFields = new Set<string>()
  const takeField = (field: string) => {
    if (hostFields.has(field)) return false
    hostFields.add(field)
    return true
  }

  for (const f of seg.filters ?? []) {
    switch (f.kind) {
      case 'hasTag':
        if (hostFilter.hasTag === undefined) {
          hostFilter.hasTag = f.tag
          continue
        }
        break
      case 'fieldEquals':
        if (!hostFilter.fieldEquals && takeField(f.field)) {
          hostFilter.fieldEquals = { field: f.field, value: f.value }
          continue
        }
        break
      case 'fieldIn':
        if (!hostFilter.fieldIn && takeField(f.field)) {
          hostFilter.fieldIn = { field: f.field, values: f.values }
          continue
        }
        break
      case 'fieldExists':
        if (!hostFilter.fieldExists && takeField(f.field)) {
          hostFilter.fieldExists = f.field
          continue
        }
        break
    }
    postFilters.push(f)
  }
  return { hostFilter, postFilters }
}

type LookupCtx = { collections: Collections }

/**
 * Stage B over one page of contacts. One query per distinct lookup (a
 * `distinct` over the page's externalIds), however deeply the filter sits.
 */
export async function applyPostFilters(
  contacts: Contact[],
  filters: SegmentFilter[],
  ctx: LookupCtx,
  now: Date = new Date(),
): Promise<Contact[]> {
  if (filters.length === 0 || contacts.length === 0) return contacts
  const externalIds = contacts.map((c) => c.externalId)

  const leaves = new Map<string, SegmentFilter>()
  collectLookups(filters, leaves)
  const cache = new Map<string, Set<string>>()
  await Promise.all(
    [...leaves].map(async ([key, f]) => {
      cache.set(key, await lookup(f, externalIds, ctx, now))
    }),
  )

  return contacts.filter((c) => filters.every((f) => matches(c, f, cache)))
}

/** Cache key for a filter that needs a database lookup; null for in-memory kinds. */
function lookupKey(f: SegmentFilter): string | null {
  switch (f.kind) {
    case 'subscriptionStatus':
      return `sub:${f.equals}`
    case 'firedEvent':
    case 'notFiredEvent':
      // The key carries the window: `firedEvent X` and `notFiredEvent X
      // withinDays 30` are different sets, and used to share one cache slot.
      return `evt:${f.withinDays ?? ''}:${f.eventName}`
    case 'opened':
    case 'notOpened':
      return `open:${f.withinDays ?? ''}:${f.templateSlug ?? ''}`
    case 'subscribedAfter':
      return `subAfter:${toDate(f.date).getTime()}`
    case 'subscribedBefore':
      return `subBefore:${toDate(f.date).getTime()}`
    default:
      return null
  }
}

function collectLookups(filters: SegmentFilter[], out: Map<string, SegmentFilter>): void {
  for (const f of filters) {
    if (f.kind === 'any') collectLookups(f.filters, out)
    else if (f.kind === 'not') collectLookups([f.filter], out)
    else {
      const key = lookupKey(f)
      if (key && !out.has(key)) out.set(key, f)
    }
  }
}

async function lookup(f: SegmentFilter, externalIds: string[], ctx: LookupCtx, now: Date): Promise<Set<string>> {
  const c = ctx.collections
  const inPage = { $in: externalIds }
  const since = (days: number | undefined) => (days ? new Date(now.getTime() - days * 86_400_000) : null)
  let ids: string[]
  switch (f.kind) {
    case 'subscriptionStatus':
      ids = await c.subscriptions.distinct('externalId', { externalId: inPage, status: f.equals })
      break
    case 'firedEvent':
    case 'notFiredEvent': {
      const cutoff = since(f.withinDays)
      ids = await c.events.distinct('externalId', {
        externalId: inPage,
        name: f.eventName,
        ...(cutoff ? { occurredAt: { $gt: cutoff } } : {}),
      })
      break
    }
    case 'opened':
    case 'notOpened': {
      const cutoff = since(f.withinDays)
      ids = await c.sends.distinct('externalId', {
        externalId: inPage,
        openedAt: cutoff ? { $gt: cutoff } : { $ne: null },
        ...(f.templateSlug ? { templateSlug: f.templateSlug } : {}),
      })
      break
    }
    case 'subscribedAfter':
      ids = await c.subscriptions.distinct('externalId', { externalId: inPage, subscribedAt: { $gt: toDate(f.date) } })
      break
    case 'subscribedBefore':
      ids = await c.subscriptions.distinct('externalId', { externalId: inPage, subscribedAt: { $lt: toDate(f.date) } })
      break
    default:
      ids = []
  }
  return new Set(ids.map(String))
}

function matches(c: Contact, f: SegmentFilter, cache: Map<string, Set<string>>): boolean {
  switch (f.kind) {
    case 'subscriptionStatus':
    case 'firedEvent':
    case 'opened':
    case 'subscribedAfter':
    case 'subscribedBefore':
      return cache.get(lookupKey(f)!)?.has(c.externalId) ?? false
    case 'notFiredEvent':
    case 'notOpened':
      return !(cache.get(lookupKey(f)!)?.has(c.externalId) ?? false)
    case 'hasTag':
      return c.tags.includes(f.tag)
    case 'notHasTag':
      return !c.tags.includes(f.tag)
    case 'fieldEquals':
      return valuesEqual(fieldValue(c, f.field), f.value)
    case 'fieldIn': {
      const v = fieldValue(c, f.field)
      return f.values.some((x) => valuesEqual(v, x))
    }
    case 'fieldExists':
      return fieldValue(c, f.field) !== undefined
    case 'any':
      return f.filters.some((sub) => matches(c, sub, cache))
    case 'not':
      return !matches(c, f.filter, cache)
    default:
      // Never default to "matches": an unknown kind would widen the send.
      throw new Error(`mailery: unknown segment filter kind "${(f as { kind?: string }).kind}"`)
  }
}

function fieldValue(c: Contact, path: string): unknown {
  let cur: unknown = c.fields
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a as string).getTime()
    const tb = b instanceof Date ? b.getTime() : new Date(b as string).getTime()
    return !Number.isNaN(ta) && ta === tb
  }
  // A host ObjectId against a string from a segment.
  if (a && typeof a === 'object' && typeof (a as { toHexString?: unknown }).toHexString === 'function') {
    return String(a) === String(b)
  }
  return a === b
}

/** Segments stored before validation existed may hold the date as a string. */
function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d)
}
