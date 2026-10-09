/**
 * Scheduling — next-eligible-at plus Facts Changed wakeups (§5.4 steps 10–13).
 *
 *   nextTickAt after an accepted send   = lastSentAt + minGapDays
 *   per-attempt minGapDays              overrides the program gap for that attempt
 *   delivery window                     pushes the send to the next slot
 *   Facts Changed                       ticks now, but never sends inside the gap
 *   none-eligible                       re-checks after minGapDays
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { buildProgram, tickProgram } from '../../src/testing/index.js'
import { FACTS_CHANGED_EVENT } from '../../src/server/runner/programs/index.js'
import { advance, DAY, HOUR, localStamp, MINUTE, restoreClock, weekdayIn } from '../matrix/clock.js'
import {
  activation,
  delivered,
  dispatch,
  enter,
  getRun,
  lastDecision,
  programHarness,
  seedProgramWithTemplates,
  startClock,
  subject,
  type ProgramHarness,
} from './helpers.js'

let P: ProgramHarness
const slug = 'activation'

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(P.H, activation())
  const longGap = activation({ slug: 'long-gap' })
  longGap.actions[0] = {
    ...longGap.actions[0]!,
    attempts: [
      { deliveries: [{ channel: 'email', templateSlug: 'connect-shopify-1' }] },
      { deliveries: [{ channel: 'email', templateSlug: 'connect-shopify-2' }], minGapDays: 7 },
    ],
  }
  await seedProgramWithTemplates(P.H, longGap)
  await seedProgramWithTemplates(P.H, activation({ slug: 'mornings', policy: { minGapDays: 3, delivery: { timeOfDay: '10:00', timezone: 'UTC' } } }))
  await seedProgramWithTemplates(P.H, activation({ slug: 'weekdays', policy: { minGapDays: 3, delivery: { weekdaysOnly: true, timezone: 'UTC' } } }))
  await seedProgramWithTemplates(
    P.H,
    activation({ slug: 'local-mornings', policy: { minGapDays: 3, delivery: { timeOfDay: '09:00', useContactTimezone: true, timezone: 'UTC' } } }),
  )
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

describe('gap', () => {
  it('after an accepted send, nextTickAt = sentAt + minGapDays and nothing sends before it', async () => {
    const t = startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await dispatch(P)
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 3 * DAY))

    advance(2 * DAY)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'min-gap', chosen: 'connect-shopify', sendIds: [] })
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 3 * DAY))

    advance(DAY)
    await P.H.drain()
    expect(delivered(P, owners)).toHaveLength(2)
  })

  it('a per-attempt minGapDays overrides the program gap', async () => {
    const t = startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'long-gap', subjectId)
    await tickProgram(P.H.ctx, 'long-gap', subjectId)
    await dispatch(P)
    advance(3 * DAY + MINUTE)
    expect(await tickProgram(P.H.ctx, 'long-gap', subjectId)).toMatchObject({ reason: 'min-gap', attempt: 2 })
    expect((await getRun(P, 'long-gap', subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 7 * DAY))
    advance(4 * DAY)
    await P.H.drain()
    expect(delivered(P, owners)).toHaveLength(2)
  })

  it('none-eligible re-checks after minGapDays', async () => {
    startClock()
    // Only install-agent is open; run-playbook waits on it.
    const { subjectId } = await subject(P, { shopify_connected: true, ga4_connected: true, agent_connected: false })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId) // install-agent chosen
    await dispatch(P)
    advance(3 * DAY + MINUTE)
    await tickProgram(P.H.ctx, slug, subjectId) // attempt 2
    await dispatch(P)
    advance(3 * DAY + MINUTE)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'none-eligible' })
    expect((await getRun(P, slug, subjectId))!.nextTickAt.getTime()).toBe(Date.now() + 3 * DAY)
  })
})

describe('delivery window', () => {
  it('outside timeOfDay → delivery-window, nextTickAt = next slot, sent then', async () => {
    const t = startClock() // Monday 15:00 UTC
    const { subjectId, owners } = await subject(P)
    await enter(P, 'mornings', subjectId)
    expect(await tickProgram(P.H.ctx, 'mornings', subjectId)).toMatchObject({ reason: 'delivery-window', chosen: 'connect-shopify', sendIds: [] })
    const next = (await getRun(P, 'mornings', subjectId))!.nextTickAt
    expect(next).toEqual(new Date(t.getTime() + 19 * HOUR)) // Tuesday 10:00 UTC
    advance(19 * HOUR)
    await P.H.drain()
    expect(delivered(P, owners)).toHaveLength(1)
  })

  it('weekdaysOnly: a Saturday tick waits for Monday', async () => {
    const t = startClock()
    advance(5 * DAY) // Saturday 15:00
    expect(weekdayIn(new Date())).toBe('Sat')
    const { subjectId } = await subject(P)
    await enter(P, 'weekdays', subjectId)
    expect(await tickProgram(P.H.ctx, 'weekdays', subjectId)).toMatchObject({ reason: 'delivery-window' })
    const next = (await getRun(P, 'weekdays', subjectId))!.nextTickAt
    expect(weekdayIn(next)).toBe('Mon')
    expect(next.getTime()).toBeGreaterThan(t.getTime() + 5 * DAY)
  })

  it('useContactTimezone reads the subject\'s `timezone` fact', async () => {
    startClock() // Monday 15:00Z
    advance(90 * MINUTE) // 16:30Z = 11:30 or 12:30 New York: well past 09:00 + the 1h grace
    const { subjectId } = await subject(P, { timezone: 'America/New_York' })
    await enter(P, 'local-mornings', subjectId)
    expect(await tickProgram(P.H.ctx, 'local-mornings', subjectId)).toMatchObject({ reason: 'delivery-window' })
    const next = (await getRun(P, 'local-mornings', subjectId))!.nextTickAt
    expect(localStamp(next, 'America/New_York').slice(11)).toBe('09:00')
    expect(weekdayIn(next, 'America/New_York')).toBe('Tue')
  })

  it('the `timezone` fact becomes the send\'s timezoneHint for the contact policy', async () => {
    startClock()
    const { subjectId } = await subject(P, { timezone: 'Asia/Tokyo' })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const send = await P.H.mailer.collections.sends.findOne({ 'program.subjectId': subjectId })
    expect(send!.timezoneHint).toBe('Asia/Tokyo')
  })
})

describe('Facts Changed', () => {
  it('ticks now inside the gap: marks progress, chooses, but does not send', async () => {
    const t = startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await dispatch(P)
    advance(DAY)
    P.facts.set(subjectId, { shopify_connected: true })
    await P.H.mailer.fire(FACTS_CHANGED_EVENT, subjectId)
    await P.H.drain()
    const d = (await lastDecision(P, slug, subjectId))!
    expect(d).toMatchObject({ trigger: 'facts_changed', reason: 'min-gap', chosen: 'connect-ga4' })
    expect(delivered(P, owners)).toHaveLength(1)
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 3 * DAY))

    advance(2 * DAY)
    await P.H.drain()
    expect(delivered(P, owners).map((s) => s.subject.split(':')[0])).toEqual(['connect-shopify-1', 'connect-ga4-1'])
  })

  it('outside the gap it sends right away', async () => {
    startClock()
    // Only run-playbook is open (Shopify is ineligible for saas).
    const { subjectId, owners } = await subject(P, { business_type: 'saas', ga4_connected: true, agent_connected: true })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId) // run-playbook attempt 1
    await dispatch(P)
    advance(4 * DAY)
    await tickProgram(P.H.ctx, slug, subjectId) // exhausted → none-eligible, sleeps 3 days
    advance(HOUR)
    P.facts.set(subjectId, { business_type: 'ecommerce' }) // connect-shopify becomes eligible
    await P.H.mailer.fire(FACTS_CHANGED_EVENT, subjectId)
    await P.H.drain()
    expect(delivered(P, owners).at(-1)!.subject.startsWith('connect-shopify-1')).toBe(true)
  })

  it('Facts Changed for a subject with no run is harmless', async () => {
    startClock()
    await P.H.mailer.fire(FACTS_CHANGED_EVENT, 'no-such-account')
    const res = await P.H.drain()
    expect(res.settled).toBe(true)
  })
})
