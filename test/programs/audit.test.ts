/**
 * Programs cases added by the PR 1 untested-surface audit. Each block names
 * the gap it closes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ObjectId } from 'mongodb'

import { buildProgram, tickProgram } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { enterProgram, runProgramScheduler, tickProgramRun } from '../../src/server/runner/programs/index.js'
import { SUNSET_ASK_ACTION_ID } from '../../src/server/programs/validate.js'
import { advance, DAY, HOUR, MINUTE, restoreClock } from '../matrix/clock.js'
import {
  activation,
  CATEGORY,
  decisionsFor,
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
  P = await programHarness({ programs: { leaseMs: 45_000 }, contactPolicy: { marketing: { minGapHours: 20 } } })
  await seedProgramWithTemplates(P.H, activation({ policy: { minGapDays: 3, suppressIfSessionWithinHours: 12 } }))
  await P.H.seedTemplate({ slug: 'news', kind: 'marketing', subject: 'News' })
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

describe('send rows and crash safety (§5.4 step 14)', () => {
  it('dedupeKey is program:<slug>:<subjectId>:<decisionId>:<externalId>', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    const [s] = await programSends(P, subjectId)
    expect(s!.dedupeKey).toBe(`program:${slug}:${subjectId}:${String(res.status === 'ticked' && res.decisionId)}:${owners[0]!.externalId}`)
  })

  it('a crash after the send rows are written does not produce a second send on the next tick', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    const coll = P.H.mailer.collections.programDecisions as any
    const original = coll.insertOne.bind(coll)
    coll.insertOne = () => Promise.reject(new Error('crash before decision write'))
    try {
      await expect(tickProgram(P.H.ctx, slug, subjectId)).rejects.toThrow()
    } finally {
      coll.insertOne = original
    }
    advance(MINUTE)
    await tickProgram(P.H.ctx, slug, subjectId).catch(() => {})
    await dispatch(P)
    expect((await programSends(P, subjectId)).filter((s) => s.status !== 'cancelled')).toHaveLength(1)
  })
})

describe('multi-recipient accounting (INV 18)', () => {
  it('one accepted + one suppressed → one attempt; inFlight clears once both are terminal', async () => {
    startClock()
    const { subjectId, owners } = await subject(P, {}, { owners: 2 })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await P.H.mailer.unsubscribe(owners[1]!.email, { scope: 'marketing', reason: 'user_request', source: 't' })
    await dispatch(P)
    const run = (await getRun(P, slug, subjectId))!
    expect(run.actions['connect-shopify']!.attempts).toBe(1)
    expect(run.inFlight).toBeNull()
  })

  it('both suppressed → no attempt', async () => {
    startClock()
    const { subjectId, owners } = await subject(P, {}, { owners: 2 })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    for (const o of owners) await P.H.mailer.unsubscribe(o.email, { scope: 'marketing', reason: 'user_request', source: 't' })
    await dispatch(P)
    expect((await getRun(P, slug, subjectId))!.actions['connect-shopify']!.attempts).toBe(0)
  })

  it('one sent + one still deferred → counted once, inFlight stays until the deferred one resolves', async () => {
    startClock()
    const { subjectId, owners } = await subject(P, {}, { owners: 2 })
    // owner 1 got marketing mail an hour ago → their program send defers.
    await P.H.mailer.sendOneOff({ templateSlug: 'news', externalId: owners[1]!.externalId, dedupeKey: `n-${subjectId}` })
    await dispatch(P)
    advance(HOUR)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await dispatch(P)
    let run = (await getRun(P, slug, subjectId))!
    expect(run.actions['connect-shopify']!.attempts).toBe(1)
    expect(run.inFlight).not.toBeNull()
    advance(20 * HOUR)
    await P.H.drain()
    run = (await getRun(P, slug, subjectId))!
    expect(run.actions['connect-shopify']!.attempts).toBe(1)
    expect(run.inFlight).toBeNull()
    expect(delivered(P, owners)).toHaveLength(2)
  })
})

describe('decision outcomes', () => {
  it('records cancelled (satisfied_before_send), suppressed and failed', async () => {
    startClock()
    const a = await subject(P)
    await enter(P, slug, a.subjectId)
    await tickProgram(P.H.ctx, slug, a.subjectId)
    P.facts.set(a.subjectId, { shopify_connected: true })
    await dispatch(P)
    expect((await lastDecision(P, slug, a.subjectId))!.outcome).toMatchObject({ status: 'cancelled', exitReason: 'satisfied_before_send', at: expect.any(Date) })

    const b = await subject(P)
    await enter(P, slug, b.subjectId)
    await tickProgram(P.H.ctx, slug, b.subjectId)
    await P.H.mailer.unsubscribe(b.owners[0]!.email, { scope: `category:${CATEGORY}`, reason: 'user_request', source: 't' })
    await dispatch(P)
    expect((await lastDecision(P, slug, b.subjectId))!.outcome).toMatchObject({ status: 'suppressed' })

    const c = await subject(P)
    await enter(P, slug, c.subjectId)
    await tickProgram(P.H.ctx, slug, c.subjectId)
    const inner = P.H.provider.inner as any
    const orig = inner.send.bind(inner)
    inner.send = async () => { throw new Error('x') }
    try { await dispatch(P) } finally { inner.send = orig }
    expect((await lastDecision(P, slug, c.subjectId))!.outcome).toMatchObject({ status: 'failed' })
  })
})

describe('provider retry (INV 18)', () => {
  it('a failure followed by a successful retry counts once; a tick in between is in-flight', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const [s] = await programSends(P, subjectId)
    const inner = P.H.provider.inner as any
    const orig = inner.send.bind(inner)
    inner.send = async () => { throw new Error('transient') }
    try { await dispatchSend(s!._id as ObjectId, P.H.ctx).catch(() => {}) } finally { inner.send = orig }
    advance(2 * MINUTE)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'in-flight' })
    await dispatchSend(s!._id as ObjectId, P.H.ctx) // queue retry
    const run = (await getRun(P, slug, subjectId))!
    expect(run.actions['connect-shopify']!.attempts).toBe(1)
    expect(await programSends(P, subjectId)).toHaveLength(1)
  })

  it('a failed send older than IN_FLIGHT_RECHECK_MS is treated as terminal (attempt not consumed)', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const inner = P.H.provider.inner as any
    const orig = inner.send.bind(inner)
    inner.send = async () => { throw new Error('down for good') }
    try { await dispatch(P) } finally { inner.send = orig }
    advance(2 * HOUR)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'highest-rank', attempt: 1 })
  })
})

describe('stale engagement does not reset (§5.8)', () => {
  it('a last_session_at from before entry never resets; one session resets once', async () => {
    startClock()
    const def = buildProgram({
      slug: 'sun2',
      policy: { minGapDays: 1, sunset: { slowAfter: 2, slowFactor: 2, askAfter: 10, askTemplateSlug: 'still-want-these' } },
      actions: [{ id: 'connect-shopify', priority: 1, attempts: 9, satisfied: { fact: 'shopify_connected' } }],
    })
    await seedProgramWithTemplates(P.H, def)
    const { subjectId } = await subject(P, { last_session_at: new Date(Date.now() - 30 * DAY) })
    await enter(P, 'sun2', subjectId)
    for (let i = 0; i < 2; i++) {
      await tickProgram(P.H.ctx, 'sun2', subjectId)
      await dispatch(P)
      advance(DAY + 21 * HOUR)
    }
    expect((await getRun(P, 'sun2', subjectId))!.unansweredAttempts).toBe(2)
    P.facts.set(subjectId, { last_session_at: new Date() })
    advance(13 * HOUR) // outside the session window, so the tick may send
    await tickProgram(P.H.ctx, 'sun2', subjectId)
    await dispatch(P)
    expect((await getRun(P, 'sun2', subjectId))!.unansweredAttempts).toBe(1)
    advance(2 * DAY)
    await tickProgram(P.H.ctx, 'sun2', subjectId)
    await dispatch(P)
    expect((await getRun(P, 'sun2', subjectId))!.unansweredAttempts).toBe(2)
  })
})

describe('sunset ask is only "sent" when accepted', () => {
  it('a suppressed ask leaves sunsetAskSent false and the run active', async () => {
    startClock()
    const def = buildProgram({
      slug: 'sun3',
      policy: { minGapDays: 1, sunset: { slowAfter: 1, slowFactor: 1, askAfter: 2, askTemplateSlug: 'still-want-these' } },
      actions: [{ id: 'connect-shopify', priority: 1, attempts: 9, satisfied: { fact: 'shopify_connected' } }],
    })
    await seedProgramWithTemplates(P.H, def)
    const { subjectId, owners } = await subject(P)
    await enter(P, 'sun3', subjectId)
    for (let i = 0; i < 2; i++) {
      await tickProgram(P.H.ctx, 'sun3', subjectId)
      await dispatch(P)
      advance(DAY + 21 * HOUR)
    }
    expect(await tickProgram(P.H.ctx, 'sun3', subjectId)).toMatchObject({ chosen: SUNSET_ASK_ACTION_ID })
    await P.H.mailer.unsubscribe(owners[0]!.email, { scope: `category:${CATEGORY}`, reason: 'user_request', source: 't' })
    await dispatch(P)
    expect(await getRun(P, 'sun3', subjectId)).toMatchObject({ sunsetAskSent: false, status: 'active' })
  })
})

describe('exit details (§5.4 step 3)', () => {
  it('cancels a deferred send with run_inactive; exit beats in-flight', async () => {
    startClock()
    P.H.mailer.registerEvent({ name: 'Upgraded', dedupePolicy: 'once-per-contact' })
    const { subjectId, owners } = await subject(P)
    await P.H.mailer.sendOneOff({ templateSlug: 'news', externalId: owners[0]!.externalId, dedupeKey: `e-${subjectId}` })
    await dispatch(P)
    advance(HOUR)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await dispatch(P)
    expect((await programSends(P, subjectId))[0]!.status).toBe('deferred')
    advance(MINUTE)
    await P.H.mailer.fire('Upgraded', subjectId)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'exited' })
    expect((await programSends(P, subjectId))[0]).toMatchObject({ status: 'cancelled', exitReason: 'run_inactive' })
  })
})

describe('step 0 and step 2', () => {
  it('a run whose program was deleted → not_found; unpublished → disabled', async () => {
    startClock()
    await seedProgramWithTemplates(P.H, activation({ slug: 'temp' }))
    const a = await subject(P)
    await enter(P, 'temp', a.subjectId)
    await P.H.mailer.collections.programs.updateOne({ slug: 'temp' }, { $set: { version: 0, definition: null } })
    expect(await tickProgram(P.H.ctx, 'temp', a.subjectId)).toEqual({ status: 'skipped', skipped: 'disabled' })
    await P.H.mailer.collections.programs.deleteOne({ slug: 'temp' })
    expect(await tickProgram(P.H.ctx, 'temp', a.subjectId)).toEqual({ status: 'skipped', skipped: 'not_found' })
  })

  it('a draft does not affect runs', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await P.H.mailer.collections.programs.updateOne({ slug }, { $set: { draft: { definition: activation({ actions: [] as any }), notes: '', lastModifiedBy: 't', lastModifiedAt: new Date() } } })
    try {
      expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ chosen: 'connect-shopify' })
    } finally {
      await P.H.mailer.collections.programs.updateOne({ slug }, { $set: { draft: null } })
    }
  })

  it('resolve is called exactly once per tick', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    const before = P.facts.resolveCalls.filter((c) => c.subjectId === subjectId).length
    await tickProgram(P.H.ctx, slug, subjectId)
    expect(P.facts.resolveCalls.filter((c) => c.subjectId === subjectId).length).toBe(before + 1)
  })

  it('a tick writes lease.until = now + programs.leaseMs while it runs', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const runId = await enter(P, slug, subjectId)
    let seen: Date | null = null
    const orig = P.facts.resolve.bind(P.facts)
    P.facts.resolve = async (id) => {
      seen = (await P.H.mailer.collections.programRuns.findOne({ _id: runId }))!.lease?.until ?? null
      return orig(id)
    }
    try {
      await tickProgramRun(P.H.ctx, runId, { worker: 'w' })
    } finally {
      P.facts.resolve = orig
    }
    expect(seen).toEqual(new Date(Date.now() + 45_000))
  })
})

describe('recipients (§5.4 step 13)', () => {
  it('passes the rule; drops blank emails and owners opted out of the category', async () => {
    startClock()
    const { subjectId, owners } = await subject(P, {}, { owners: 3 })
    await P.H.mailer.unsubscribe(owners[1]!.email, { scope: `category:${CATEGORY}`, reason: 'user_request', source: 't' })
    P.facts.setRecipients(subjectId, [owners[0]!, owners[1]!, { ...owners[2]!, email: '' }])
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    expect(P.facts.recipientCalls.at(-1)).toEqual({ subjectId, rule: 'owners' })
    const sends = await programSends(P, subjectId)
    expect(sends.map((s) => s.emailAtSend)).toEqual([owners[0]!.email])
  })
})

describe('hold + cooldown (§5.4 step 4)', () => {
  it('a cooling hold action holds lower actions; a second ladder bumps ladder again', async () => {
    startClock()
    const def = buildProgram({
      slug: 'holdcool',
      actions: [
        { id: 'connect-shopify', priority: 10, attempts: 1, cooldownDays: 7, onExhaust: 'hold', satisfied: { fact: 'shopify_connected' } },
        { id: 'connect-ga4', priority: 5, satisfied: { fact: 'ga4_connected' } },
      ],
    })
    await seedProgramWithTemplates(P.H, def)
    const { subjectId } = await subject(P)
    await enter(P, 'holdcool', subjectId)
    for (let ladder = 1; ladder <= 2; ladder++) {
      await tickProgram(P.H.ctx, 'holdcool', subjectId)
      await dispatch(P)
      advance(3 * DAY + MINUTE)
      const d = await tickProgram(P.H.ctx, 'holdcool', subjectId)
      expect(d).toMatchObject({ chosen: null })
      const dec = (await lastDecision(P, 'holdcool', subjectId))!
      expect(dec.candidates.find((c) => c.actionId === 'connect-ga4')!.blockedBy).toBe('hold')
      advance(7 * DAY)
    }
    expect((await programSends(P, subjectId)).map((s) => s.program!.ladder)).toEqual([1, 2])
  })
})

describe('entry (§5.3, §11 step 4)', () => {
  it('concurrent enterProgram → one run; a completed run is not revived', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true, ga4_connected: true, agent_connected: true, playbooks_run: 1 })
    const res = await Promise.all([enterProgram(P.H.ctx, slug, subjectId), enterProgram(P.H.ctx, slug, subjectId)])
    expect(res.filter((r) => r.created)).toHaveLength(1)
    await tickProgram(P.H.ctx, slug, subjectId)
    expect((await getRun(P, slug, subjectId))!.status).toBe('completed')
    expect(await enterProgram(P.H.ctx, slug, subjectId)).toMatchObject({ created: false })
    expect((await getRun(P, slug, subjectId))!.status).toBe('completed')
  })

  it('entry events fired while a program was disabled are NOT entered when it is enabled', async () => {
    startClock()
    await seedProgramWithTemplates(P.H, activation({ slug: 'later', entry: { eventName: 'Later Created' } }), { enabled: false })
    P.H.mailer.registerEvent({ name: 'Later Created', dedupePolicy: 'once-per-contact' })
    const { subjectId } = await subject(P)
    advance(MINUTE)
    await P.H.mailer.fire('Later Created', subjectId)
    await P.H.drain()
    advance(MINUTE)
    // Enabling moves the entry watermark to now: earlier events are history, not a backlog to mail.
    // Existing subjects are entered deliberately with mailer.enterProgram (backfill).
    await P.H.mailer.setProgramEnabled('later', true, { actor: 'test' })
    await P.H.drain()
    expect(await getRun(P, 'later', subjectId)).toBeNull()
  })

  it('runProgramScheduler is a no-op with no enabled program', async () => {
    const plain = await programHarness()
    try {
      expect(await runProgramScheduler(plain.H.ctx)).toEqual({ entered: 0, woken: 0, ticked: 0 })
    } finally {
      await plain.H.stop()
    }
  }, 120_000)
})

describe('checklist edge statuses (§5.11)', () => {
  it('renders exhausted and cooldown, and no isNext after a silent tick', async () => {
    startClock()
    const def = buildProgram({
      slug: 'cl',
      actions: [
        { id: 'connect-shopify', priority: 10, attempts: 1, cooldownDays: 30, satisfied: { fact: 'shopify_connected' } },
        { id: 'connect-ga4', priority: 5, attempts: 1, satisfied: { fact: 'ga4_connected' } },
      ],
    })
    await seedProgramWithTemplates(P.H, def)
    const { subjectId } = await subject(P)
    await enter(P, 'cl', subjectId)
    for (let i = 0; i < 3; i++) {
      await tickProgram(P.H.ctx, 'cl', subjectId)
      await dispatch(P)
      advance(3 * DAY + MINUTE)
    }
    const state = (await P.H.mailer.getProgramState('cl', subjectId))!
    expect(state.map((s) => s.status)).toEqual(['cooldown', 'exhausted'])
    expect(state.some((s) => s.isNext)).toBe(false)
  })
})

describe('precedence of silent reasons (§5.4 steps 9–12)', () => {
  it('in-flight beats session; session beats min-gap', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId) // queued, in flight
    P.facts.set(subjectId, { last_session_at: new Date() })
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'in-flight' })
    await dispatch(P)
    advance(HOUR)
    P.facts.set(subjectId, { last_session_at: new Date() })
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'session-suppressed' })
  })
})

describe('definition changes under a live run', () => {
  it('a send for an action removed from the definition is cancelled at dispatch', async () => {
    startClock()
    await seedProgramWithTemplates(P.H, activation({ slug: 'shrink' }))
    const { subjectId } = await subject(P)
    await enter(P, 'shrink', subjectId)
    await tickProgram(P.H.ctx, 'shrink', subjectId)
    const v2 = activation({ slug: 'shrink' })
    v2.actions = v2.actions.filter((a) => a.id !== 'connect-shopify')
    await P.H.mailer.collections.programs.updateOne({ slug: 'shrink' }, { $set: { definition: v2, version: 2 } })
    await dispatch(P)
    expect((await programSends(P, subjectId))[0]).toMatchObject({ status: 'cancelled', exitReason: 'ineligible_before_send' })
    advance(MINUTE)
    expect(await tickProgram(P.H.ctx, 'shrink', subjectId)).toMatchObject({ chosen: 'connect-ga4' })
  })
})

describe('guard fails closed (INV 19)', () => {
  it('facts adapter throwing at dispatch → no provider call; ineligible cancel keeps attempts and completedAt unset', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const orig = P.facts.resolve.bind(P.facts)
    P.facts.resolve = async () => { throw new Error('host down') }
    try { await dispatch(P) } finally { P.facts.resolve = orig }
    expect(delivered(P, owners)).toHaveLength(0)

    P.facts.set(subjectId, { business_type: 'saas' })
    await P.H.mailer.collections.sends.updateMany({ 'program.subjectId': subjectId, status: { $in: ['sending', 'failed'] } }, { $set: { status: 'queued' } })
    await dispatch(P)
    const run = (await getRun(P, slug, subjectId))!
    expect(run.actions['connect-shopify']).toMatchObject({ attempts: 0, completedAt: null })
    expect(await decisionsFor(P, slug, subjectId)).toHaveLength(1)
  })
})
