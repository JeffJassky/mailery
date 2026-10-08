/**
 * Holdout — §5.9. Deterministic per (slug, subjectId), fixed for the run's
 * life. The holdout arm decides and logs exactly as treatment does and walks
 * the same ladder (a `holdout` send row stands in for the accepted send), but
 * no provider is ever called.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { tickProgram } from '../../src/testing/index.js'
import { holdoutArm } from '../../src/server/runner/programs/index.js'
import { advance, DAY, MINUTE, restoreClock } from '../matrix/clock.js'
import {
  activation,
  decisionsFor,
  delivered,
  dispatch,
  enter,
  getRun,
  programHarness,
  programSends,
  seedProgramWithTemplates,
  startClock,
  subject,
  type ProgramHarness,
} from './helpers.js'

describe('holdoutArm (pure, persisted semantics)', () => {
  it('is deterministic', () => {
    for (const id of ['a', 'b', 'acct-42', '65f0c0ffee']) {
      expect(holdoutArm('activation', id, 30)).toBe(holdoutArm('activation', id, 30))
    }
  })
  it('0 or undefined → treatment; 100 → holdout', () => {
    expect(holdoutArm('activation', 'x', 0)).toBe('treatment')
    expect(holdoutArm('activation', 'x', undefined)).toBe('treatment')
    expect(holdoutArm('activation', 'x', 100)).toBe('holdout')
  })
  it('splits roughly at the percentage', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `acct-${i}`)
    const held = ids.filter((id) => holdoutArm('activation', id, 20) === 'holdout').length
    expect(held).toBeGreaterThan(320)
    expect(held).toBeLessThan(480)
  })
  it('depends on the program slug, so arms are independent across programs', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `acct-${i}`)
    const same = ids.filter((id) => holdoutArm('a', id, 50) === holdoutArm('b', id, 50)).length
    expect(same).toBeLessThan(400)
  })
  it('is pinned: these values must never change (changing them reshuffles live arms)', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `acct-${i}`)
    const arms = ids.map((id) => holdoutArm('activation', id, 50))
    expect(arms).toContain('holdout')
    expect(arms).toContain('treatment')
    expect(arms.map((a) => (a === 'holdout' ? 'H' : 'T')).join('')).toMatchInlineSnapshot(`"TTTTTTTHTTTT"`)
  })
})

let P: ProgramHarness
const slug = 'held'

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(P.H, activation({ slug, holdoutPct: 50 }))
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

/** A subject whose id lands in the wanted arm. */
async function subjectIn(arm: 'holdout' | 'treatment', initial = {}) {
  for (let i = 0; i < 100; i++) {
    const s = await subject(P, initial)
    if (holdoutArm(slug, s.subjectId, 50) === arm) return s
  }
  throw new Error('no subject in arm')
}

describe('holdout runs', () => {
  it('the arm is assigned at entry and fixed even if holdoutPct changes', async () => {
    startClock()
    const s = await subjectIn('holdout')
    await enter(P, slug, s.subjectId)
    expect((await getRun(P, slug, s.subjectId))!.arm).toBe('holdout')
    await P.H.mailer.collections.programs.updateOne({ slug }, { $set: { 'definition.holdoutPct': 0 } })
    try {
      await tickProgram(P.H.ctx, slug, s.subjectId)
      expect((await getRun(P, slug, s.subjectId))!.arm).toBe('holdout')
    } finally {
      await P.H.mailer.collections.programs.updateOne({ slug }, { $set: { 'definition.holdoutPct': 50 } })
    }
  })

  it('writes a holdout send row with no provider call and no queue', async () => {
    startClock()
    const s = await subjectIn('holdout')
    await enter(P, slug, s.subjectId)
    const res = await tickProgram(P.H.ctx, slug, s.subjectId)
    expect(res).toMatchObject({ status: 'ticked', reason: 'holdout', chosen: 'connect-shopify', attempt: 1 })
    const sends = await programSends(P, s.subjectId)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ status: 'holdout', program: { holdout: true, attempt: 1 }, sentAt: null })
    await dispatch(P)
    await P.H.drain()
    expect(delivered(P, s.owners)).toHaveLength(0)
    expect((await programSends(P, s.subjectId))[0]!.status).toBe('holdout')
    const d = (await decisionsFor(P, slug, s.subjectId)).at(-1)!
    expect(d).toMatchObject({ arm: 'holdout', reason: 'holdout', outcome: { status: 'holdout' } })
  })

  it('walks the same ladder as treatment with the same facts timeline', async () => {
    startClock()
    const held = await subjectIn('holdout')
    const treated = await subjectIn('treatment')
    await enter(P, slug, held.subjectId)
    await enter(P, slug, treated.subjectId)

    const timeline = async () => {
      for (let i = 0; i < 5; i++) {
        await tickProgram(P.H.ctx, slug, held.subjectId)
        await tickProgram(P.H.ctx, slug, treated.subjectId)
        await dispatch(P)
        if (i === 3) {
          P.facts.set(held.subjectId, { ga4_connected: true })
          P.facts.set(treated.subjectId, { ga4_connected: true })
        }
        advance(3 * DAY + MINUTE)
      }
    }
    await timeline()

    const seq = async (id: string) =>
      (await decisionsFor(P, slug, id)).map((d) => [d.chosen, d.attempt, d.candidates.map((c) => c.blockedBy)])
    expect(await seq(held.subjectId)).toEqual(await seq(treated.subjectId))
    expect(delivered(P, held.owners)).toHaveLength(0)
    expect(delivered(P, treated.owners).length).toBeGreaterThan(0)
    const heldRun = (await getRun(P, slug, held.subjectId))!
    const treatedRun = (await getRun(P, slug, treated.subjectId))!
    expect(heldRun.actions).toEqual(treatedRun.actions)
  })

  it('holdout rows split cleanly from treatment rows for per-arm stats', async () => {
    startClock()
    const held = await subjectIn('holdout')
    const treated = await subjectIn('treatment')
    for (const s of [held, treated]) {
      await enter(P, slug, s.subjectId)
      await tickProgram(P.H.ctx, slug, s.subjectId)
    }
    await dispatch(P)
    const rows = await P.H.mailer.collections.sends
      .aggregate([
        { $match: { 'program.subjectId': { $in: [held.subjectId, treated.subjectId] } } },
        { $group: { _id: '$program.holdout', n: { $sum: 1 }, statuses: { $addToSet: '$status' } } },
        { $sort: { _id: 1 } },
      ])
      .toArray()
    expect(rows).toEqual([
      { _id: false, n: 1, statuses: ['sent'] },
      { _id: true, n: 1, statuses: ['holdout'] },
    ])
  })

  it('holdout subjects still complete and fire onComplete', async () => {
    startClock()
    const s = await subjectIn('holdout', { shopify_connected: true, ga4_connected: true, agent_connected: true, playbooks_run: 3 })
    await enter(P, slug, s.subjectId)
    expect(await tickProgram(P.H.ctx, slug, s.subjectId)).toMatchObject({ reason: 'completed' })
  })
})
