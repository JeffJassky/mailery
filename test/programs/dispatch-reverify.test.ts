/**
 * Dispatch-time re-verification — INVARIANT 19.
 *
 * Part 1 (PR 3): the per-origin hook mechanism in `dispatchSend`. A guard
 * runs on every dispatch (re-dispatch of a deferred send included), after
 * suppression and BEFORE the contact policy, and can cancel. `onOutcome`
 * hears every transition.
 *
 * Part 2 (PR 4): the Program guard. It re-reads facts (never the tick's
 * snapshot) and cancels a send whose action is already satisfied, no longer
 * eligible, or whose run is no longer active.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ObjectId } from 'mongodb'

import { tickProgram } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import type { SendHooks, SendOutcome } from '../../src/server/runner/send-hooks.js'
import { advance, DAY, HOUR, MINUTE, restoreClock } from '../matrix/clock.js'
import {
  activation,
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

let P: ProgramHarness
const slug = 'activation'

beforeAll(async () => {
  P = await programHarness({ contactPolicy: { marketing: { minGapHours: 20 } } })
  await seedProgramWithTemplates(P.H, activation())
  await P.H.seedTemplate({ slug: 'news', kind: 'marketing', subject: 'News' })
  await P.H.seedTemplate({ slug: 'receipt', kind: 'transactional', subject: 'Receipt' })
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

// ---------------------------------------------------------------------------
// Part 1 — the hook mechanism
// ---------------------------------------------------------------------------

describe('send hooks in dispatchSend', () => {
  let saved: SendHooks | undefined
  const calls: Array<{ kind: 'guard' | 'outcome'; sendId: string; outcome?: SendOutcome }> = []
  let verdict: 'send' | 'cancel' = 'send'

  function install() {
    saved = P.H.ctx.sendHooks
    P.H.ctx.sendHooks = {
      ...(saved ?? {}),
      oneoff: {
        async guard(send) {
          calls.push({ kind: 'guard', sendId: String(send._id) })
          return verdict === 'send'
            ? { verdict: 'send' }
            : { verdict: 'cancel', exitReason: 'satisfied_before_send', message: 'test guard said no' }
        },
        async onOutcome(send, outcome) {
          calls.push({ kind: 'outcome', sendId: String(send._id), outcome })
        },
      },
    }
  }
  afterEach(() => {
    // Restore only when this test swapped the hooks; otherwise `saved` is stale.
    if (saved !== undefined) P.H.ctx.sendHooks = saved
    saved = undefined
    calls.length = 0
    verdict = 'send'
  })

  let n = 0
  async function contact() {
    n++
    await P.H.seedContact({ externalId: `hook-${n}`, email: `hook-${n}@example.com`, tags: [], fields: {} })
    return `hook-${n}`
  }
  async function queue(externalId: string, slugT = 'news') {
    const key = `h-${externalId}-${Math.random()}`
    await P.H.mailer.sendOneOff({ templateSlug: slugT, externalId, dedupeKey: key })
    return (await P.H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:${key}` }))!._id as ObjectId
  }

  it('the Mailer registers flow and program hooks', () => {
    expect(P.H.ctx.sendHooks?.flow?.guard).toBeTypeOf('function')
    expect(P.H.ctx.sendHooks?.program?.guard).toBeTypeOf('function')
    expect(P.H.ctx.sendHooks?.program?.onOutcome).toBeTypeOf('function')
  })

  it('guard runs before the provider; onOutcome hears sent', async () => {
    startClock()
    install()
    const id = await contact()
    const sendId = await queue(id)
    await dispatchSend(sendId, P.H.ctx)
    expect(calls.map((c) => c.kind)).toEqual(['guard', 'outcome'])
    expect(calls[1]!.outcome).toMatchObject({ status: 'sent' })
  })

  it('guard cancel → cancelled with exitReason, no provider call', async () => {
    startClock()
    install()
    verdict = 'cancel'
    const id = await contact()
    const sendId = await queue(id)
    const before = P.H.provider.sent.length
    await dispatchSend(sendId, P.H.ctx)
    expect(P.H.provider.sent.length).toBe(before)
    const row = (await P.H.mailer.collections.sends.findOne({ _id: sendId }))!
    expect(row).toMatchObject({ status: 'cancelled', exitReason: 'satisfied_before_send' })
    expect(row.errorMessage).toContain('test guard said no')
    expect(calls.at(-1)!.outcome).toMatchObject({ status: 'cancelled', exitReason: 'satisfied_before_send' })
  })

  it('guard runs before the contact policy: a cancelled send is never deferred first', async () => {
    startClock()
    install()
    const id = await contact()
    await dispatchSend(await queue(id), P.H.ctx) // sent; opens the 20h gap
    calls.length = 0
    verdict = 'cancel'
    const second = await queue(id)
    await dispatchSend(second, P.H.ctx)
    expect((await P.H.mailer.collections.sends.findOne({ _id: second }))!.status).toBe('cancelled')
    expect(calls.map((c) => c.outcome?.status ?? c.kind)).toEqual(['guard', 'cancelled'])
  })

  it('guard runs again when a deferred send is re-dispatched', async () => {
    startClock()
    install()
    const id = await contact()
    await dispatchSend(await queue(id), P.H.ctx)
    advance(HOUR)
    const second = await queue(id)
    await dispatchSend(second, P.H.ctx)
    expect((await P.H.mailer.collections.sends.findOne({ _id: second }))!.status).toBe('deferred')
    expect(calls.filter((c) => c.kind === 'outcome').at(-1)!.outcome).toMatchObject({ status: 'deferred', reason: 'min_gap' })

    calls.length = 0
    verdict = 'cancel'
    advance(20 * HOUR)
    await P.H.drain()
    expect(calls[0]!.kind).toBe('guard')
    expect((await P.H.mailer.collections.sends.findOne({ _id: second }))!.status).toBe('cancelled')
  })

  it('onOutcome hears suppressed', async () => {
    startClock()
    install()
    const id = await contact()
    await P.H.mailer.unsubscribe(`${id}@example.com`, { scope: 'marketing', reason: 'user_request', source: 'test' })
    await dispatchSend(await queue(id), P.H.ctx)
    expect(calls.at(-1)!.outcome).toMatchObject({ status: 'suppressed' })
  })

  it('onOutcome hears failed', async () => {
    startClock()
    install()
    const id = await contact()
    const inner = P.H.provider.inner as any
    const original = inner.send.bind(inner)
    inner.send = async () => { throw new Error('boom') }
    try {
      await dispatchSend(await queue(id), P.H.ctx).catch(() => {})
    } finally {
      inner.send = original
    }
    expect(calls.at(-1)!.outcome).toMatchObject({ status: 'failed', error: expect.stringContaining('boom') })
  })

  it('transactional sends run their origin guard too (only the policy is skipped)', async () => {
    startClock()
    install()
    const id = await contact()
    await dispatchSend(await queue(id, 'receipt'), P.H.ctx)
    expect(calls[0]!.kind).toBe('guard')
  })

  it('a throwing guard fails closed: no provider call, error propagates', async () => {
    startClock()
    saved = P.H.ctx.sendHooks
    P.H.ctx.sendHooks = { ...(saved ?? {}), oneoff: { guard: async () => { throw new Error('guard exploded') } } }
    const id = await contact()
    const sendId = await queue(id)
    const before = P.H.provider.sent.length
    await expect(dispatchSend(sendId, P.H.ctx)).rejects.toThrow('guard exploded')
    expect(P.H.provider.sent.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Part 2 — the Program guard
// ---------------------------------------------------------------------------

describe('Program re-verify at dispatch', () => {
  it('satisfied between tick and dispatch → cancelled satisfied_before_send, action marked satisfied, attempt unchanged', async () => {
    const t = startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    advance(MINUTE)
    P.facts.set(subjectId, { shopify_connected: true })
    await dispatch(P)

    expect(delivered(P, owners)).toHaveLength(0)
    const [send] = await programSends(P, subjectId)
    expect(send).toMatchObject({ status: 'cancelled', exitReason: 'satisfied_before_send' })
    const run = (await getRun(P, slug, subjectId))!
    expect(run.actions['connect-shopify']).toMatchObject({ status: 'satisfied', attempts: 0 })
    expect(run.actions['connect-shopify']!.completedAt!.getTime()).toBe(t.getTime() + MINUTE)
    expect(run.inFlight).toBeNull()
  })

  it('ineligible between tick and dispatch → cancelled ineligible_before_send', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    P.facts.set(subjectId, { business_type: 'saas' })
    await dispatch(P)
    expect((await programSends(P, subjectId))[0]).toMatchObject({ status: 'cancelled', exitReason: 'ineligible_before_send' })
  })

  it('run aborted between tick and dispatch → cancelled run_inactive', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    // Bypass abortProgram's own send cancellation to prove the guard alone holds.
    await P.H.mailer.collections.programRuns.updateOne({ programSlug: slug, subjectId }, { $set: { status: 'exited', exitReason: 'test' } })
    await dispatch(P)
    expect((await programSends(P, subjectId))[0]).toMatchObject({ status: 'cancelled', exitReason: 'run_inactive' })
  })

  it('re-verify uses fresh facts, not the tick snapshot', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const before = P.facts.resolveCalls.filter((c) => c.subjectId === subjectId).length
    await dispatch(P)
    expect(P.facts.resolveCalls.filter((c) => c.subjectId === subjectId).length).toBe(before + 1)
  })

  it('a deferred Program send re-verifies on re-dispatch', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await P.H.mailer.sendOneOff({ templateSlug: 'news', externalId: owners[0]!.externalId, dedupeKey: `pre-${subjectId}` })
    await dispatch(P)
    advance(HOUR)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await dispatch(P)
    expect((await programSends(P, subjectId))[0]!.status).toBe('deferred')

    P.facts.set(subjectId, { shopify_connected: true })
    advance(20 * HOUR)
    await P.H.drain()
    expect((await programSends(P, subjectId))[0]).toMatchObject({ status: 'cancelled', exitReason: 'satisfied_before_send' })
    expect(delivered(P, owners).filter((s) => s.subject.startsWith('connect-shopify'))).toHaveLength(0)
  })
})

describe('abortProgram', () => {
  it('exits the run and cancels queued and deferred sends; no-op the second time', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const res = await P.H.mailer.abortProgram(slug, subjectId, { reason: 'upgraded' })
    expect(res).toEqual({ aborted: true, cancelledSends: 1 })
    expect(await getRun(P, slug, subjectId)).toMatchObject({ status: 'exited', exitReason: 'aborted_by_host: upgraded' })
    expect((await programSends(P, subjectId))[0]).toMatchObject({ status: 'cancelled', exitReason: 'run_inactive' })
    expect(await P.H.mailer.abortProgram(slug, subjectId)).toEqual({ aborted: false, cancelledSends: 0 })
    const audit = await P.H.mailer.collections.auditLog.findOne({ action: 'program.abort' })
    expect(audit).not.toBeNull()
  })

  it('no run at all → no-op', async () => {
    startClock()
    expect(await P.H.mailer.abortProgram(slug, 'never-entered')).toEqual({ aborted: false, cancelledSends: 0 })
  })

  it('a later tick of an aborted run is skipped', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await P.H.mailer.abortProgram(slug, subjectId)
    advance(DAY)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toEqual({ status: 'skipped', skipped: 'inactive' })
  })
})
