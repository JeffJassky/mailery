/**
 * Relative-time conditions — plans/17-cadence-controls.md F1.
 *
 *   fact leaf     minAgeDays / maxAgeDays on a date fact: age = (now − fact) in days,
 *                 minAgeDays → age ≥ n, maxAgeDays → age < n; unknown date → false
 *   sinceEntry    { minDays, maxDays } against run.enteredAt (now in a facts-only
 *                 simulation): days ≥ minDays, days < maxDays
 *   flip          nextPredicateFlipAt: the next instant a time leaf changes value
 *   wake          a none-eligible tick wakes at min(now + minGapDays, flip)
 *   guard         the dispatch guard evaluates with the run's enteredAt
 *   board         the simulator waits for the flip and projects from it
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { buildProgram, tickProgram } from '../../src/testing/index.js'
import {
  evaluateFactPredicate,
  evaluateProgramPredicate,
  nextPredicateFlipAt,
} from '../../src/server/runner/programs/index.js'
import { validateProgramDefinition, type ProgramValidationContext } from '../../src/server/programs/validate.js'
import { predicateSchema, programPredicateSchema } from '../../src/shared/schemas.js'
import type { FactPredicate, Facts, Predicate, ProgramDefinition } from '../../src/shared/types.js'
import { advance, DAY, HOUR, restoreClock } from '../matrix/clock.js'
import {
  CATEGORY,
  DECLARE,
  delivered,
  dispatch,
  enter,
  getRun,
  lastDecision,
  programHarness,
  programSends,
  seedProgramWithTemplates,
  startClock,
  subject,
  type ProgramHarness,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Pure: the fact leaf
// ---------------------------------------------------------------------------

const NOW = new Date('2027-03-10T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

const facts: Facts = {
  signed_up_at: daysAgo(5),
  iso: daysAgo(5).toISOString(),
  epoch: daysAgo(5).getTime(),
  future: daysAgo(-1),
  nil: null,
  str: 'not a date',
}

const leafCases: Array<[FactPredicate, boolean]> = [
  // minAgeDays: age ≥ n (age is exactly 5 days)
  [{ fact: 'signed_up_at', minAgeDays: 5 }, true],
  [{ fact: 'signed_up_at', minAgeDays: 5.001 }, false],
  [{ fact: 'signed_up_at', minAgeDays: 3 }, true],
  [{ fact: 'signed_up_at', minAgeDays: 6 }, false],
  [{ fact: 'signed_up_at', minAgeDays: 0 }, true],
  // maxAgeDays: age < n
  [{ fact: 'signed_up_at', maxAgeDays: 7 }, true],
  [{ fact: 'signed_up_at', maxAgeDays: 5 }, false],
  [{ fact: 'signed_up_at', maxAgeDays: 5.001 }, true],
  // both → a window
  [{ fact: 'signed_up_at', minAgeDays: 3, maxAgeDays: 7 }, true],
  [{ fact: 'signed_up_at', minAgeDays: 6, maxAgeDays: 7 }, false],
  [{ fact: 'signed_up_at', minAgeDays: 3, maxAgeDays: 5 }, false],
  // ISO strings and epoch numbers are dates too
  [{ fact: 'iso', minAgeDays: 3 }, true],
  [{ fact: 'iso', maxAgeDays: 3 }, false],
  [{ fact: 'epoch', maxAgeDays: 7 }, true],
  // the future has a negative age
  [{ fact: 'future', minAgeDays: 0 }, false],
  [{ fact: 'future', maxAgeDays: 1 }, true],
  // an unknown date is neither old enough nor recent
  [{ fact: 'nil', minAgeDays: 0 }, false],
  [{ fact: 'nil', maxAgeDays: 100 }, false],
  [{ fact: 'missing', minAgeDays: 0 }, false],
  [{ fact: 'missing', maxAgeDays: 100 }, false],
  [{ fact: 'str', minAgeDays: 0 }, false],
  [{ fact: 'str', maxAgeDays: 100 }, false],
  // other operators on the same leaf still AND
  [{ fact: 'signed_up_at', exists: true, minAgeDays: 3 }, true],
  [{ fact: 'signed_up_at', equals: null, minAgeDays: 3 }, false],
  [{ fact: 'signed_up_at', gte: '2027-03-01T00:00:00Z', maxAgeDays: 7 }, true],
  [{ fact: 'signed_up_at', gte: '2027-03-06T00:00:00Z', maxAgeDays: 7 }, false],
]

describe('evaluateFactPredicate — minAgeDays / maxAgeDays', () => {
  for (const [p, want] of leafCases) {
    it(`${JSON.stringify(p)} → ${want}`, () => {
      expect(evaluateFactPredicate(p, facts, NOW)).toBe(want)
    })
  }
  it('`now` defaults to the clock', () => {
    expect(evaluateFactPredicate({ fact: 'd', minAgeDays: 4 }, { d: new Date(Date.now() - 5 * DAY) })).toBe(true)
    expect(evaluateFactPredicate({ fact: 'd', maxAgeDays: 4 }, { d: new Date(Date.now() - 5 * DAY) })).toBe(false)
  })
  it('the old operators are unchanged by the new ones being absent', () => {
    expect(evaluateFactPredicate({ fact: 'signed_up_at', gte: '2027-03-01T00:00:00Z' }, facts, NOW)).toBe(true)
    expect(evaluateFactPredicate({ fact: 'nil', exists: false }, facts, NOW)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pure: the flip
// ---------------------------------------------------------------------------

describe('nextPredicateFlipAt', () => {
  const entered = daysAgo(3)
  const flip = (p: unknown, f: Facts = facts, after: Date = NOW) => nextPredicateFlipAt(p as Predicate, f, entered, after)
  const at = (days: number) => new Date(NOW.getTime() + days * DAY)

  it('minAgeDays flips when the fact reaches that age', () => {
    expect(flip({ fact: 'signed_up_at', minAgeDays: 7 })).toEqual(at(2))
  })
  it('a threshold already passed is not a flip', () => {
    expect(flip({ fact: 'signed_up_at', minAgeDays: 3 })).toBeNull()
    expect(flip({ fact: 'signed_up_at', minAgeDays: 5 })).toBeNull() // exactly now is not strictly after
  })
  it('maxAgeDays flips (to false) when the fact reaches that age', () => {
    expect(flip({ fact: 'signed_up_at', maxAgeDays: 7 })).toEqual(at(2))
  })
  it('sinceEntry thresholds are measured from enteredAt', () => {
    expect(flip({ sinceEntry: { minDays: 5 } })).toEqual(at(2))
    expect(flip({ sinceEntry: { maxDays: 10 } })).toEqual(at(7))
    expect(flip({ sinceEntry: { minDays: 5, maxDays: 10 } })).toEqual(at(2))
    expect(flip({ sinceEntry: { minDays: 1 } })).toBeNull()
  })
  it('groups and negations take the earliest flip among their leaves', () => {
    expect(flip({ all: [{ sinceEntry: { minDays: 5 } }, { fact: 'signed_up_at', maxAgeDays: 6 }] })).toEqual(at(1))
    expect(flip({ any: [{ fact: 'ga4' }, { sinceEntry: { minDays: 5 } }] })).toEqual(at(2))
    expect(flip({ not: { sinceEntry: { minDays: 5 } } })).toEqual(at(2))
  })
  it('leaves without a time threshold never flip', () => {
    expect(flip({ fact: 'signed_up_at' })).toBeNull()
    expect(flip({ fact: 'signed_up_at', gte: '2027-01-01' })).toBeNull()
    expect(flip({ hasFiredEvent: 'Upgraded', withinDays: 3 })).toBeNull()
    expect(flip({ all: [{ fact: 'a' }, { fact: 'b', exists: true }] })).toBeNull()
  })
  it('an unknown date never flips', () => {
    expect(flip({ fact: 'nil', minAgeDays: 3 })).toBeNull()
    expect(flip({ fact: 'missing', maxAgeDays: 3 })).toBeNull()
    expect(flip({ fact: 'str', minAgeDays: 3 })).toBeNull()
  })
  it('ISO string facts work', () => {
    expect(flip({ fact: 'iso', minAgeDays: 7 })).toEqual(at(2))
  })
  it('`after` moves the search forward', () => {
    expect(flip({ all: [{ sinceEntry: { minDays: 5 } }, { sinceEntry: { minDays: 9 } }] }, facts, at(3))).toEqual(at(6))
  })
})

// ---------------------------------------------------------------------------
// Schema and publish validation
// ---------------------------------------------------------------------------

describe('schema and validation', () => {
  const C = CATEGORY
  function ctx(): ProgramValidationContext {
    const templates = new Map<string, { kind: 'marketing' | 'transactional'; category?: string | null }>()
    for (const slug of ['a-1', 'a-2', 'b-1']) templates.set(slug, { kind: 'marketing', category: C })
    return { categories: [{ id: C, label: 'Tips' }], facts: { ...DECLARE } as any, templates }
  }
  function withEligible(eligible: unknown): ProgramDefinition {
    return buildProgram({
      slug: 'rel',
      actions: [{ id: 'a', priority: 3, attempts: 2, satisfied: { fact: 'shopify_connected' }, eligible: eligible as any }],
    })
  }
  const issues = (def: unknown) => {
    const r = validateProgramDefinition(def, ctx())
    return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`)
  }

  it('accepts age operators on a date fact and sinceEntry leaves', () => {
    expect(issues(withEligible({ fact: 'signed_up_at', minAgeDays: 3 }))).toEqual([])
    expect(issues(withEligible({ fact: 'signed_up_at', minAgeDays: 3, maxAgeDays: 7 }))).toEqual([])
    expect(issues(withEligible({ sinceEntry: { minDays: 2 } }))).toEqual([])
    expect(issues(withEligible({ all: [{ sinceEntry: { maxDays: 7 } }, { fact: 'ga4_connected' }] }))).toEqual([])
  })
  it('rejects age operators on a non-date fact, naming the operator', () => {
    const out = issues(withEligible({ fact: 'playbooks_run', minAgeDays: 3 }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^actions\.0\.eligible\.minAgeDays: .*needs a date fact.*playbooks_run.*number/)
    expect(issues(withEligible({ fact: 'business_type', maxAgeDays: 3 }))[0]).toMatch(/^actions\.0\.eligible\.maxAgeDays: /)
  })
  it('rejects an empty sinceEntry and negative or oversized values', () => {
    expect(issues(withEligible({ sinceEntry: {} })).join('\n')).toMatch(/sinceEntry needs minDays or maxDays/)
    expect(issues(withEligible({ sinceEntry: { minDays: -1 } }))).not.toEqual([])
    expect(issues(withEligible({ sinceEntry: { maxDays: 4000 } }))).not.toEqual([])
    expect(issues(withEligible({ fact: 'signed_up_at', minAgeDays: -1 }))).not.toEqual([])
  })
  it('sinceEntry is program-only: the flow predicate schema rejects it; the program one accepts it', () => {
    expect(predicateSchema.safeParse({ sinceEntry: { minDays: 1 } }).success).toBe(false)
    expect(programPredicateSchema.safeParse({ sinceEntry: { minDays: 1 } }).success).toBe(true)
    expect(programPredicateSchema.safeParse({ sinceEntry: { minDays: 1, extra: 1 } }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Engine: evaluation with enteredAt, the wake, the guard, the simulator
// ---------------------------------------------------------------------------

let P: ProgramHarness

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(
    P.H,
    buildProgram({
      slug: 'settle',
      policy: { minGapDays: 3 },
      actions: [{ id: 'settle', title: 'Settle in', priority: 100, attempts: 2, eligible: { sinceEntry: { minDays: 2 } }, satisfied: { fact: 'ga4_connected' } }],
    }),
  )
  await seedProgramWithTemplates(
    P.H,
    buildProgram({
      slug: 'early',
      policy: { minGapDays: 3 },
      actions: [
        { id: 'first-day', title: 'First day', priority: 100, attempts: 1, eligible: { sinceEntry: { maxDays: 1 } }, satisfied: { fact: 'ga4_connected' } },
        { id: 'later', title: 'Later', priority: 50, attempts: 1, satisfied: { fact: 'shopify_connected' } },
      ],
    }),
  )
  await seedProgramWithTemplates(
    P.H,
    buildProgram({
      slug: 'aged',
      policy: { minGapDays: 3 },
      actions: [{ id: 'aged', title: 'Aged', priority: 100, attempts: 2, eligible: { fact: 'signed_up_at', minAgeDays: 3 }, satisfied: { fact: 'ga4_connected' } }],
    }),
  )
  await seedProgramWithTemplates(
    P.H,
    buildProgram({
      slug: 'far',
      policy: { minGapDays: 3 },
      actions: [{ id: 'far', title: 'Far', priority: 100, attempts: 1, eligible: { fact: 'signed_up_at', minAgeDays: 10 }, satisfied: { fact: 'ga4_connected' } }],
    }),
  )
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})
afterEach(() => restoreClock())

describe('evaluateProgramPredicate — sinceEntry', () => {
  const ev = (pred: unknown, enteredAt: Date, now: Date = NOW) =>
    evaluateProgramPredicate(pred as Predicate, { facts, subjectId: 'acct-x', collections: P.H.mailer.collections, now, enteredAt })

  it('minDays / maxDays against enteredAt', async () => {
    const entered = daysAgo(3)
    expect(await ev({ sinceEntry: { minDays: 3 } }, entered)).toBe(true)
    expect(await ev({ sinceEntry: { minDays: 3.5 } }, entered)).toBe(false)
    expect(await ev({ sinceEntry: { maxDays: 3 } }, entered)).toBe(false)
    expect(await ev({ sinceEntry: { maxDays: 4 } }, entered)).toBe(true)
    expect(await ev({ sinceEntry: { minDays: 1, maxDays: 7 } }, entered)).toBe(true)
    expect(await ev({ not: { sinceEntry: { minDays: 5 } } }, entered)).toBe(true)
    expect(await ev({ all: [{ sinceEntry: { minDays: 1 } }, { fact: 'signed_up_at', minAgeDays: 4 }] }, entered)).toBe(true)
  })
  it('the fact leaf uses the context `now`, not the clock', async () => {
    expect(await ev({ fact: 'signed_up_at', minAgeDays: 4 }, daysAgo(3), NOW)).toBe(true)
    expect(await ev({ fact: 'signed_up_at', minAgeDays: 4 }, daysAgo(3), daysAgo(2))).toBe(false)
  })
})

describe('tick', () => {
  it('sinceEntry.minDays: none-eligible until the day arrives, waking exactly then', async () => {
    const t = startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'settle', subjectId)

    expect(await tickProgram(P.H.ctx, 'settle', subjectId)).toMatchObject({ reason: 'none-eligible', chosen: null, sendIds: [] })
    const run = (await getRun(P, 'settle', subjectId))!
    expect(run.nextTickAt).toEqual(new Date(t.getTime() + 2 * DAY))
    const d = (await lastDecision(P, 'settle', subjectId))!
    expect(d.candidates[0]).toMatchObject({ actionId: 'settle', eligible: false, blockedBy: 'ineligible' })

    advance(2 * DAY - HOUR)
    expect(await tickProgram(P.H.ctx, 'settle', subjectId)).toMatchObject({ reason: 'none-eligible' })
    advance(HOUR)
    expect(await tickProgram(P.H.ctx, 'settle', subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'settle', attempt: 1 })
    await dispatch(P)
    expect(delivered(P, owners)).toHaveLength(1)
  })

  it('a date fact age gate wakes at fact + minAgeDays', async () => {
    const t = startClock()
    const { subjectId } = await subject(P, { signed_up_at: new Date(t.getTime() - DAY) })
    await enter(P, 'aged', subjectId)
    expect(await tickProgram(P.H.ctx, 'aged', subjectId)).toMatchObject({ reason: 'none-eligible' })
    expect((await getRun(P, 'aged', subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 2 * DAY))
    advance(2 * DAY)
    expect(await tickProgram(P.H.ctx, 'aged', subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'aged' })
  })

  it('the none-eligible wake never waits longer than minGapDays', async () => {
    const t = startClock()
    const { subjectId } = await subject(P, { signed_up_at: t })
    await enter(P, 'far', subjectId)
    expect(await tickProgram(P.H.ctx, 'far', subjectId)).toMatchObject({ reason: 'none-eligible' })
    expect((await getRun(P, 'far', subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 3 * DAY))
  })

  it('without a time leaf the none-eligible wake is still now + minGapDays', async () => {
    const t = startClock()
    const { subjectId } = await subject(P, { signed_up_at: null })
    await enter(P, 'aged', subjectId)
    expect(await tickProgram(P.H.ctx, 'aged', subjectId)).toMatchObject({ reason: 'none-eligible' })
    expect((await getRun(P, 'aged', subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 3 * DAY))
  })

  it('sinceEntry.maxDays: the dispatch guard cancels a send whose day has passed, and the run moves on', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'early', subjectId)
    expect(await tickProgram(P.H.ctx, 'early', subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'first-day' })

    advance(DAY + HOUR) // the guard re-evaluates `eligible` with the run's enteredAt
    await dispatch(P)
    const sends = await programSends(P, subjectId)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ status: 'cancelled', exitReason: 'ineligible_before_send' })
    expect(delivered(P, owners)).toHaveLength(0)

    // Nothing was accepted, so no gap: the next tick sends the next action.
    expect(await tickProgram(P.H.ctx, 'early', subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'later' })
  })

  it('sinceEntry.maxDays: inside the window the send goes out', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'early', subjectId)
    await tickProgram(P.H.ctx, 'early', subjectId)
    advance(HOUR)
    await dispatch(P)
    expect(delivered(P, owners)).toHaveLength(1)
  })
})

describe('simulate', () => {
  it('a facts-only simulation enters now: it waits for the flip and projects from it', async () => {
    const t = startClock()
    const s = await P.H.mailer.simulateProgram('settle', { facts: { ga4_connected: false } })
    expect(s.next).toMatchObject({ reason: 'none-eligible', actionId: null, attempt: null })
    expect(s.next.at).toEqual(new Date(t.getTime() + 2 * DAY))
    expect(s.candidates[0]).toMatchObject({ actionId: 'settle', eligible: false, blockedBy: 'ineligible' })
    expect(s.sequence.map((x) => [x.actionId, x.attempt, x.at.getTime() - t.getTime()])).toEqual([
      ['settle', 1, 2 * DAY],
      ['settle', 2, 5 * DAY],
    ])
    expect(s.sequenceEnd).toBe('completed')
  })

  it('a subject with a run uses the run\'s enteredAt', async () => {
    const t = startClock()
    const { subjectId } = await subject(P)
    await enter(P, 'settle', subjectId)
    advance(DAY)
    const s = await P.H.mailer.simulateProgram('settle', { subjectId })
    expect(s.next.reason).toBe('none-eligible')
    expect(s.next.at).toEqual(new Date(t.getTime() + 2 * DAY))
    expect(s.sequence[0]!.at).toEqual(new Date(t.getTime() + 2 * DAY))
  })

  it('a fact age gate: the projection starts when the fact is old enough', async () => {
    const t = startClock()
    const s = await P.H.mailer.simulateProgram('aged', { facts: { signed_up_at: new Date(t.getTime() - DAY).toISOString(), ga4_connected: false } })
    expect(s.next.reason).toBe('none-eligible')
    expect(s.sequence[0]!.at).toEqual(new Date(t.getTime() + 2 * DAY))
  })

  it('no flip and nothing to wait for ends the projection as none-eligible', async () => {
    startClock()
    const s = await P.H.mailer.simulateProgram('aged', { facts: { signed_up_at: null, ga4_connected: false } })
    expect(s.next).toMatchObject({ reason: 'none-eligible', at: null })
    expect(s.sequence).toEqual([])
    expect(s.sequenceEnd).toBe('none-eligible')
  })
})
