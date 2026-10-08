/**
 * Attempt accounting — INVARIANT 18: a Program attempt is consumed only by an
 * accepted send. Policy deferral, policy expiry, suppression, provider
 * failure, session suppression and sunset leave the counter unchanged.
 *
 * Holdout is the one simulated acceptance: the holdout arm walks the same
 * ladder as treatment (attempt 1, 2, 3, then the next action) so the two arms'
 * decision logs stay comparable — see holdout.test.ts. No provider call is
 * ever made for it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ObjectId } from 'mongodb'

import { tickProgram } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { IN_FLIGHT_RECHECK_MS } from '../../src/server/runner/programs/index.js'
import { advance, DAY, HOUR, MINUTE, restoreClock } from '../matrix/clock.js'
import {
  activation,
  CATEGORY,
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
const slug = 'activation'

beforeAll(async () => {
  P = await programHarness({ contactPolicy: { marketing: { minGapHours: 20, deferral: { maxHours: 72 } } } })
  await seedProgramWithTemplates(
    P.H,
    activation({ policy: { minGapDays: 3, suppressIfSessionWithinHours: 12 } }),
  )
  await P.H.seedTemplate({ slug: 'other-news', kind: 'marketing', subject: 'News' })
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

const actionState = async (subjectId: string, id = 'connect-shopify') => (await getRun(P, slug, subjectId))!.actions[id]!

describe('accepted sends consume attempts', () => {
  it('queued is not accepted; sent is', async () => {
    const t = startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    expect(await actionState(subjectId)).toMatchObject({ attempts: 0 })
    const run0 = (await getRun(P, slug, subjectId))!
    expect(run0.inFlight).toMatchObject({ actionId: 'connect-shopify', attempt: 1 })

    await dispatch(P)
    expect(delivered(P, owners)).toHaveLength(1)
    const run = (await getRun(P, slug, subjectId))!
    expect(run.actions['connect-shopify']).toMatchObject({ attempts: 1, lastSentAt: t })
    expect(run.lastSentAt).toEqual(t)
    expect(run.unansweredAttempts).toBe(1)
    const [send] = await programSends(P, subjectId)
    expect(send!.program!.counted).toBe(true)
    expect((await lastDecision(P, slug, subjectId))!.outcome).toMatchObject({ status: 'sent' })
  })

  it('attempts escalate through the ladder with distinct templates, then exhaust', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    for (let i = 1; i <= 3; i++) {
      expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ chosen: 'connect-shopify', attempt: i })
      await dispatch(P)
      advance(3 * DAY + MINUTE)
    }
    expect(delivered(P, owners).map((s) => s.subject.split(':')[0])).toEqual(['connect-shopify-1', 'connect-shopify-2', 'connect-shopify-3'])
    expect(delivered(P, owners)[2]!.subject).toContain('3/3')
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ chosen: 'connect-ga4', attempt: 1 })
  })

  it('a re-dispatched (stranded) send does not count twice', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await dispatch(P)
    const [send] = await programSends(P, subjectId)
    // Simulate the stranded-send sweep re-queueing an already-sent row.
    await P.H.mailer.collections.sends.updateOne({ _id: send!._id }, { $set: { status: 'queued' } })
    await dispatchSend(send!._id as ObjectId, P.H.ctx)
    expect(await actionState(subjectId)).toMatchObject({ attempts: 1 })
  })

  it('two recipients, both accepted → one attempt', async () => {
    startClock()
    const { subjectId, owners } = await subject(P, {}, { owners: 2 })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    expect(await programSends(P, subjectId)).toHaveLength(2)
    await dispatch(P)
    expect(delivered(P, owners)).toHaveLength(2)
    expect(await actionState(subjectId)).toMatchObject({ attempts: 1 })
  })
})

describe('non-accepted outcomes leave the attempt unchanged', () => {
  it('contact-policy deferral: attempt unchanged, decision marked policy-silence, run sleeps until notBefore', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    // A marketing one-off an hour ago puts the owner inside the 20h gap.
    await P.H.mailer.sendOneOff({ templateSlug: 'other-news', externalId: owners[0]!.externalId, dedupeKey: `n-${subjectId}` })
    await dispatch(P)
    advance(HOUR)

    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await dispatch(P)
    const [send] = await programSends(P, subjectId)
    expect(send!.status).toBe('deferred')
    expect(await actionState(subjectId)).toMatchObject({ attempts: 0 })
    const d = (await lastDecision(P, slug, subjectId))!
    expect(d.reason).toBe('policy-silence')
    expect(d.outcome).toMatchObject({ status: 'deferred', notBefore: send!.notBefore })
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(send!.notBefore)

    // A tick while the send is still deferred is silent and changes nothing.
    advance(2 * HOUR)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'in-flight', chosen: 'connect-shopify', sendIds: [] })
    expect(await programSends(P, subjectId)).toHaveLength(1)

    // Released and sent → counted once.
    advance(20 * HOUR)
    await P.H.drain()
    expect((await P.H.mailer.collections.sends.findOne({ _id: send!._id }))!.status).toBe('sent')
    expect(await actionState(subjectId)).toMatchObject({ attempts: 1 })
  })

  it('in-flight ticks re-check after IN_FLIGHT_RECHECK_MS', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId) // queued, never dispatched
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    expect(res).toMatchObject({ reason: 'in-flight' })
    expect((await getRun(P, slug, subjectId))!.nextTickAt.getTime()).toBe(Date.now() + IN_FLIGHT_RECHECK_MS)
  })

  it('policy expiry (dropped) leaves the attempt unchanged and the next tick tries again', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const [send] = await programSends(P, subjectId)
    // The send sits undispatched for 70h; then an unrelated marketing send lands.
    advance(70 * HOUR)
    await P.H.mailer.sendOneOff({ templateSlug: 'other-news', externalId: owners[0]!.externalId, dedupeKey: `x-${subjectId}` })
    const other = await P.H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:x-${subjectId}` })
    await dispatchSend(other!._id as ObjectId, P.H.ctx)
    advance(MINUTE)
    await dispatchSend(send!._id as ObjectId, P.H.ctx)
    expect((await P.H.mailer.collections.sends.findOne({ _id: send!._id }))).toMatchObject({ status: 'cancelled', exitReason: 'policy_expired' })
    expect(await actionState(subjectId)).toMatchObject({ attempts: 0 })
    const run = (await getRun(P, slug, subjectId))!
    expect(run.inFlight).toBeNull()

    advance(DAY)
    const again = await tickProgram(P.H.ctx, slug, subjectId)
    expect(again).toMatchObject({ chosen: 'connect-shopify', attempt: 1, reason: 'highest-rank' })
  })

  it('suppressed at dispatch (category opt-out after the tick) → unchanged', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await P.H.mailer.unsubscribe(owners[0]!.email, { scope: `category:${CATEGORY}`, reason: 'user_request', source: 'test' })
    await dispatch(P)
    expect((await programSends(P, subjectId))[0]!.status).toBe('suppressed')
    expect(await actionState(subjectId)).toMatchObject({ attempts: 0 })
    expect((await getRun(P, slug, subjectId))!.inFlight).toBeNull()
  })

  it('every recipient opted out of the category → silent no-recipients tick, no send rows', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await P.H.mailer.unsubscribe(owners[0]!.email, { scope: `category:${CATEGORY}`, reason: 'user_request', source: 'test' })
    await enter(P, slug, subjectId)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'no-recipients', sendIds: [] })
    expect(await programSends(P, subjectId)).toHaveLength(0)
    expect(await actionState(subjectId)).toMatchObject({ attempts: 0 })
  })

  it('an opt-out from a different category does not silence the program', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await P.H.mailer.unsubscribe(owners[0]!.email, { scope: 'category:product.updates', reason: 'user_request', source: 'test' })
    await enter(P, slug, subjectId)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'highest-rank' })
  })

  it('provider failure → unchanged', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const inner = P.H.provider.inner as any
    const original = inner.send.bind(inner)
    inner.send = async () => { throw new Error('provider down') }
    try {
      await dispatch(P)
    } finally {
      inner.send = original
    }
    expect((await programSends(P, subjectId))[0]!.status).toBe('failed')
    expect(await actionState(subjectId)).toMatchObject({ attempts: 0 })
  })

  it('session suppression → no send, unchanged', async () => {
    startClock()
    const { subjectId } = await subject(P, { last_session_at: new Date(Date.now() - 2 * HOUR) })
    await enter(P, slug, subjectId)
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    expect(res).toMatchObject({ reason: 'session-suppressed', chosen: 'connect-shopify', sendIds: [] })
    expect(await programSends(P, subjectId)).toHaveLength(0)
    expect(await actionState(subjectId)).toMatchObject({ attempts: 0 })
    // Re-checks when the session window closes.
    expect((await getRun(P, slug, subjectId))!.nextTickAt.getTime()).toBe(Date.now() - 2 * HOUR + 12 * HOUR)
  })

  it('a session older than the window does not suppress', async () => {
    startClock()
    const { subjectId } = await subject(P, { last_session_at: new Date(Date.now() - 13 * HOUR) })
    await enter(P, slug, subjectId)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'highest-rank' })
  })
})
