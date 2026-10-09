/**
 * simulateProgram — plans/16-program-board.md §3. The dry-run must agree with
 * the real tick, must never write, and must project the send sequence the
 * engine would produce for a subject who never engages.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { tickProgram } from '../../src/testing/index.js'
import { ProgramSimulationError } from '../../src/server/runner/programs/simulate.js'
import { holdoutArm } from '../../src/server/runner/programs/index.js'
import type { ProgramDecisionDoc } from '../../src/server/models/index.js'
import type { ProgramSimulation } from '../../src/shared/program-board.js'
import type { ProgramDefinition } from '../../src/shared/types.js'
import { buildProgram } from '../../src/testing/index.js'
import { advance, DAY, HOUR, restoreClock } from '../matrix/clock.js'
import {
  activation,
  dispatch,
  enter,
  getRun,
  lastDecision,
  programHarness,
  seedProgramWithTemplates,
  startClock,
  subject,
  type ProgramHarness,
} from './../programs/helpers.js'

let P: ProgramHarness
const SUNSET = { slowAfter: 3, slowFactor: 2, askAfter: 6, askTemplateSlug: 'still-want-these' }

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(P.H, activation())
  await seedProgramWithTemplates(P.H, activation({ slug: 'act-sunset', policy: { minGapDays: 3, sunset: SUNSET } }))
  await seedProgramWithTemplates(
    P.H,
    activation({ slug: 'act-window', policy: { minGapDays: 3, delivery: { weekdaysOnly: true, timeOfDay: '10:00', timezone: 'UTC' } } }),
  )
  await seedProgramWithTemplates(P.H, activation({ slug: 'act-session', policy: { minGapDays: 3, suppressIfSessionWithinHours: 12 } }))
  await seedProgramWithTemplates(P.H, activation({ slug: 'act-holdout', holdoutPct: 100 }))
  await seedProgramWithTemplates(
    P.H,
    buildProgram({
      slug: 'cool',
      actions: [{ id: 'only', title: 'Only', priority: 10, attempts: 2, cooldownDays: 10, satisfied: { fact: 'ga4_connected' } }],
    }),
  )
  await seedProgramWithTemplates(P.H, activation({ slug: 'act-disabled' }), { enabled: false })
  P.H.mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
  P.H.mailer.registerEvent({ name: 'Upgraded', dedupePolicy: 'once-per-contact' })
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})
afterEach(() => restoreClock())

const sim = (slug: string, input: Parameters<ProgramHarness['H']['mailer']['simulateProgram']>[1] = {}) =>
  P.H.mailer.simulateProgram(slug, input)
const steps = (s: ProgramSimulation) => s.sequence.map((x) => `${x.actionId}#${x.attempt}`)
const days = (s: ProgramSimulation, t0: Date) => s.sequence.map((x) => Math.round((x.at.getTime() - t0.getTime()) / HOUR) / 24)

/** Map a tick decision to the simulation's next.reason vocabulary. */
function nextReasonOf(d: ProgramDecisionDoc): string {
  if (d.reason === 'highest-rank') return 'send'
  if (d.reason === 'sunset' && d.sendIds.length > 0) return 'send'
  return d.reason
}

async function snapshot() {
  const C = P.H.mailer.collections
  const counts = await Promise.all(
    [C.programRuns, C.programDecisions, C.sends, C.events, C.programs, C.auditLog].map((c: any) => c.countDocuments({})),
  )
  const runs = await C.programRuns.find({}).sort({ _id: 1 }).toArray()
  const programs = await C.programs.find({}).sort({ _id: 1 }).toArray()
  return JSON.stringify({ counts, runs, programs })
}

describe('read-only', () => {
  it('writes nothing in subject mode, fresh mode, and for every reason', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, 'activation', subjectId)
    await tickProgram(P.H.ctx, 'activation', subjectId)
    await dispatch(P)
    const before = await snapshot()
    await sim('activation', { subjectId })
    await sim('activation', { facts: { business_type: 'saas' } })
    await sim('act-sunset', { subjectId: 'never-entered' })
    await sim('activation', { subjectId, now: new Date(Date.now() + 30 * DAY) })
    expect(await snapshot()).toBe(before)
  })

  it('works on a disabled program', async () => {
    startClock()
    const s = await sim('act-disabled', { facts: {} })
    expect(s.next.reason).toBe('send')
  })
})

describe('agrees with the real tick', () => {
  async function agree(slug: string, subjectId: string) {
    const s = await sim(slug, { subjectId })
    await tickProgram(P.H.ctx, slug, subjectId)
    const d = (await lastDecision(P, slug, subjectId))!
    expect(s.next.reason).toBe(nextReasonOf(d))
    expect(s.next.actionId).toBe(d.chosen)
    expect(s.next.attempt).toBe(d.attempt)
    expect(s.candidates.map((c) => [c.actionId, c.blockedBy, c.rank ?? null])).toEqual(
      d.candidates.map((c) => [c.actionId, c.blockedBy, c.rank ?? null]),
    )
    return { s, d }
  }

  it('first send, then min-gap, then the next attempt', async () => {
    const t0 = startClock()
    const { subjectId } = await subject(P)
    await enter(P, 'activation', subjectId)
    const first = await agree('activation', subjectId)
    expect(first.s.next).toMatchObject({ reason: 'send', actionId: 'connect-shopify', attempt: 1, templateSlug: 'connect-shopify-1' })
    expect(first.s.next.at!.getTime()).toBe(t0.getTime())
    await dispatch(P)

    advance(HOUR * 2)
    const gap = await agree('activation', subjectId)
    expect(gap.s.next).toMatchObject({ reason: 'min-gap', actionId: 'connect-shopify', attempt: 2, templateSlug: 'connect-shopify-2' })
    const sent = (await getRun(P, 'activation', subjectId))!.lastSentAt!
    expect(gap.s.next.at!.getTime()).toBe(sent.getTime() + 3 * DAY)
    expect(gap.s.candidates.find((c) => c.actionId === 'connect-shopify')).toMatchObject({ attempts: 1, ladder: 1, status: 'pending' })
    expect(gap.s.run).toMatchObject({ status: 'active', arm: 'treatment', unansweredAttempts: 1 })

    advance(3 * DAY)
    const again = await agree('activation', subjectId)
    expect(again.s.next).toMatchObject({ reason: 'send', actionId: 'connect-shopify', attempt: 2 })
  })

  it('satisfied facts move to the next action', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true })
    await enter(P, 'activation', subjectId)
    const { s } = await agree('activation', subjectId)
    expect(s.next).toMatchObject({ reason: 'send', actionId: 'connect-ga4', attempt: 1 })
    expect(s.candidates.find((c) => c.actionId === 'connect-shopify')).toMatchObject({ satisfied: true, status: 'satisfied', blockedBy: 'satisfied' })
  })

  it('delivery window', async () => {
    const t0 = startClock() // Monday 15:00 UTC
    const { subjectId } = await subject(P)
    await enter(P, 'act-window', subjectId)
    const { s } = await agree('act-window', subjectId)
    expect(s.next.reason).toBe('delivery-window')
    expect(s.next.at!.toISOString()).toBe(new Date(t0.getTime() + 19 * HOUR).toISOString()) // Tue 10:00
  })

  it('session rule', async () => {
    const t0 = startClock()
    const { subjectId } = await subject(P, { last_session_at: new Date(t0.getTime() - HOUR) })
    await enter(P, 'act-session', subjectId)
    const { s } = await agree('act-session', subjectId)
    expect(s.next.reason).toBe('session-suppressed')
    expect(s.next.at!.getTime()).toBe(t0.getTime() + 11 * HOUR)
  })

  it('no recipients (subject mode only)', async () => {
    startClock()
    const { subjectId } = await subject(P)
    P.facts.setRecipients(subjectId, [])
    await enter(P, 'activation', subjectId)
    const { s } = await agree('activation', subjectId)
    expect(s.next.reason).toBe('no-recipients')
  })

  it('holdout arm', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, 'act-holdout', subjectId)
    const { s } = await agree('act-holdout', subjectId)
    expect(s.arm).toBe('holdout')
    expect(s.next.reason).toBe('holdout')
  })

  it('completed', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true, ga4_connected: true, agent_connected: true, playbooks_run: 2 })
    await enter(P, 'activation', subjectId)
    const s = await sim('activation', { subjectId })
    expect(s.next.reason).toBe('completed')
    expect(s.sequence).toEqual([])
    expect(s.sequenceEnd).toBe('completed')
  })

  it('exit event after entry', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, 'activation', subjectId)
    advance(HOUR)
    await P.H.mailer.fire('Upgraded', subjectId, {})
    const s = await sim('activation', { subjectId })
    expect(s.next.reason).toBe('exited')
    expect(s.sequence).toEqual([])
    expect(s.sequenceEnd).toBe('exited')
    expect((await getRun(P, 'activation', subjectId))!.status).toBe('active')
  })

  it('a finished run projects nothing, even when facts would make it eligible again', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true, ga4_connected: true, agent_connected: true, playbooks_run: 2 })
    await enter(P, 'activation', subjectId)
    await tickProgram(P.H.ctx, 'activation', subjectId)
    expect((await getRun(P, 'activation', subjectId))!.status).toBe('completed')
    const s = await sim('activation', { subjectId, facts: { shopify_connected: false } })
    expect(s.next.reason).toBe('completed')
    expect(s.sequence).toEqual([])
    expect(s.sequenceEnd).toBe('completed')
  })

  it('a missing template: none-eligible with a detail, and the sequence stops there', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true })
    await enter(P, 'activation', subjectId)
    const tpl = await P.H.mailer.collections.templates.findOne({ slug: 'connect-ga4-1' })
    await P.H.mailer.collections.templates.deleteOne({ slug: 'connect-ga4-1' })
    try {
      const { s } = await agree('activation', subjectId)
      expect(s.next.reason).toBe('none-eligible')
      expect(s.next.detail).toContain('connect-ga4-1')
      expect(s.sequence).toEqual([])
      expect(s.sequenceEnd).toBe('none-eligible')
    } finally {
      await P.H.mailer.collections.templates.insertOne(tpl!)
    }
  })
})

describe('fresh subject (facts only)', () => {
  it('uses a fresh run and the given facts; no run, treatment arm', async () => {
    const t0 = startClock()
    const s = await sim('activation', { facts: { business_type: 'saas' } })
    expect(s.subjectId).toBeNull()
    expect(s.run).toBeNull()
    expect(s.arm).toBe('treatment')
    expect(s.facts).toEqual({ business_type: 'saas' })
    expect(s.next).toMatchObject({ reason: 'send', actionId: 'connect-ga4', attempt: 1 })
    expect(s.next.at!.getTime()).toBe(t0.getTime())
    expect(s.candidates.find((c) => c.actionId === 'connect-shopify')).toMatchObject({ eligible: false, blockedBy: 'ineligible' })
  })

  it('a subject with no run is simulated fresh with its real facts and its holdout arm', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true })
    const s = await sim('act-sunset', { subjectId })
    expect(s.run).toBeNull()
    expect(s.subjectId).toBe(subjectId)
    expect(s.facts.shopify_connected).toBe(true)
    expect(s.arm).toBe(holdoutArm('act-sunset', subjectId, undefined))
    expect(s.next.actionId).toBe('connect-ga4')
  })

  it('override facts win over resolved facts', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const s = await sim('activation', { subjectId, facts: { shopify_connected: true } })
    expect(s.next.actionId).toBe('connect-ga4')
  })
})

describe('sequence projection', () => {
  it('walks every ladder at the gap, then stops when only blocked actions remain', async () => {
    const t0 = startClock()
    const s = await sim('activation', { facts: { business_type: 'ecommerce' } })
    expect(steps(s)).toEqual([
      'connect-shopify#1', 'connect-shopify#2', 'connect-shopify#3',
      'connect-ga4#1', 'connect-ga4#2',
      'install-agent#1', 'install-agent#2',
    ])
    expect(days(s, t0)).toEqual([0, 3, 6, 9, 12, 15, 18])
    expect(s.sequence[0]!.templateSlug).toBe('connect-shopify-1')
    expect(s.sequenceEnd).toBe('none-eligible')
  })

  it('sunset: slows after slowAfter, sends the ask after askAfter, then ends', async () => {
    const t0 = startClock()
    const s = await sim('act-sunset', { facts: { business_type: 'ecommerce' } })
    expect(steps(s)).toEqual([
      'connect-shopify#1', 'connect-shopify#2', 'connect-shopify#3',
      'connect-ga4#1', 'connect-ga4#2', 'install-agent#1',
      '$sunset-ask#1',
    ])
    expect(days(s, t0)).toEqual([0, 3, 6, 12, 18, 24, 30])
    expect(s.sequence.map((x) => x.sunsetStage)).toEqual([0, 0, 0, 1, 1, 1, 2])
    expect(s.sequence.at(-1)!.templateSlug).toBe('still-want-these')
    expect(s.sequenceEnd).toBe('sunset')
  })

  it('delivery window applies to every step', async () => {
    startClock() // Monday 15:00 UTC
    const s = await sim('act-window', { facts: { business_type: 'ecommerce' } })
    expect(s.sequence.slice(0, 3).map((x) => x.at.toISOString().slice(11, 16))).toEqual(['10:00', '10:00', '10:00'])
    expect(s.sequence.slice(0, 3).map((x) => x.at.getUTCDay())).toEqual([2, 5, 1]) // Tue, Fri, Mon
  })

  it('cooldown re-opens a fresh ladder; the horizon stops the projection', async () => {
    const t0 = startClock()
    const s = await sim('cool', { facts: {}, horizonDays: 30 })
    expect(steps(s)).toEqual(['only#1', 'only#2', 'only#1', 'only#2', 'only#1', 'only#2'])
    expect(days(s, t0)).toEqual([0, 3, 13, 16, 26, 29])
    expect(s.sequenceEnd).toBe('horizon')
  })

  it('starts from the real run state', async () => {
    const t0 = startClock()
    const { subjectId } = await subject(P)
    await enter(P, 'activation', subjectId)
    await tickProgram(P.H.ctx, 'activation', subjectId)
    await dispatch(P)
    const s = await sim('activation', { subjectId })
    expect(steps(s).slice(0, 3)).toEqual(['connect-shopify#2', 'connect-shopify#3', 'connect-ga4#1'])
    expect(days(s, t0).slice(0, 3)).toEqual([3, 6, 9])
  })

  it('stops at max steps', async () => {
    startClock()
    const s = await sim('cool', { facts: {}, horizonDays: 365 })
    expect(s.sequence).toHaveLength(50)
    expect(s.sequenceEnd).toBe('max-steps')
  })
})

describe('source and errors', () => {
  it('simulates the draft when asked (version null), the published version by default without a draft', async () => {
    startClock()
    const pub = await sim('activation', { facts: { business_type: 'ecommerce' } })
    expect(pub).toMatchObject({ source: 'published', version: 1 })
    expect(pub.next.actionId).toBe('connect-shopify')

    const draft: ProgramDefinition = activation()
    draft.actions.find((a) => a.id === 'connect-ga4')!.priority = 200
    await P.H.mailer.collections.programs.updateOne(
      { slug: 'activation' },
      { $set: { draft: { definition: draft, notes: '', lastModifiedBy: 'test', lastModifiedAt: new Date() } as any } },
    )
    try {
      const byDefault = await sim('activation', { facts: { business_type: 'ecommerce' } })
      expect(byDefault).toMatchObject({ source: 'draft', version: null })
      expect(byDefault.next.actionId).toBe('connect-ga4')
      const explicit = await sim('activation', { source: 'published', facts: { business_type: 'ecommerce' } })
      expect(explicit.next.actionId).toBe('connect-shopify')
    } finally {
      await P.H.mailer.collections.programs.updateOne({ slug: 'activation' }, { $set: { draft: null } })
    }
  })

  it.each([
    ['nope', {}, 'not_found'],
    ['activation', { source: 'draft' }, 'no_definition'],
    ['activation', { horizonDays: 366 }, 'invalid_input'],
    ['activation', { horizonDays: 0 }, 'invalid_input'],
    ['activation', { now: 'not a date' }, 'invalid_input'],
  ] as const)('%s %j → %s', async (slug, input, code) => {
    startClock()
    await expect(sim(slug, input as any)).rejects.toSatisfy((e: unknown) => e instanceof ProgramSimulationError && e.code === code)
  })
})
