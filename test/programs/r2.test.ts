/**
 * R2 area-review regressions (0.21 Programs engine): double send on a send
 * accepted mid-tick, scan stalls on bursts, failed-send liveness, lease
 * fencing, sunset ask vs re-engagement, atomic attempt counting, provider
 * `rejected`, and completedAt clobbering.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildProgram, tickProgram } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { releaseDueDeferredSends } from '../../src/server/runner/contact-policy.js'
import { programSendHooks, runProgramScheduler, tickProgramRun } from '../../src/server/runner/programs/index.js'
import { advance, HOUR, MINUTE, restoreClock } from '../matrix/clock.js'
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

afterEach(() => {
  restoreClock()
  vi.restoreAllMocks()
})

describe('R2 batch 1: tick vs dispatch, scans, sunset', () => {
  let P: ProgramHarness
  beforeAll(async () => {
    P = await programHarness({ programs: { batchSize: 1 } } as any)
    await seedProgramWithTemplates(P.H, activation())
    await seedProgramWithTemplates(P.H, activation({ slug: 'wakes' }))
  }, 120_000)
  afterAll(async () => {
    restoreClock()
    if (P) await P.H.stop()
  })

  it('1: a send accepted while a tick resolves facts is not re-sent as the same attempt', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'activation', subjectId)
    await tickProgram(P.H.ctx, 'activation', subjectId)
    const [s1] = await programSends(P, subjectId)
    advance(5 * MINUTE)
    const original = P.facts.resolve.bind(P.facts)
    let fired = false
    P.facts.resolve = async (id) => {
      const f = await original(id)
      if (!fired) {
        fired = true
        await dispatchSend(s1!._id!, P.H.ctx) // the send worker finishes D1 meanwhile
      }
      return f
    }
    try {
      await tickProgram(P.H.ctx, 'activation', subjectId, { trigger: 'facts_changed' } as any)
    } finally {
      P.facts.resolve = original
    }
    await dispatch(P)
    expect(delivered(P, owners).length).toBe(1)
    expect((await programSends(P, subjectId)).length).toBe(1)
  })

  it('1b: a send accepted between the fresh read and the tick write abandons the send decision', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'activation', subjectId)
    await tickProgram(P.H.ctx, 'activation', subjectId)
    const [s1] = await programSends(P, subjectId)
    advance(5 * MINUTE)
    const adapter = P.facts as any
    const origRecipients = adapter.recipients.bind(adapter)
    let fired = false
    adapter.recipients = async (...a: any[]) => {
      const r = await origRecipients(...a)
      if (!fired) {
        fired = true
        await dispatchSend(s1!._id!, P.H.ctx) // lands after the tick's fresh read
      }
      return r
    }
    // D1 is still queued at the fresh read, so the tick sees it in flight: force the
    // window by clearing inFlight so the tick proceeds to recipients.
    await P.H.ctx.collections.programRuns.updateOne({ programSlug: 'activation', subjectId }, { $set: { inFlight: null } })
    let r: any
    try {
      r = await tickProgram(P.H.ctx, 'activation', subjectId, { trigger: 'facts_changed' } as any)
    } finally {
      adapter.recipients = origRecipients
    }
    await dispatch(P)
    expect(r.reason).toBe('in-flight')
    expect(r.sendIds).toHaveLength(0)
    expect(delivered(P, owners).length).toBe(1)
    const run = (await getRun(P, 'activation', subjectId))!
    expect(run.actions['connect-shopify']!.attempts).toBe(1)
  })

  it('2: more than 1000 entry events inside 30s do not stall the scan', async () => {
    const t = startClock()
    const docs = Array.from({ length: 1005 }, (_, i) => ({
      externalId: `bulk-${i}`,
      name: 'Created',
      properties: {},
      dedupeKey: `bulk-${i}`,
      occurredAt: t,
      createdAt: new Date(t.getTime() + i),
    }))
    await P.H.ctx.collections.events.insertMany(docs as any)
    for (let i = 0; i < 4; i++) {
      advance(MINUTE)
      await runProgramScheduler(P.H.ctx)
    }
    expect(await P.H.ctx.collections.programRuns.countDocuments({ programSlug: 'activation', subjectId: /^bulk-/ })).toBe(1005)
  }, 120_000)

  it('2b: more than 1000 Facts Changed events inside 30s all wake their runs', async () => {
    const t = startClock()
    const C = P.H.ctx.collections
    const far = new Date(t.getTime() + 365 * 24 * HOUR)
    const runs = Array.from({ length: 1005 }, (_, i) => ({
      programSlug: 'wakes',
      programVersion: 1,
      subjectId: `wake-${i}`,
      status: 'active' as const,
      arm: 'treatment' as const,
      actions: {},
      unansweredAttempts: 0,
      lastEngagementAt: null,
      sunsetStage: 0 as const,
      sunsetAskSent: false,
      lastSentAt: null,
      inFlight: null,
      lastCountedDecisionId: null,
      nextTickAt: far,
      lease: null,
      enteredAt: t,
      entryEventAt: t,
      completedAt: null,
      exitedAt: null,
      exitReason: null,
      createdAt: t,
      updatedAt: t,
    }))
    await C.programRuns.insertMany(runs as any)
    advance(MINUTE)
    const base = new Date()
    await C.events.insertMany(
      Array.from({ length: 1005 }, (_, i) => ({
        externalId: `wake-${i}`,
        name: 'Facts Changed',
        properties: {},
        dedupeKey: `fc-${i}-${base.getTime()}`,
        occurredAt: base,
        createdAt: new Date(base.getTime() + i),
      })) as any,
    )
    advance(MINUTE)
    for (let i = 0; i < 4; i++) {
      await runProgramScheduler(P.H.ctx)
    }
    expect(await C.programRuns.countDocuments({ programSlug: 'wakes', wakeRequestedAt: { $ne: null } })).toBe(1005)
  }, 120_000)

  it('8: the tick does not overwrite an action completedAt the guard set meanwhile', async () => {
    startClock()
    const { subjectId } = await subject(P, { ga4_connected: true })
    await enter(P, 'activation', subjectId)
    const guardTime = new Date(Date.now() - 1000)
    const original = P.facts.resolve.bind(P.facts)
    P.facts.resolve = async (id) => {
      const f = await original(id)
      // The guard of a dispatching send marks the action satisfied while this tick runs.
      await P.H.ctx.collections.programRuns.updateOne(
        { programSlug: 'activation', subjectId },
        { $set: { 'actions.connect-ga4': { status: 'satisfied', attempts: 0, ladder: 1, lastSentAt: null, completedAt: guardTime, exhaustedAt: null, cooldownUntil: null, version: 1 } } },
      )
      return f
    }
    try {
      await tickProgram(P.H.ctx, 'activation', subjectId)
    } finally {
      P.facts.resolve = original
    }
    const run = (await getRun(P, 'activation', subjectId))!
    expect(run.actions['connect-ga4']!.completedAt!.getTime()).toBe(guardTime.getTime())
  })
})

describe('R2 batch 2: deferral failure, sunset ask, counting, rejection', () => {
  let P: ProgramHarness
  beforeAll(async () => {
    P = await programHarness({ contactPolicy: { marketing: { minGapHours: 20, deferral: { maxHours: 72 } } } } as any)
    await seedProgramWithTemplates(P.H, activation())
    await seedProgramWithTemplates(
      P.H,
      buildProgram({
        slug: 'sun',
        policy: { minGapDays: 2, sunset: { slowAfter: 1, slowFactor: 1, askAfter: 2, askTemplateSlug: 'still-want-these' } },
        actions: [{ id: 'a', priority: 100, attempts: 8, satisfied: { fact: 'shopify_connected' } }],
      }),
    )
    await P.H.seedTemplate({ slug: 'other-news', kind: 'marketing', category: 'product.updates', subject: 'news', text: 'n' } as any)
  }, 120_000)
  afterAll(async () => {
    restoreClock()
    if (P) await P.H.stop()
  })

  it('3: a provider error on a released deferred send does not let the next tick send the attempt again', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await P.H.mailer.sendOneOff({ templateSlug: 'other-news', externalId: owners[0]!.externalId, dedupeKey: `n-${subjectId}` })
    await dispatch(P)
    advance(HOUR)
    await enter(P, 'activation', subjectId)
    await tickProgram(P.H.ctx, 'activation', subjectId)
    await dispatch(P)
    const [d1] = await programSends(P, subjectId)
    expect(d1!.status).toBe('deferred')
    advance(20 * HOUR)
    await releaseDueDeferredSends(P.H.ctx)
    const inner = P.H.provider.inner as any
    const orig = inner.send.bind(inner)
    inner.send = async () => {
      throw new Error('provider 503')
    }
    try {
      await dispatchSend(d1!._id!, P.H.ctx).catch(() => {})
    } finally {
      inner.send = orig
    }
    expect((await P.H.ctx.collections.sends.findOne({ _id: d1!._id }))!.status).toBe('failed')
    await tickProgram(P.H.ctx, 'activation', subjectId, { trigger: 'facts_changed' } as any)
    advance(MINUTE)
    await dispatchSend(d1!._id!, P.H.ctx) // the queue retry
    for (let i = 0; i < 3; i++) {
      advance(21 * HOUR)
      await P.H.drain()
    }
    // One send row for attempt 1 (the tick did not decide it again); it went out on the queue retry.
    const rows = await programSends(P, subjectId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('sent')
    expect((await getRun(P, 'activation', subjectId))!.actions['connect-shopify']!.attempts).toBe(1)
    void owners
  })

  it('5: an engaged run is not put into sunset when the in-flight ask is accepted later', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'sun', subjectId)
    await P.H.ctx.collections.programRuns.updateOne(
      { programSlug: 'sun', subjectId },
      { $set: { unansweredAttempts: 2, sunsetStage: 2, lastEngagementAt: new Date() } },
    )
    const ask = await tickProgram(P.H.ctx, 'sun', subjectId)
    expect(ask).toMatchObject({ chosen: '$sunset-ask' })
    advance(HOUR)
    P.facts.setSubject(subjectId, { facts: { business_type: 'ecommerce', shopify_connected: false, last_session_at: new Date() }, recipients: owners })
    advance(MINUTE)
    await tickProgram(P.H.ctx, 'sun', subjectId)
    await dispatch(P)
    const run = (await getRun(P, 'sun', subjectId))!
    expect(run.status).toBe('active')
    expect(run.sunsetAskSent).toBe(false)
  })

  it('5b: counting an ask accepted after re-engagement does not move the run to sunset', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'sun', subjectId)
    await P.H.ctx.collections.programRuns.updateOne(
      { programSlug: 'sun', subjectId },
      { $set: { unansweredAttempts: 2, sunsetStage: 2, lastEngagementAt: new Date() } },
    )
    await tickProgram(P.H.ctx, 'sun', subjectId)
    const [ask] = await programSends(P, subjectId)
    advance(HOUR)
    P.facts.setSubject(subjectId, { facts: { business_type: 'ecommerce', shopify_connected: false, last_session_at: new Date() }, recipients: owners })
    advance(MINUTE)
    await tickProgram(P.H.ctx, 'sun', subjectId) // engagement resets the run
    // The ask had already left the guard: its acceptance is counted afterwards.
    await programSendHooks.onOutcome!(ask!, { status: 'sent', at: new Date() }, P.H.ctx)
    const run = (await getRun(P, 'sun', subjectId))!
    expect(run.status).toBe('active')
    expect(run.sunsetAskSent).toBe(false)
    expect(run.sunsetStage).not.toBe(2)
  })

  it('6: a crash between status sent and the hook does not replay the attempt', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'activation', subjectId)
    await tickProgram(P.H.ctx, 'activation', subjectId)
    const C = P.H.ctx.collections
    const real = C.programRuns.findOneAndUpdate.bind(C.programRuns)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let threw = false
    vi.spyOn(C.programRuns, 'findOneAndUpdate').mockImplementation((async (...a: any[]) => {
      if (!threw) {
        threw = true
        throw new Error('crash in hook')
      }
      return (real as any)(...a)
    }) as any)
    await dispatch(P)
    vi.restoreAllMocks()
    void err
    const [s1] = await programSends(P, subjectId)
    expect(s1!.status).toBe('sent')
    expect(s1!.program!.counted).not.toBe(true)
    expect((await getRun(P, 'activation', subjectId))!.actions['connect-shopify']?.attempts ?? 0).toBe(0)
    advance(MINUTE)
    const t: any = await tickProgram(P.H.ctx, 'activation', subjectId)
    expect(t.sendIds).toHaveLength(0) // reconciled, not re-sent
    const run = (await getRun(P, 'activation', subjectId))!
    expect(run.actions['connect-shopify']!.attempts).toBe(1)
    expect(run.inFlight).toBeNull()
    expect(delivered(P, owners).filter((s) => s.subject.startsWith('connect-shopify-1')).length).toBe(1)
    expect((await P.H.ctx.collections.sends.findOne({ _id: s1!._id }))!.program!.counted).toBe(true)
  })

  it('7: a provider result of rejected is a failed send, not sent', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, 'activation', subjectId)
    await tickProgram(P.H.ctx, 'activation', subjectId)
    const inner = P.H.provider.inner as any
    const orig = inner.send.bind(inner)
    inner.send = async () => ({ providerId: 'x', status: 'rejected' })
    try {
      await dispatch(P)
    } finally {
      inner.send = orig
    }
    const [s1] = await programSends(P, subjectId)
    expect(s1!.status).toBe('failed')
    expect(s1!.errorMessage).toBe('rejected by provider')
    const ds = await decisionsFor(P, 'activation', subjectId)
    expect(ds[0]!.outcome?.status).toBe('failed')
    const run = (await getRun(P, 'activation', subjectId))!
    expect(run.actions['connect-shopify']?.attempts ?? 0).toBe(0)
  })
})

describe('R2 batch 3: lease fencing', () => {
  let P: ProgramHarness
  beforeAll(async () => {
    P = await programHarness({ programs: { leaseMs: 5_000 } } as any)
    await seedProgramWithTemplates(P.H, activation())
  }, 120_000)
  afterAll(async () => {
    restoreClock()
    if (P) await P.H.stop()
  })

  it('4: a tick that outlives its lease does not write after a takeover', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const runId = await enter(P, 'activation', subjectId)
    const original = P.facts.resolve.bind(P.facts)
    let n = 0
    P.facts.resolve = async (id) => {
      const f = await original(id)
      if (n++ === 0) {
        advance(10_000) // slow host call: the lease expires and another worker ticks
        await tickProgramRun(P.H.ctx, runId, { worker: 'w2' })
      }
      return f
    }
    let res: any
    try {
      res = await tickProgramRun(P.H.ctx, runId, { worker: 'w1' })
    } finally {
      P.facts.resolve = original
    }
    const sends = await programSends(P, subjectId)
    expect(sends).toHaveLength(1)
    expect(res).toMatchObject({ status: 'skipped', skipped: 'leased' })
    expect(await P.H.ctx.collections.programDecisions.countDocuments({ subjectId })).toBe(1)
  })

  it('4b: a slow resolve within the renewed lease keeps the lease', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const runId = await enter(P, 'activation', subjectId)
    const original = P.facts.resolve.bind(P.facts)
    P.facts.resolve = async (id) => {
      const f = await original(id)
      advance(4_000)
      return f
    }
    let res: any
    try {
      res = await tickProgramRun(P.H.ctx, runId, { worker: 'w1' })
    } finally {
      P.facts.resolve = original
    }
    expect(res.status).toBe('ticked')
    expect(await programSends(P, subjectId)).toHaveLength(1)
  })
})
