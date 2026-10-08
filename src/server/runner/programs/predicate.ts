/**
 * Program predicates (0.21): the `fact` leaf (pure) and the subject-scoped
 * evaluator. Contact-scoped leaves have no subject to read from and throw.
 */

import type { FactPredicate, Facts, Predicate } from '../../../shared/types.js'
import type { Collections } from '../../models/index.js'
import { DAY_MS } from './common.js'

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}/

/** Epoch ms for a number, Date or ISO string; NaN for anything else. */
export function toEpochMs(v: unknown): number {
  if (typeof v === 'number') return v
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && ISO_LIKE.test(v)) return Date.parse(v)
  return Number.NaN
}

/** Pure fact-leaf evaluation. See `FactPredicate` for operator semantics. `now` anchors `minAgeDays` / `maxAgeDays`. */
export function evaluateFactPredicate(leaf: FactPredicate, facts: Facts, now: Date = new Date()): boolean {
  void now // plans/17 F1: age operators are implemented in PR A
  const v = facts[leaf.fact]
  const hasEquals = 'equals' in leaf && leaf.equals !== undefined
  const hasOperator =
    hasEquals || leaf.gte !== undefined || leaf.lte !== undefined || leaf.in !== undefined || leaf.exists !== undefined

  if (!hasOperator) return Boolean(v)

  if (leaf.exists !== undefined) {
    const exists = v !== undefined && v !== null
    if (exists !== leaf.exists) return false
  }
  if (hasEquals && !looselyEqual(v, leaf.equals)) return false
  if (leaf.in !== undefined && !leaf.in.some((x) => looselyEqual(v, x))) return false
  if (leaf.gte !== undefined && !(comparable(v, leaf.gte) >= toEpochMs(leaf.gte))) return false
  if (leaf.lte !== undefined && !(comparable(v, leaf.lte) <= toEpochMs(leaf.lte))) return false
  return true
}

function looselyEqual(v: unknown, want: unknown): boolean {
  if (v instanceof Date && want !== null && want !== undefined) return v.getTime() === toEpochMs(want)
  return v === want
}

/** The fact as a number for comparing against `bound`; NaN when it is not comparable. */
function comparable(v: unknown, bound: number | string): number {
  if (typeof bound === 'number' && typeof v === 'number') return v
  if (typeof v === 'number') return Number.isNaN(toEpochMs(bound)) ? Number.NaN : v
  return toEpochMs(v)
}

/**
 * Evaluate a program predicate: `fact` leaves against `facts`;
 * `hasFiredEvent` / `notHasFiredEvent` against `mailer_events` with
 * `externalId = subjectId`; `all` / `any` / `not` recursively. Any other leaf
 * throws (publish validation keeps them out).
 */
export interface ProgramPredicateContext {
  facts: Facts
  subjectId: string
  collections: Collections
  now: Date
  /** `run.enteredAt`; `now` in a facts-only simulation. Anchors `sinceEntry` (plans/17 F1). */
  enteredAt: Date
}

/**
 * The earliest instant strictly after `after` at which a time-based leaf in
 * `pred` (`minAgeDays`, `maxAgeDays`, `sinceEntry.minDays`, `sinceEntry.maxDays`)
 * changes value, or null when there is none. Pure. Event leaves (`withinDays`)
 * are ignored. plans/17 F1.
 */
export function nextPredicateFlipAt(_pred: Predicate, _facts: Facts, _enteredAt: Date, _after: Date): Date | null {
  throw new Error('nextPredicateFlipAt: not implemented (plans/17 PR A)')
}

export async function evaluateProgramPredicate(pred: Predicate, ctx: ProgramPredicateContext): Promise<boolean> {
  const p = pred as any
  if (p && typeof p === 'object') {
    if ('fact' in p) return evaluateFactPredicate(p as FactPredicate, ctx.facts)
    if ('hasFiredEvent' in p) return firedEvent(ctx, p.hasFiredEvent, p.withinDays)
    if ('notHasFiredEvent' in p) return !(await firedEvent(ctx, p.notHasFiredEvent, p.withinDays))
    if ('all' in p) {
      for (const sub of p.all as Predicate[]) if (!(await evaluateProgramPredicate(sub, ctx))) return false
      return true
    }
    if ('any' in p) {
      for (const sub of p.any as Predicate[]) if (await evaluateProgramPredicate(sub, ctx)) return true
      return false
    }
    if ('not' in p) return !(await evaluateProgramPredicate(p.not as Predicate, ctx))
  }
  throw new Error(
    `program predicates support fact, hasFiredEvent, notHasFiredEvent, all, any and not; got ${JSON.stringify(Object.keys(p ?? {}))}`,
  )
}

async function firedEvent(
  ctx: { subjectId: string; collections: Collections; now: Date },
  name: string,
  withinDays: number | undefined,
): Promise<boolean> {
  const filter: Record<string, unknown> = { externalId: ctx.subjectId, name }
  if (withinDays && withinDays > 0) filter.occurredAt = { $gt: new Date(ctx.now.getTime() - withinDays * DAY_MS) }
  const found = await ctx.collections.events.findOne(filter, { projection: { _id: 1 } })
  return !!found
}
