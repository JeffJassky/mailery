/**
 * A none-eligible tick wakes at min(now + minGapDays, earliest cooldown end,
 * next predicate flip) — the same instant the simulator projects.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { buildProgram, tickProgram } from '../../src/testing/index.js'
import { advance, DAY, HOUR, restoreClock } from '../matrix/clock.js'
import { dispatch, enter, getRun, programHarness, seedProgramWithTemplates, startClock, subject, type ProgramHarness } from './helpers.js'

let P: ProgramHarness
beforeAll(async () => {
  P = await programHarness()
}, 120_000)
afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})
afterEach(() => restoreClock())

describe('none-eligible wake', () => {
  it('blocked only by a 3-day cooldown with minGapDays 5 → nextTickAt is +3d and equals the simulator', async () => {
    startClock()
    const def = buildProgram({
      slug: 'cool-wake',
      policy: { minGapDays: 5 },
      actions: [{ id: 'connect-shopify', priority: 10, attempts: 1, cooldownDays: 3, satisfied: { fact: 'shopify_connected' } }],
    })
    await seedProgramWithTemplates(P.H, def)
    const { subjectId } = await subject(P)
    await enter(P, 'cool-wake', subjectId)
    await tickProgram(P.H.ctx, 'cool-wake', subjectId)
    await dispatch(P)
    advance(5 * DAY + HOUR)

    const res = await tickProgram(P.H.ctx, 'cool-wake', subjectId)
    expect(res).toMatchObject({ chosen: null, reason: 'none-eligible' })
    const run = (await getRun(P, 'cool-wake', subjectId))!
    const until = run.actions['connect-shopify']!.cooldownUntil!
    expect(until.getTime()).toBe(Date.now() + 3 * DAY)
    expect(run.nextTickAt).toEqual(until)

    const s = await P.H.mailer.simulateProgram('cool-wake', { subjectId })
    expect(s.next.reason).toBe('none-eligible')
    expect(s.next.at).toEqual(run.nextTickAt)
  })
})
