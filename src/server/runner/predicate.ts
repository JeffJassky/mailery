/**
 * Predicate evaluator. Resolves all Predicate variants from `shared/types.ts`
 * against a Contact (host-side fields/tags) + mailer state (events, sends,
 * subscription).
 *
 * Network calls hit Mongo. Cache the Contact at the call site if you evaluate
 * many predicates in a row.
 */

import type { Contact, Predicate } from '../../shared/types.js'
import type { Collections, FlowRunDoc, SendDoc } from '../models/index.js'

export interface PredicateContext {
  contact: Contact
  run: FlowRunDoc
  collections: Collections
  now?: Date
}

const BOT_UA_RE = /Mimecast|SafeLinks|proofpoint|HeadlessChrome|Googlebot|bingbot/i

export async function evaluatePredicate(
  predicate: Predicate,
  ctx: PredicateContext,
): Promise<boolean> {
  const p = predicate as any

  if ('hasTag' in p) return ctx.contact.tags.includes(p.hasTag)
  if ('notHasTag' in p) return !ctx.contact.tags.includes(p.notHasTag)

  if ('fieldEquals' in p) {
    return ctx.contact.fields[p.fieldEquals.field] === p.fieldEquals.value
  }
  if ('fieldExists' in p) {
    return ctx.contact.fields[p.fieldExists] !== undefined
  }

  // Read from the run's own trigger event, NOT the contact — two concurrent
  // runs for the same person can legitimately disagree here.
  if ('triggerPropertyEquals' in p) {
    return (
      (ctx.run.triggerEvent?.properties ?? {})[p.triggerPropertyEquals.key] ===
      p.triggerPropertyEquals.value
    )
  }
  if ('triggerPropertyTruthy' in p) {
    return Boolean((ctx.run.triggerEvent?.properties ?? {})[p.triggerPropertyTruthy])
  }

  if ('subscriptionStatus' in p) {
    const sub = await ctx.collections.subscriptions.findOne({ externalId: ctx.contact.externalId })
    return sub?.status === p.subscriptionStatus
  }

  if ('hasFiredEvent' in p) {
    return hasEvent(ctx, p.hasFiredEvent, { sinceFlowStart: p.sinceFlowStart, withinDays: p.withinDays })
  }
  if ('notHasFiredEvent' in p) {
    return !(await hasEvent(ctx, p.notHasFiredEvent, { withinDays: p.withinDays }))
  }

  if ('hasOpened' in p) return await openOrClickCount(ctx, 'opened', p.hasOpened, false) > 0
  if ('hasClicked' in p) return await openOrClickCount(ctx, 'clicked', p.hasClicked, false) > 0
  if ('hasOpenedExcludingBots' in p) return await openOrClickCount(ctx, 'opened', p.hasOpenedExcludingBots, true) > 0
  if ('hasClickedExcludingBots' in p) return await openOrClickCount(ctx, 'clicked', p.hasClickedExcludingBots, true) > 0
  if ('openedAtLeastN' in p) return await openOrClickCount(ctx, 'opened', p.openedAtLeastN, true) >= p.openedAtLeastN.count
  if ('clickedAtLeastN' in p) return await openOrClickCount(ctx, 'clicked', p.clickedAtLeastN, true) >= p.clickedAtLeastN.count

  if ('all' in p) {
    for (const sub of p.all) {
      if (!(await evaluatePredicate(sub, ctx))) return false
    }
    return true
  }
  if ('any' in p) {
    for (const sub of p.any) {
      if (await evaluatePredicate(sub, ctx)) return true
    }
    return false
  }
  if ('not' in p) {
    return !(await evaluatePredicate(p.not, ctx))
  }

  return false
}

async function hasEvent(
  ctx: PredicateContext,
  name: string,
  opts: { sinceFlowStart?: boolean; withinDays?: number },
): Promise<boolean> {
  const filter: any = { externalId: ctx.contact.externalId, name }
  const lower = effectiveLowerBound(ctx, opts)
  if (lower) filter.occurredAt = { $gt: lower }
  const found = await ctx.collections.events.findOne(filter, { projection: { _id: 1 } })
  return !!found
}

async function openOrClickCount(
  ctx: PredicateContext,
  kind: 'opened' | 'clicked',
  opts: { templateSlug?: string; sinceFlowStart?: boolean; withinDays?: number },
  excludeBots: boolean,
): Promise<number> {
  const filter: any = { externalId: ctx.contact.externalId }
  if (opts.templateSlug) filter.templateSlug = opts.templateSlug
  if (kind === 'opened') filter.openedAt = { $ne: null }
  if (kind === 'clicked') filter.firstClickAt = { $ne: null }
  const lower = effectiveLowerBound(ctx, opts)
  if (lower) filter[kind === 'opened' ? 'openedAt' : 'firstClickAt'] = { $gt: lower }

  if (!excludeBots) {
    return await ctx.collections.sends.countDocuments(filter)
  }

  // Bot filter is best-effort: we only know UA for clicks (open pixel hits don't reliably carry one)
  const docs = await ctx.collections.sends.find(filter).limit(1000).toArray()
  let n = 0
  for (const s of docs) {
    if (kind === 'opened') {
      n++
      continue
    }
    const hasHumanClick = (s as SendDoc).clickedLinks?.some((c: any) => !c.userAgent || !BOT_UA_RE.test(c.userAgent))
    if (hasHumanClick) n++
  }
  return n
}

function effectiveLowerBound(ctx: PredicateContext, opts: { sinceFlowStart?: boolean; withinDays?: number }): Date | null {
  const now = ctx.now ?? new Date()
  if (opts.sinceFlowStart) return ctx.run.enteredAt
  if (opts.withinDays && opts.withinDays > 0) {
    return new Date(now.getTime() - opts.withinDays * 24 * 60 * 60 * 1000)
  }
  return null
}
