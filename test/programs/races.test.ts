/**
 * Races and crash windows in the tick (PR 4 review): ordering of tick state vs
 * dispatch hooks, Facts Changed during a lease, partial guard state, completion
 * from this tick's evaluation, holdout crash replay, the disable kill switch.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'

import { buildProgram, tickProgram } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { FACTS_CHANGED_EVENT, runProgramScheduler, IN_FLIGHT_RECHECK_MS } from '../../src/server/runner/programs/index.js'
import { advance, DAY, HOUR, MINUTE, restoreClock } from '../matrix/clock.js'
import {
  activation,
  enter,
  getRun,
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
  P = await programHarness()
  await seedProgramWithTemplates(P.H, activation())
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

describe('tick state vs an immediately-running dispatch hook', () => {
  it('a send dispatched inside the tick keeps its attempt count and nextTickAt; the next tick is attempt 2', async () => {
    const t = startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    const q = P.H.ctx.queues.send as any
    const original = q.add
    q.add = async (_n: string, data: { sendId: string }) => {
      await dispatchSend(new ObjectId(data.sendId), P.H.ctx)
    }
    try {
      await tickProgram(P.H.ctx, slug, subjectId)
    } finally {
      q.add = original
    }
    const run = (await getRun(P, slug, subjectId))!
    expect(run.actions['connect-shopify']).toMatchObject({ attempts: 1, ladder: 1 })
    expect(run.unansweredAttempts).toBe(1)
    expect(run.inFlight).toBeNull()
    expect(run.nextTickAt).toEqual(new Date(t.getTime() + 3 * DAY))

    advance(3 * DAY + MINUTE)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ chosen: 'connect-shopify', attempt: 2 })
  })
})

describe('Facts Changed while the run is leased', () => {
  it('is not lost: the finishing tick schedules another soon', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await P.H.ctx.collections.sends.updateMany({ 'program.subjectId': subjectId }, { $set: { status: 'sent' } })
    await P.H.ctx.collections.programRuns.updateOne({ programSlug: slug, subjectId }, { $set: { inFlight: null } })
    advance(DAY)

    const original = P.facts.resolve.bind(P.facts)
    let fired = false
    P.facts.resolve = async (id) => {
      const facts = await original(id)
      if (!fired) {
        fired = true
        await P.H.mailer.fire(FACTS_CHANGED_EVENT, subjectId)
        await runProgramScheduler(P.H.ctx) // wake scan runs while this tick holds the lease
      }
      return facts
    }
    try {
      await tickProgram(P.H.ctx, slug, subjectId)
    } finally {
      P.facts.resolve = original
    }
    const run = (await getRun(P, slug, subjectId))!
    expect(run.nextTickAt.getTime()).toBe(Date.now() + MINUTE)
  })
})

describe('guard-created action state', () => {
  it('a run that never saw the action gets a complete state when the guard marks it satisfied', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await P.H.mailer.collections.programRuns.updateOne({ programSlug: slug, subjectId }, { $unset: { 'actions.connect-shopify': '' } })
    P.facts.set(subjectId, { shopify_connected: true })
    await P.H.ctx.collections.sends.updateMany({ 'program.subjectId': subjectId }, { $set: { status: 'queued' } })
    const [send] = await programSends(P, subjectId)
    await dispatchSend(send!._id as ObjectId, P.H.ctx)
    expect((await getRun(P, slug, subjectId))!.actions['connect-shopify']).toMatchObject({
      status: 'satisfied',
      attempts: 0,
      ladder: 1,
      version: 1,
      lastSentAt: null,
      exhaustedAt: null,
      cooldownUntil: null,
      completedAt: expect.any(Date),
    })
  })
})

describe('completion uses this tick', () => {
  it('a stored exhausted status on an action that is now ineligible does not complete the run', async () => {
    startClock()
    await seedProgramWithTemplates(
      P.H,
      buildProgram({
        slug: 'stale-ex',
        actions: [{ id: 'connect-shopify', priority: 1, eligible: { fact: 'business_type', equals: 'ecommerce' }, satisfied: { fact: 'shopify_connected' } }],
      }),
    )
    const { subjectId } = await subject(P, { business_type: 'saas' })
    await enter(P, 'stale-ex', subjectId)
    await P.H.mailer.collections.programRuns.updateOne(
      { programSlug: 'stale-ex', subjectId },
      { $set: { 'actions.connect-shopify': { status: 'exhausted', attempts: 1, ladder: 1, lastSentAt: null, completedAt: null, exhaustedAt: new Date(), cooldownUntil: null, version: 1 } } },
    )
    expect(await tickProgram(P.H.ctx, 'stale-ex', subjectId)).toMatchObject({ reason: 'none-eligible' })
    expect((await getRun(P, 'stale-ex', subjectId))!.status).toBe('active')
  })
})

describe('holdout crash window', () => {
  it('a crash while writing holdout rows counts the attempt once and never replays it', async () => {
    startClock()
    await seedProgramWithTemplates(P.H, activation({ slug: 'h100', holdoutPct: 100 }))
    const { subjectId } = await subject(P)
    await enter(P, 'h100', subjectId)
    const coll = P.H.mailer.collections.sends as any
    const original = coll.insertMany.bind(coll)
    coll.insertMany = () => Promise.reject(new Error('crash'))
    try {
      await expect(tickProgram(P.H.ctx, 'h100', subjectId)).rejects.toThrow('crash')
    } finally {
      coll.insertMany = original
    }
    expect((await getRun(P, 'h100', subjectId))!.actions['connect-shopify']).toMatchObject({ attempts: 1 })
    expect(await programSends(P, subjectId)).toHaveLength(0)
    advance(3 * DAY + MINUTE)
    expect(await tickProgram(P.H.ctx, 'h100', subjectId)).toMatchObject({ attempt: 2 })
    expect(await programSends(P, subjectId)).toHaveLength(1)
  })
})

describe('setProgramEnabled(false)', () => {
  it('cancels the program\'s unsent mail (run_inactive)', async () => {
    startClock()
    await seedProgramWithTemplates(P.H, activation({ slug: 'killme' }))
    const { subjectId } = await subject(P)
    await enter(P, 'killme', subjectId)
    await tickProgram(P.H.ctx, 'killme', subjectId)
    await P.H.mailer.setProgramEnabled('killme', false, { actor: 'test' })
    expect((await programSends(P, subjectId))[0]).toMatchObject({ status: 'cancelled', exitReason: 'run_inactive' })
  })
})

describe('audit and queue recovery', () => {
  it('saveProgramDraft writes a program.save_draft audit row', async () => {
    await P.H.mailer.saveProgramDraft(activation({ slug: 'drafty' }), { actor: 'tester' })
    expect(await P.H.mailer.collections.auditLog.countDocuments({ action: 'program.save_draft', actor: 'tester' })).toBe(1)
  })

  it('a queued send whose job was lost is re-enqueued by an in-flight tick after the recheck interval', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const [send] = await programSends(P, subjectId)
    const q = P.H.ctx.queues.send as any
    const original = q.add
    const added: string[] = []
    q.add = async (_n: string, data: { sendId: string }) => { added.push(data.sendId) }
    try {
      advance(HOUR - MINUTE)
      await tickProgram(P.H.ctx, slug, subjectId)
      expect(added).toEqual([])
      advance(2 * MINUTE)
      expect(IN_FLIGHT_RECHECK_MS).toBe(HOUR)
      expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'in-flight' })
    } finally {
      q.add = original
    }
    expect(added).toEqual([String(send!._id)])
  })
})
