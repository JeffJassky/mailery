/**
 * Predicate evaluator. Resolves all Predicate variants from `shared/types.ts`
 * against a Contact (host-side fields/tags) + mailer state (events, sends,
 * subscription).
 *
 * Network calls hit Mongo. Cache the Contact at the call site if you evaluate
 * many predicates in a row.
 */

import type { Contact, Predicate } from '../../shared/types.js'
import type { BotFilterConfig } from '../config.js'
import type { Collections, FlowRunDoc, SendDoc } from '../models/index.js'

export interface PredicateContext {
  contact: Contact
  run: FlowRunDoc
  collections: Collections
  now?: Date
  /**
   * Tuning for the `…ExcludingBots` / `…AtLeastN` predicates. Omit for the
   * defaults (`DEFAULT_BOT_UA_RE`, no timing filter).
   */
  botFilter?: BotFilterConfig
}

/**
 * User agents treated as automated unless the host overrides
 * `botFilter.userAgentPattern`. Deliberately short: these are the scanners that
 * announce themselves. Anything that impersonates a browser is not catchable
 * from the UA string and is out of scope here — see INVARIANT 7.
 */
export const DEFAULT_BOT_UA_RE = /Mimecast|SafeLinks|proofpoint|HeadlessChrome|Googlebot|bingbot/i

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

  // Bot filtering is best-effort by construction — see INVARIANT 7. A send
  // counts when at least one of its recorded opens (or clicks) looks human;
  // one scanner hit does not disqualify a send the recipient also read.
  const docs = await ctx.collections.sends.find(filter).limit(1000).toArray()
  const botRe = ctx.botFilter?.userAgentPattern ?? DEFAULT_BOT_UA_RE
  const minOpenDelayMs = ctx.botFilter?.minOpenDelayMs ?? 0
  let n = 0
  for (const s of docs) {
    const doc = s as SendDoc
    const human =
      kind === 'opened'
        ? hasHumanOpen(doc, botRe, minOpenDelayMs)
        : (doc.clickedLinks ?? []).some((c) => !isBotUserAgent(c.userAgent, botRe))
    if (human) n++
  }
  return n
}

/**
 * A user agent is "bot" only when it is present *and* matches the pattern.
 *
 * Unknown counts as human. That is the deliberate choice, and it is the same
 * one the click path has always made:
 *
 *   - Image fetches frequently carry no `User-Agent` at all, and Apple Mail
 *     Privacy Protection proxies strip identifying headers. Scoring unknown as
 *     bot would drop a large share of genuine opens on the floor, silently.
 *   - It preserves today's counts for sends recorded before user agents were
 *     stored, so enabling this fix cannot retroactively empty a running flow.
 *
 * The cost is that a scanner which sends no UA still counts. Treating unknown
 * as bot would be the safer posture against forgery, but forgery is what the
 * URL signature is for; this filter's job is only to be honest about scanners
 * that identify themselves.
 */
function isBotUserAgent(ua: string | null | undefined, botRe: RegExp): boolean {
  if (typeof ua !== 'string' || ua.trim() === '') return false
  return botRe.test(ua)
}

/**
 * Does this send have at least one open that looks like a person?
 *
 * Sends recorded before `opens[]` existed fall back to the single `openedAt`
 * timestamp with an unknown user agent — which, per the rule above, counts as
 * human. Legacy data therefore behaves exactly as it does today.
 */
function hasHumanOpen(send: SendDoc, botRe: RegExp, minOpenDelayMs: number): boolean {
  const opens =
    send.opens && send.opens.length > 0
      ? send.opens
      : send.openedAt
        ? [{ openedAt: send.openedAt, userAgent: null }]
        : []
  return opens.some((o) => {
    if (isBotUserAgent(o.userAgent, botRe)) return false
    if (isPrefetchOpen(o.openedAt, send.queuedAt, minOpenDelayMs)) return false
    return true
  })
}

/**
 * Optional second signal (`botFilter.minOpenDelayMs`, default 0 = off): an open
 * that lands within a few seconds of the send being queued is a gateway
 * prefetch or a security scanner, not a reader.
 *
 * Off by default — a recipient who happens to be looking at their inbox when
 * the mail arrives is a real false positive, and turning it on silently changes
 * the numbers every existing flow branches on.
 */
function isPrefetchOpen(openedAt: unknown, queuedAt: unknown, minOpenDelayMs: number): boolean {
  if (!minOpenDelayMs || minOpenDelayMs <= 0) return false
  if (!(openedAt instanceof Date) || !(queuedAt instanceof Date)) return false
  const delta = openedAt.getTime() - queuedAt.getTime()
  if (!Number.isFinite(delta) || delta < 0) return false
  return delta < minOpenDelayMs
}

function effectiveLowerBound(ctx: PredicateContext, opts: { sinceFlowStart?: boolean; withinDays?: number }): Date | null {
  const now = ctx.now ?? new Date()
  if (opts.sinceFlowStart) return ctx.run.enteredAt
  if (opts.withinDays && opts.withinDays > 0) {
    return new Date(now.getTime() - opts.withinDays * 24 * 60 * 60 * 1000)
  }
  return null
}
