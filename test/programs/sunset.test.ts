/**
 * Sunset — §5.8. `unansweredAttempts` counts accepted sends since the last
 * engagement (a session, a human click on a program send, or any action newly
 * satisfied). Opens never count.
 *
 *   stage 0   normal
 *   stage 1   unanswered ≥ slowAfter → gap × slowFactor
 *   stage 2   unanswered ≥ askAfter  → send askTemplateSlug once, then the
 *             run goes `sunset`: no more sends until engagement
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { buildProgram, tickProgram } from '../../src/testing/index.js'
import { SUNSET_ASK_ACTION_ID } from '../../src/server/programs/validate.js'
import { advance, DAY, HOUR, MINUTE, restoreClock } from '../matrix/clock.js'
import {
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

let P: ProgramHarness
const slug = 'sunsetting'

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(
    P.H,
    buildProgram({
      slug,
      policy: { minGapDays: 2, sunset: { slowAfter: 2, slowFactor: 3, askAfter: 4, askTemplateSlug: 'still-want-these' } },
      actions: [
        { id: 'connect-shopify', priority: 100, attempts: 8, satisfied: { fact: 'shopify_connected' } },
        { id: 'connect-ga4', priority: 50, attempts: 8, satisfied: { fact: 'ga4_connected' } },
      ],
    }),
  )
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

/** Tick, dispatch, and jump to the run's nextTickAt. */
async function step(subjectId: string) {
  const res = await tickProgram(P.H.ctx, slug, subjectId)
  await dispatch(P)
  const run = (await getRun(P, slug, subjectId))!
  const wait = run.nextTickAt.getTime() - Date.now()
  if (wait > 0) advance(wait)
  return res
}

describe('stages', () => {
  it('stage 1 after slowAfter unanswered sends multiplies the gap', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await step(subjectId) // 1
    await step(subjectId) // 2 → stage 1
    const run = (await getRun(P, slug, subjectId))!
    expect(run).toMatchObject({ unansweredAttempts: 2, sunsetStage: 1 })
    expect(run.nextTickAt.getTime() - run.lastSentAt!.getTime()).toBe(6 * DAY)
  })

  it('stage 2 sends the ask once, then the run goes sunset and stays silent', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    for (let i = 0; i < 4; i++) await step(subjectId)
    const ask = await step(subjectId)
    expect(ask).toMatchObject({ reason: 'sunset', chosen: SUNSET_ASK_ACTION_ID })
    expect(delivered(P, owners).at(-1)!.subject.startsWith('still-want-these')).toBe(true)
    const sends = await programSends(P, subjectId)
    expect(sends.at(-1)!.program).toMatchObject({ actionId: SUNSET_ASK_ACTION_ID })

    const run = (await getRun(P, slug, subjectId))!
    expect(run).toMatchObject({ status: 'sunset', sunsetStage: 2, sunsetAskSent: true })
    // The ask is not an attempt of any action.
    expect(run.actions['connect-shopify']!.attempts).toBe(4)

    const count = delivered(P, owners).length
    for (let i = 0; i < 3; i++) {
      advance(30 * DAY)
      await P.H.drain()
    }
    expect(delivered(P, owners)).toHaveLength(count)
    expect((await lastDecision(P, slug, subjectId))!.reason).toBe('sunset')
  })
})

describe('engagement resets', () => {
  async function toStageOne() {
    startClock()
    const s = await subject(P)
    await enter(P, slug, s.subjectId)
    await step(s.subjectId)
    await step(s.subjectId)
    expect((await getRun(P, slug, s.subjectId))!.sunsetStage).toBe(1)
    return s
  }

  it('a session (newer last_session_at) resets to stage 0', async () => {
    const { subjectId } = await toStageOne()
    P.facts.set(subjectId, { last_session_at: new Date(Date.now() - HOUR) })
    await tickProgram(P.H.ctx, slug, subjectId)
    expect(await getRun(P, slug, subjectId)).toMatchObject({ unansweredAttempts: 0, sunsetStage: 0 })
  })

  it('a human click on a program send resets', async () => {
    const { subjectId } = await toStageOne()
    const last = (await programSends(P, subjectId)).at(-1)!
    await P.H.mailer.collections.sends.updateOne(
      { _id: last._id },
      { $set: { firstClickAt: new Date(), clickCount: 1, clickedLinks: [{ url: 'https://x', linkId: 'l', clickedAt: new Date(), userAgent: 'Mozilla/5.0 (Macintosh)' }] } },
    )
    await tickProgram(P.H.ctx, slug, subjectId)
    expect(await getRun(P, slug, subjectId)).toMatchObject({ unansweredAttempts: 0, sunsetStage: 0 })
  })

  it('a bot click does not reset', async () => {
    const { subjectId } = await toStageOne()
    const last = (await programSends(P, subjectId)).at(-1)!
    await P.H.mailer.collections.sends.updateOne(
      { _id: last._id },
      { $set: { firstClickAt: new Date(), clickCount: 1, clickedLinks: [{ url: 'https://x', linkId: 'l', clickedAt: new Date(), userAgent: 'Mimecast Security Scanner' }] } },
    )
    await tickProgram(P.H.ctx, slug, subjectId)
    expect((await getRun(P, slug, subjectId))!.sunsetStage).toBe(1)
  })

  it('an open never counts as engagement', async () => {
    const { subjectId } = await toStageOne()
    for (const s of await programSends(P, subjectId)) {
      await P.H.mailer.collections.sends.updateOne(
        { _id: s._id },
        { $set: { openedAt: new Date(), openCount: 5, opens: [{ openedAt: new Date(), userAgent: 'Mozilla/5.0' }] } },
      )
    }
    await tickProgram(P.H.ctx, slug, subjectId)
    expect((await getRun(P, slug, subjectId))!).toMatchObject({ sunsetStage: 1, unansweredAttempts: 2 })
  })

  it('a newly satisfied action resets', async () => {
    const { subjectId } = await toStageOne()
    P.facts.set(subjectId, { shopify_connected: true })
    await tickProgram(P.H.ctx, slug, subjectId)
    expect(await getRun(P, slug, subjectId)).toMatchObject({ unansweredAttempts: 0, sunsetStage: 0 })
  })

  it('engagement wakes a sunset run back to active', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    for (let i = 0; i < 5; i++) await step(subjectId)
    expect((await getRun(P, slug, subjectId))!.status).toBe('sunset')
    P.facts.set(subjectId, { last_session_at: new Date() })
    advance(MINUTE)
    await tickProgram(P.H.ctx, slug, subjectId)
    const run = (await getRun(P, slug, subjectId))!
    expect(run).toMatchObject({ status: 'active', sunsetStage: 0, unansweredAttempts: 0 })
    const before = delivered(P, owners).length
    advance(2 * DAY + MINUTE)
    await P.H.drain()
    expect(delivered(P, owners).length).toBe(before + 1)
  })
})
