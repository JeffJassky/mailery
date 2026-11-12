/**
 * `wait_until` runner matrix (plans/19 §4, plans/19a §6 step 3).
 *
 * A `wait_until` parks the run ON ITS OWN STEP and re-reads its date fact
 * through the facts adapter at every wake, so a date the host moves is
 * followed with no host call. Real Mongo, real runner, frozen `Date` only
 * (see `clock.ts`). Each case owns its contact, template, flow and event name.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createTestMailer,
  MemoryContactAdapter,
  MemoryFactsAdapter,
  NullProvider,
  step,
  type TestMailerHarness,
} from '../../src/testing/index.js'
import { processOneRunStep } from '../../src/server/runner/index.js'
import { Mailer } from '../../src/server/mailer.js'
import { advance, DAY, freezeAt, HOUR, restoreClock } from './clock.js'
import type { FlowStep } from '../../src/shared/types.js'
import type { FlowRunDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness
let facts: MemoryFactsAdapter
let counter = 0

const T0 = '2026-03-02T09:00:00Z' // a Monday; nothing here depends on the weekday
const t0 = () => new Date(T0).getTime()

beforeAll(async () => {
  facts = new MemoryFactsAdapter({
    declare: {
      trial_ends_at: { type: 'date' },
      renews_at: { type: 'date' },
      plan: { type: 'string' },
    },
  })
  H = await createTestMailer({ config: { factsAdapter: facts } })
}, 60_000)

afterEach(() => {
  vi.restoreAllMocks()
  restoreClock()
})

afterAll(async () => {
  restoreClock()
  if (H) await H.stop()
})

interface Case {
  externalId: string
  email: string
  flowSlug: string
  eventName: string
  tpl: string
  alt: string
  fire: (properties?: Record<string, unknown>, dedupeKey?: string) => Promise<void>
  run: () => Promise<FlowRunDoc>
  runs: () => Promise<FlowRunDoc[]>
  sentCount: () => number
}

async function newCase(
  steps: (s: { tpl: string; alt: string; n: number }) => FlowStep[],
  harness: TestMailerHarness = H,
): Promise<Case> {
  const n = ++counter
  const externalId = `wu${n}`
  const email = `wu${n}@example.com`
  const flowSlug = `wu-flow-${n}`
  const eventName = `WaitUntil${n}`
  const tpl = `wu-tpl-${n}`
  const alt = `wu-tpl-${n}-alt`
  await harness.seedContact({ externalId, email, tags: [], fields: { firstName: `W${n}` } })
  await harness.seedTemplate({ slug: tpl, subject: `First ${n}` })
  await harness.seedTemplate({ slug: alt, subject: `Second ${n}` })
  await harness.seedFlow({ slug: flowSlug, eventName, once: false, steps: steps({ tpl, alt, n }) })
  harness.mailer.registerEvent({ name: eventName, dedupePolicy: 'every-time' })
  return {
    externalId,
    email,
    flowSlug,
    eventName,
    tpl,
    alt,
    fire: (properties = {}, dedupeKey) => harness.mailer.fire(eventName, externalId, properties, dedupeKey),
    run: async () => (await harness.ctx.collections.flowRuns.findOne({ flowSlug }))!,
    runs: () => harness.ctx.collections.flowRuns.find({ flowSlug }).toArray(),
    sentCount: () => harness.provider.toRecipient(email).length,
  }
}

const actions = (run: FlowRunDoc) => run.history.map((h) => h.action)
const ofAction = (run: FlowRunDoc, action: string) => run.history.filter((h) => h.action === action)
const at = (ms: number) => new Date(t0() + ms)
const ms = (d: unknown) => (d instanceof Date ? d.getTime() : new Date(String(d)).getTime())

// ---------------------------------------------------------------------------
// 1–2. Reached vs parked
// ---------------------------------------------------------------------------

describe('wait_until: reached and parked', () => {
  it('advances at once when the date is already past, and logs wait_until_reached', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-past', { trial_ends_at: at(-2 * DAY) })
    await c.fire({ accountId: 'acct-past' })
    await H.drain()

    const run = await c.run()
    expect(run.status).toBe('completed')
    expect(c.sentCount()).toBe(1)
    const reached = ofAction(run, 'wait_until_reached')
    expect(reached).toHaveLength(1)
    expect(reached[0]!.stepIndex).toBe(0)
    expect(reached[0]!.details).toMatchObject({ fact: 'trial_ends_at', subjectId: 'acct-past' })
    expect(ms(reached[0]!.details!.target)).toBe(t0() - 2 * DAY)
    expect(ofAction(run, 'wait_until_parked')).toHaveLength(0)
  })

  it('a date exactly now counts as reached', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-now', { trial_ends_at: at(0) })
    await c.fire({ accountId: 'acct-now' })
    await H.drain()
    expect((await c.run()).status).toBe('completed')
    expect(c.sentCount()).toBe(1)
  })

  it('parks on the SAME step with nextActionAt = target when the target is inside the recheck window', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-soon', { trial_ends_at: at(6 * HOUR) })
    await c.fire({ accountId: 'acct-soon' })
    const result = await H.drain()

    // A parked run with a future nextActionAt must not make drain spin.
    expect(result.settled).toBe(true)
    const run = await c.run()
    expect(run.status).toBe('active')
    expect(run.currentStepIndex).toBe(0)
    expect(ms(run.nextActionAt)).toBe(t0() + 6 * HOUR)
    expect(c.sentCount()).toBe(0)
    const parked = ofAction(run, 'wait_until_parked')
    expect(parked).toHaveLength(1)
    expect(parked[0]!.stepIndex).toBe(0)
    expect(parked[0]!.details).toMatchObject({ fact: 'trial_ends_at', subjectId: 'acct-soon' })
    expect(ms(parked[0]!.details!.target)).toBe(t0() + 6 * HOUR)
    expect(ms(parked[0]!.details!.wakeAt)).toBe(t0() + 6 * HOUR)

    advance(6 * HOUR)
    await H.drain()
    const done = await c.run()
    expect(done.status).toBe('completed')
    expect(c.sentCount()).toBe(1)
    expect(actions(done)).toContain('wait_until_reached')
  })

  it('caps the wake at now + 24h (default recheck) when the target is further out', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-far', { trial_ends_at: at(10 * DAY) })
    await c.fire({ accountId: 'acct-far' })
    await H.drain()

    const run = await c.run()
    expect(run.currentStepIndex).toBe(0)
    expect(ms(run.nextActionAt)).toBe(t0() + DAY)
    const parked = ofAction(run, 'wait_until_parked')
    expect(ms(parked[0]!.details!.target)).toBe(t0() + 10 * DAY)
    expect(ms(parked[0]!.details!.wakeAt)).toBe(t0() + DAY)
  })

  it('accepts an ISO string date fact', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-iso', { trial_ends_at: at(3 * HOUR).toISOString() })
    await c.fire({ accountId: 'acct-iso' })
    await H.drain()
    expect(ms((await c.run()).nextActionAt)).toBe(t0() + 3 * HOUR)
  })

  it('enqueues the delayed advance with the wake instant in its jobId', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-job', { trial_ends_at: at(5 * HOUR) })
    const add = vi.spyOn(H.ctx.queues.advance, 'add')
    await c.fire({ accountId: 'acct-job' })
    await H.drain()

    const run = await c.run()
    const wake = String(t0() + 5 * HOUR)
    const call = add.mock.calls.find(
      ([, data, opts]) => (data as any)?.flowRunId === String(run._id) && String((opts as any)?.jobId ?? '').includes(wake),
    )
    expect(call).toBeDefined()
    expect((call![2] as any).delay).toBe(5 * HOUR)
  })
})

// ---------------------------------------------------------------------------
// 3–4. The date moves
// ---------------------------------------------------------------------------

describe('wait_until: the date moves while parked', () => {
  it('moved later: the wake re-parks and the following send does not go out', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-later', { trial_ends_at: at(12 * HOUR) })
    await c.fire({ accountId: 'acct-later' })
    await H.drain()
    expect(ms((await c.run()).nextActionAt)).toBe(t0() + 12 * HOUR)

    facts.set('acct-later', { trial_ends_at: at(20 * HOUR) }) // extended
    advance(12 * HOUR)
    await H.drain()

    const run = await c.run()
    expect(c.sentCount()).toBe(0)
    expect(run.status).toBe('active')
    expect(run.currentStepIndex).toBe(0)
    expect(ms(run.nextActionAt)).toBe(t0() + 20 * HOUR)
    const parked = ofAction(run, 'wait_until_parked')
    expect(parked.map((p) => ms(p.details!.target))).toEqual([t0() + 12 * HOUR, t0() + 20 * HOUR])

    advance(8 * HOUR)
    await H.drain()
    expect(c.sentCount()).toBe(1)
  })

  it('moved earlier: picked up at the next recheck, not before', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-earlier', { trial_ends_at: at(10 * DAY) })
    await c.fire({ accountId: 'acct-earlier' })
    await H.drain()
    expect(ms((await c.run()).nextActionAt)).toBe(t0() + DAY)

    facts.set('acct-earlier', { trial_ends_at: at(12 * HOUR) })
    advance(12 * HOUR)
    await H.drain()
    expect(c.sentCount()).toBe(0) // not due until the recheck

    advance(12 * HOUR)
    await H.drain()
    expect(c.sentCount()).toBe(1)
    expect((await c.run()).status).toBe('completed')
  })

  it('repeated rechecks with an unchanged target add no history but re-read the fact each time', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-steady', { trial_ends_at: at(5 * DAY) })
    await c.fire({ accountId: 'acct-steady' })
    await H.drain()
    const before = facts.resolveCalls.filter((r) => r.subjectId === 'acct-steady').length

    for (let d = 1; d <= 4; d += 1) {
      advance(DAY)
      await H.drain()
      expect(ms((await c.run()).nextActionAt)).toBe(t0() + (d + 1) * DAY)
    }

    const run = await c.run()
    expect(ofAction(run, 'wait_until_parked')).toHaveLength(1)
    expect(facts.resolveCalls.filter((r) => r.subjectId === 'acct-steady').length - before).toBe(4)
    expect(c.sentCount()).toBe(0)

    advance(DAY)
    await H.drain()
    expect(c.sentCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Missing subject or date
// ---------------------------------------------------------------------------

describe('wait_until: ifMissing', () => {
  it('fact null → exit wait_until_missing by default', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-null', { trial_ends_at: null })
    await c.fire({ accountId: 'acct-null' })
    await H.drain()
    const run = await c.run()
    expect(run.status).toBe('exited')
    expect(run.exitReason).toBe('wait_until_missing')
    expect(c.sentCount()).toBe(0)
  })

  it('fact unset or unparseable → exit', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-junk', { trial_ends_at: 'soon' as never })
    await c.fire({ accountId: 'acct-junk' }, 'junk')
    await c.fire({ accountId: 'acct-never-set' }, 'unset')
    await H.drain()
    const runs = await c.runs()
    expect(runs).toHaveLength(2)
    for (const r of runs) expect(r.exitReason).toBe('wait_until_missing')
  })

  it('subject property missing, empty or non-string → exit', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    await c.fire({}, 'none')
    await c.fire({ accountId: '' }, 'empty')
    await c.fire({ accountId: 42 }, 'number')
    await H.drain()
    const runs = await c.runs()
    expect(runs).toHaveLength(3)
    for (const r of runs) expect(r.exitReason).toBe('wait_until_missing')
    expect(c.sentCount()).toBe(0)
  })

  it("ifMissing 'continue' → advances with wait_until_skipped and the reason", async () => {
    freezeAt(T0)
    const c = await newCase((s) => [
      step.waitUntil('trial_ends_at', 'accountId', { ifMissing: 'continue' }),
      step.send(s.tpl),
    ])
    facts.set('acct-cont', { trial_ends_at: null })
    await c.fire({ accountId: 'acct-cont' }, 'fact')
    await c.fire({}, 'subject')
    await H.drain()
    const runs = await c.runs()
    expect(runs).toHaveLength(2)
    const reasons = runs.map((r) => ofAction(r, 'wait_until_skipped')[0]?.details?.reason).sort()
    expect(reasons).toEqual(['fact_missing', 'subject_missing'])
    for (const r of runs) {
      expect(r.status).toBe('completed')
      expect(ofAction(r, 'wait_until_skipped')[0]!.details).toMatchObject({ fact: 'trial_ends_at' })
    }
    expect(c.sentCount()).toBe(2)
  })

  it('a date cleared while parked exits at the next wake', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-cleared', { trial_ends_at: at(3 * DAY) })
    await c.fire({ accountId: 'acct-cleared' })
    await H.drain()
    facts.set('acct-cleared', { trial_ends_at: null })
    advance(DAY)
    await H.drain()
    expect((await c.run()).exitReason).toBe('wait_until_missing')
  })
})

// ---------------------------------------------------------------------------
// 6–7. Several runs; abort; unsubscribe
// ---------------------------------------------------------------------------

describe('wait_until: scoping and ending', () => {
  it('two runs for one contact, different subjects, each follow their own date', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-one', { trial_ends_at: at(4 * HOUR) })
    facts.set('acct-two', { trial_ends_at: at(8 * HOUR) })
    await c.fire({ accountId: 'acct-one' }, 'one')
    await c.fire({ accountId: 'acct-two' }, 'two')
    await H.drain()

    const byAcct = async () =>
      Object.fromEntries((await c.runs()).map((r) => [String(r.triggerEvent?.properties?.accountId), r]))
    let runs = await byAcct()
    expect(ms(runs['acct-one']!.nextActionAt)).toBe(t0() + 4 * HOUR)
    expect(ms(runs['acct-two']!.nextActionAt)).toBe(t0() + 8 * HOUR)

    advance(4 * HOUR)
    await H.drain()
    runs = await byAcct()
    expect(runs['acct-one']!.status).toBe('completed')
    expect(runs['acct-two']!.status).toBe('active')
    expect(c.sentCount()).toBe(1)
  })

  it('abortFlow with matchTriggerProperties stops a parked run; nothing sends later', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-abort', { trial_ends_at: at(2 * DAY) })
    facts.set('acct-keep', { trial_ends_at: at(2 * DAY) })
    await c.fire({ accountId: 'acct-abort' }, 'abort')
    await c.fire({ accountId: 'acct-keep' }, 'keep')
    await H.drain()

    const res = await H.mailer.abortFlow(c.flowSlug, c.externalId, { matchTriggerProperties: { accountId: 'acct-abort' } })
    expect(res.abortedRuns).toBe(1)

    advance(3 * DAY)
    await H.drain()
    await H.drain()
    const runs = await c.runs()
    const aborted = runs.find((r) => r.triggerEvent?.properties?.accountId === 'acct-abort')!
    expect(aborted.status).toBe('exited')
    expect(c.sentCount()).toBe(1) // only acct-keep
  })

  it('a contact who unsubscribes while parked exits at the next wake', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-unsub', { trial_ends_at: at(2 * DAY) })
    await c.fire({ accountId: 'acct-unsub' })
    await H.drain()
    await H.ctx.collections.subscriptions.updateOne({ externalId: c.externalId }, { $set: { status: 'unsubscribed' } })
    advance(DAY)
    await H.drain()
    const run = await c.run()
    expect(run.status).toBe('exited')
    expect(run.exitReason).toBe('unsubscribed')
    expect(c.sentCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Resolver failure
// ---------------------------------------------------------------------------

describe('wait_until: the facts adapter throws', () => {
  it('rejects, writes nothing, leaves the run due; the next pass succeeds', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-flaky', { trial_ends_at: at(3 * DAY) })
    await c.fire({ accountId: 'acct-flaky' })
    await H.drain()
    advance(DAY)

    const before = await c.run()
    vi.spyOn(facts, 'resolve').mockRejectedValueOnce(new Error('host down'))
    // Not drain(): a run whose step throws stays due, so drain would loop to maxRounds.
    await expect(processOneRunStep(before._id!, H.ctx)).rejects.toThrow('host down')

    const after = await c.run()
    expect(after.status).toBe('active')
    expect(after.currentStepIndex).toBe(before.currentStepIndex)
    expect(ms(after.nextActionAt)).toBe(ms(before.nextActionAt))
    expect(after.history).toHaveLength(before.history.length)
    expect(ms(after.nextActionAt)).toBeLessThanOrEqual(Date.now()) // still due

    const result = await H.drain()
    expect(result.settled).toBe(true)
    expect(ms((await c.run()).nextActionAt)).toBe(t0() + 2 * DAY)
  })
})

// ---------------------------------------------------------------------------
// 10. Offsets
// ---------------------------------------------------------------------------

describe('wait_until: offsetDays', () => {
  it.each([
    { offsetDays: -3, targetMs: 7 * DAY },
    { offsetDays: 0, targetMs: 10 * DAY },
    { offsetDays: undefined, targetMs: 10 * DAY },
    { offsetDays: 1.5, targetMs: 11.5 * DAY },
    { offsetDays: 2, targetMs: 12 * DAY },
    { offsetDays: -9.75, targetMs: 6 * HOUR },
  ])('offsetDays $offsetDays → target end + offset', async ({ offsetDays, targetMs }) => {
    freezeAt(T0)
    const c = await newCase((s) => [
      step.waitUntil('trial_ends_at', 'accountId', offsetDays === undefined ? {} : { offsetDays }),
      step.send(s.tpl),
    ])
    const acct = `acct-off-${String(offsetDays)}`
    facts.set(acct, { trial_ends_at: at(10 * DAY) })
    await c.fire({ accountId: acct })
    await H.drain()
    const run = await c.run()
    expect(ms(ofAction(run, 'wait_until_parked')[0]!.details!.target)).toBe(t0() + targetMs)
    expect(ms(run.nextActionAt)).toBe(t0() + Math.min(targetMs, DAY))
  })

  it('a negative offset that lands in the past advances at once', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId', { offsetDays: -3 }), step.send(s.tpl)])
    facts.set('acct-off-past', { trial_ends_at: at(2 * DAY) })
    await c.fire({ accountId: 'acct-off-past' })
    await H.drain()
    expect(c.sentCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Placement, concurrency
// ---------------------------------------------------------------------------

describe('wait_until: placement and concurrency', () => {
  it('works inside a branch', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [
      { type: 'branch', test: { triggerPropertyTruthy: 'accountId' }, ifTrueSteps: [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)], ifFalseSteps: [] },
    ])
    facts.set('acct-branch', { trial_ends_at: at(5 * HOUR) })
    await c.fire({ accountId: 'acct-branch' })
    await H.drain()
    let run = await c.run()
    expect(run.status).toBe('active')
    expect(ms(run.nextActionAt)).toBe(t0() + 5 * HOUR)
    advance(5 * HOUR)
    await H.drain()
    run = await c.run()
    expect(run.status).toBe('completed')
    expect(c.sentCount()).toBe(1)
  })

  it('two workers parking the same run write one history entry', async () => {
    freezeAt(T0)
    const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)])
    facts.set('acct-race', { trial_ends_at: at(2 * DAY) })
    await c.fire({ accountId: 'acct-race' })
    await H.drain()
    facts.set('acct-race', { trial_ends_at: at(3 * DAY) }) // so the wake must log a new target
    advance(DAY)
    const run = await c.run()
    await Promise.all([processOneRunStep(run._id!, H.ctx), processOneRunStep(run._id!, H.ctx)])
    const after = await c.run()
    expect(ofAction(after, 'wait_until_parked')).toHaveLength(2) // initial park + one re-park
    expect(ms(after.nextActionAt)).toBe(t0() + 2 * DAY)
  })
})

// ---------------------------------------------------------------------------
// The trial clock, end to end (plans/19a §7)
// ---------------------------------------------------------------------------

describe('wait_until: the trial clock', () => {
  const trialSteps = (s: { tpl: string; alt: string; n: number }): FlowStep[] => [
    step.send(s.tpl),
    step.waitUntil('trial_ends_at', 'accountId', { offsetDays: -3 }),
    step.send(s.alt),
    step.waitUntil('trial_ends_at', 'accountId'),
    step.fireEvent(`Trial Expired ${s.n}`),
  ]
  const expired = (c: Case) =>
    H.ctx.collections.events.countDocuments({ externalId: c.externalId, name: `Trial Expired ${c.eventName.slice('WaitUntil'.length)}` })

  /** Advance one day at a time to `day`, draining each day. */
  async function walkTo(fromDay: number, toDay: number) {
    for (let d = fromDay + 1; d <= toDay; d += 1) {
      advance(DAY)
      await H.drain()
    }
  }

  it('second email at day 7, event at day 10', async () => {
    freezeAt(T0)
    const c = await newCase(trialSteps)
    facts.set('acct-trial', { trial_ends_at: at(10 * DAY) })
    await c.fire({ accountId: 'acct-trial' })
    await H.drain()
    expect(c.sentCount()).toBe(1)

    await walkTo(0, 6)
    expect(c.sentCount()).toBe(1)
    await walkTo(6, 7)
    expect(c.sentCount()).toBe(2)
    await walkTo(7, 9)
    expect(await expired(c)).toBe(0)
    await walkTo(9, 10)
    expect(await expired(c)).toBe(1)
    expect((await c.run()).status).toBe('completed')
  })

  it('extended to day 30 while parked at the first wait → second email at day 27', async () => {
    freezeAt(T0)
    const c = await newCase(trialSteps)
    facts.set('acct-ext', { trial_ends_at: at(10 * DAY) })
    await c.fire({ accountId: 'acct-ext' })
    await H.drain()
    await walkTo(0, 3)
    facts.set('acct-ext', { trial_ends_at: at(30 * DAY) }) // the only host action

    await walkTo(3, 26)
    expect(c.sentCount()).toBe(1)
    await walkTo(26, 27)
    expect(c.sentCount()).toBe(2)
    await walkTo(27, 29)
    expect(await expired(c)).toBe(0)
    await walkTo(29, 30)
    expect(await expired(c)).toBe(1)
  })

  it('extended after the second email → only the event moves', async () => {
    freezeAt(T0)
    const c = await newCase(trialSteps)
    facts.set('acct-ext2', { trial_ends_at: at(10 * DAY) })
    await c.fire({ accountId: 'acct-ext2' })
    await H.drain()
    await walkTo(0, 8)
    expect(c.sentCount()).toBe(2)
    facts.set('acct-ext2', { trial_ends_at: at(30 * DAY) })

    await walkTo(8, 29)
    expect(await expired(c)).toBe(0)
    expect(c.sentCount()).toBe(2)
    await walkTo(29, 30)
    expect(await expired(c)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Recheck config
// ---------------------------------------------------------------------------

describe('flowWaitUntilRecheckHours', () => {
  it('a configured recheck caps the wake', async () => {
    const f = new MemoryFactsAdapter({ declare: { trial_ends_at: { type: 'date' } } })
    const H6 = await createTestMailer({ config: { factsAdapter: f, flowWaitUntilRecheckHours: 6 } })
    try {
      freezeAt(T0)
      const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)], H6)
      f.set('acct-6h', { trial_ends_at: at(2 * DAY) })
      await c.fire({ accountId: 'acct-6h' })
      await H6.drain()
      expect(ms((await c.run()).nextActionAt)).toBe(t0() + 6 * HOUR)
    } finally {
      restoreClock()
      await H6.stop()
    }
  }, 60_000)

  it.each([0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '24' as unknown as number])(
    'Mailer.init rejects %s',
    async (bad) => {
      const provider = new NullProvider()
      await expect(
        Mailer.init({
          db: H.db,
          adapter: new MemoryContactAdapter([]),
          queue: { driver: 'noop' },
          providers: { [provider.name]: provider },
          defaultProvider: provider.name,
          publicUrl: 'http://localhost:3000',
          unsubscribeSecret: 'test-unsub-secret-32-bytes-or-more-please',
          senderAddress: '1 Test St, Brooklyn NY 11201',
          fromDefaults: { name: 'Test', email: 'test@example.com' },
          workerless: true,
          flowWaitUntilRecheckHours: bad,
        } as never),
      ).rejects.toThrow(/flowWaitUntilRecheckHours/)
    },
  )
})

// ---------------------------------------------------------------------------
// Misconfiguration (19a trap 1): fail the run, never throw-and-retry, never advance
// ---------------------------------------------------------------------------

describe('wait_until: misconfigured steps fail the run', () => {
  it.each([
    { name: 'undeclared fact', s: { type: 'wait_until', fact: 'nope', subjectFrom: 'accountId' }, code: 'fact_not_declared' },
    { name: 'non-date fact', s: { type: 'wait_until', fact: 'plan', subjectFrom: 'accountId' }, code: 'fact_not_date' },
    { name: 'non-string fact', s: { type: 'wait_until', fact: 7, subjectFrom: 'accountId' }, code: 'invalid_fact' },
    { name: 'empty subjectFrom', s: { type: 'wait_until', fact: 'trial_ends_at', subjectFrom: '' }, code: 'invalid_subject_from' },
    { name: 'string offsetDays', s: { type: 'wait_until', fact: 'trial_ends_at', subjectFrom: 'accountId', offsetDays: '-3' }, code: 'invalid_offset_days' },
    { name: 'bad ifMissing', s: { type: 'wait_until', fact: 'trial_ends_at', subjectFrom: 'accountId', ifMissing: 'skip' }, code: 'invalid_if_missing' },
  ])('$name → failed, wait_until_misconfigured: $code', async ({ s, code }) => {
    freezeAt(T0)
    const c = await newCase((x) => [s as unknown as FlowStep, step.send(x.tpl)])
    facts.set('acct-bad', { trial_ends_at: at(DAY), plan: 'pro' })
    await c.fire({ accountId: 'acct-bad' }, `bad-${code}`)
    const result = await H.drain()
    expect(result.settled).toBe(true)
    const run = await c.run()
    expect(run.status).toBe('failed')
    expect(run.exitReason).toBe(`wait_until_misconfigured: ${code}`)
    expect(c.sentCount()).toBe(0)
  })

  it('no facts adapter configured → failed, wait_until_misconfigured: no_facts_adapter', async () => {
    const H0 = await createTestMailer()
    try {
      freezeAt(T0)
      const c = await newCase((s) => [step.waitUntil('trial_ends_at', 'accountId'), step.send(s.tpl)], H0)
      await c.fire({ accountId: 'acct-none' })
      const result = await H0.drain()
      expect(result.settled).toBe(true)
      const run = await c.run()
      expect(run.status).toBe('failed')
      expect(run.exitReason).toBe('wait_until_misconfigured: no_facts_adapter')
      expect(c.sentCount()).toBe(0)
    } finally {
      restoreClock()
      await H0.stop()
    }
  }, 60_000)
})
