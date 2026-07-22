/**
 * Flow lifecycle matrix — start, every step type, and every way a run ends.
 *
 * Runs against real Mongo through the real state machine
 * (src/server/runner/step.ts). Each case gets its own contact, template, flow
 * and event name so they share one Mongo instance without interfering; the
 * per-recipient send count is what each case asserts on.
 *
 * `steps` is a factory taking the case's own slugs — the fixtures are created
 * before the step list needs them, so a literal array could not name them.
 *
 * The clock is real except where a `wait` is involved — see `clock.ts` for why
 * only `Date` is faked.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/index.js'
import { freezeAt, advance, restoreClock, HOUR, DAY } from './clock.js'
import type { FlowStep, Contact } from '../../src/shared/types.js'
import type { FlowRunDoc, SendDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness
let counter = 0

beforeAll(async () => {
  H = await createTestMailer()
}, 60_000)

afterEach(() => {
  restoreClock()
})

afterAll(async () => {
  restoreClock()
  if (H) await H.stop()
})

/** Slugs handed to the `steps` factory. */
interface CaseSlugs {
  tpl: string
  alt: string
}

interface Case extends CaseSlugs {
  externalId: string
  email: string
  flowSlug: string
  eventName: string
  fire: (properties?: Record<string, unknown>) => Promise<void>
  run: () => Promise<FlowRunDoc | null>
  runs: () => Promise<FlowRunDoc[]>
  sends: () => Promise<SendDoc[]>
  /** How many times the provider was actually called for this contact. */
  sentCount: () => number
}

interface CaseOptions {
  steps: (slugs: CaseSlugs) => FlowStep[]
  once?: boolean
  dedupePolicy?: 'once-per-contact' | 'once-per-day' | 'every-time'
  contact?: Partial<Contact>
  subscribe?: boolean
  /** Skip seeding the primary template — for the missing-template case. */
  skipTemplate?: boolean
  /** Also seed a second template under `alt`. */
  withAltTemplate?: boolean
}

async function newCase(opts: CaseOptions): Promise<Case> {
  const i = ++counter
  const externalId = `u${i}`
  const email = `case${i}@example.com`
  const flowSlug = `flow-${i}`
  const eventName = `Trigger${i}`
  const slugs: CaseSlugs = { tpl: `tpl-${i}`, alt: `tpl-${i}-alt` }

  await H.seedContact(
    { externalId, email, tags: [], fields: { firstName: `Case${i}` }, ...opts.contact },
    { subscribe: opts.subscribe !== false },
  )
  if (!opts.skipTemplate) await H.seedTemplate({ slug: slugs.tpl, subject: `Case ${i}` })
  if (opts.withAltTemplate) await H.seedTemplate({ slug: slugs.alt, subject: `Case ${i} alt` })

  await H.seedFlow({ slug: flowSlug, eventName, once: opts.once ?? true, steps: opts.steps(slugs) })
  H.mailer.registerEvent({ name: eventName, dedupePolicy: opts.dedupePolicy ?? 'every-time' })

  return {
    ...slugs,
    externalId,
    email,
    flowSlug,
    eventName,
    fire: (properties) => H.mailer.fire(eventName, externalId, properties ?? {}),
    run: () => H.ctx.collections.flowRuns.findOne({ flowSlug }),
    runs: () => H.ctx.collections.flowRuns.find({ flowSlug }).toArray(),
    sends: () => H.ctx.collections.sends.find({ externalId }).toArray(),
    sentCount: () => H.provider.toRecipient(email).length,
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

describe('flow start', () => {
  it('an event trigger creates a run and sends', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl)] })
    await c.fire()
    await H.drain()

    const run = await c.run()
    expect(run?.status).toBe('completed')
    expect(run?.triggerEvent?.name).toBe(c.eventName)
    expect(c.sentCount()).toBe(1)
  })

  it('carries the trigger event properties onto the run', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl)] })
    await c.fire({ plan: 'pro', seats: 4 })
    await H.drain()

    expect((await c.run())?.triggerEvent?.properties).toEqual({ plan: 'pro', seats: 4 })
  })

  it('once:true enters at most one run per contact', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl)], once: true })
    await c.fire()
    await H.drain()
    await c.fire()
    await H.drain()

    expect(await c.runs()).toHaveLength(1)
    expect(c.sentCount()).toBe(1)
  })

  it('once:false re-enters on each firing', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl)], once: false })
    await c.fire()
    await H.drain()
    await c.fire()
    await H.drain()

    expect(await c.runs()).toHaveLength(2)
    expect(c.sentCount()).toBe(2)
  })

  it('an unsubscribed contact never enters', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl)], subscribe: false })
    await c.fire()
    await H.drain()

    expect(await c.runs()).toHaveLength(0)
    expect(c.sentCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Step types
// ---------------------------------------------------------------------------

describe('wait step', () => {
  it('parks the run, then resumes once the wait elapses', async () => {
    freezeAt('2026-03-04T12:00:00Z')
    const c = await newCase({ steps: (s) => [step.wait(2, 'days'), step.send(s.tpl)] })
    await c.fire()
    await H.drain()

    const parked = await c.run()
    expect(parked?.status).toBe('active')
    expect(parked?.nextActionAt.toISOString()).toBe(new Date('2026-03-06T12:00:00Z').toISOString())
    expect(parked?.history.some((h) => h.action === 'wait_started')).toBe(true)
    expect(c.sentCount()).toBe(0)

    // One hour short — still parked.
    advance(2 * DAY - HOUR)
    await H.drain()
    expect(c.sentCount()).toBe(0)

    advance(HOUR)
    await H.drain()
    expect(c.sentCount()).toBe(1)
    expect((await c.run())?.status).toBe('completed')
  })
})

describe('condition step', () => {
  it('continues to the next step when the predicate is true', async () => {
    const c = await newCase({
      contact: { tags: ['vip'] },
      steps: (s) => [{ type: 'condition', test: { hasTag: 'vip' }, ifFalse: 'exit' }, step.send(s.tpl)],
    })
    await c.fire()
    await H.drain()

    expect(c.sentCount()).toBe(1)
    expect((await c.run())?.status).toBe('completed')
  })

  it('ifFalse:exit ends the run without sending', async () => {
    const c = await newCase({
      steps: (s) => [{ type: 'condition', test: { hasTag: 'vip' }, ifFalse: 'exit' }, step.send(s.tpl)],
    })
    await c.fire()
    await H.drain()

    const run = await c.run()
    expect(run?.status).toBe('exited')
    expect(run?.exitReason).toBe('condition_false')
    expect(c.sentCount()).toBe(0)
  })

  it('ifFalse:continue skips exactly one step', async () => {
    const c = await newCase({
      withAltTemplate: true,
      steps: (s) => [
        { type: 'condition', test: { hasTag: 'vip' }, ifFalse: 'continue' },
        step.send(s.tpl), // skipped
        step.send(s.alt), // reached
      ],
    })
    await c.fire()
    await H.drain()

    expect((await c.sends()).map((x) => x.templateSlug)).toEqual([c.alt])
    expect(c.sentCount()).toBe(1)
  })
})

describe('branch step', () => {
  it('takes the true arm', async () => {
    const c = await newCase({
      contact: { tags: ['vip'] },
      withAltTemplate: true,
      steps: (s) => [
        {
          type: 'branch',
          test: { hasTag: 'vip' },
          ifTrueSteps: [step.send(s.tpl)],
          ifFalseSteps: [step.send(s.alt)],
        },
      ],
    })
    await c.fire()
    await H.drain()

    expect((await c.sends()).map((x) => x.templateSlug)).toEqual([c.tpl])
    const run = await c.run()
    expect(run?.currentBranchPath.slice(0, 2)).toEqual([0, 'true'])
    expect(run?.status).toBe('completed')
  })

  it('takes the false arm', async () => {
    const c = await newCase({
      withAltTemplate: true,
      steps: (s) => [
        {
          type: 'branch',
          test: { hasTag: 'vip' },
          ifTrueSteps: [step.send(s.tpl)],
          ifFalseSteps: [step.send(s.alt)],
        },
      ],
    })
    await c.fire()
    await H.drain()

    expect((await c.sends()).map((x) => x.templateSlug)).toEqual([c.alt])
    expect((await c.run())?.currentBranchPath.slice(0, 2)).toEqual([0, 'false'])
  })
})

describe('tag step', () => {
  it('adds and removes tags through the adapter', async () => {
    const c = await newCase({
      contact: { tags: ['old'] },
      steps: () => [step.tag(['welcomed', 'active'], ['old'])],
    })
    await c.fire()
    await H.drain()

    const contact = await H.adapter.getById(c.externalId)
    expect(contact?.tags.sort()).toEqual(['active', 'welcomed'])
    expect((await c.run())?.status).toBe('completed')
  })
})

describe('fire_event step', () => {
  it('chains into a second flow', async () => {
    const chainedEvent = `Chained${counter + 1}`
    const first = await newCase({ steps: () => [step.fireEvent(chainedEvent, { via: 'flow' })] })

    const secondFlowSlug = `${first.flowSlug}-second`
    const secondTemplate = `${first.tpl}-second`
    await H.seedTemplate({ slug: secondTemplate, subject: 'Second' })
    await H.seedFlow({
      slug: secondFlowSlug,
      eventName: chainedEvent,
      steps: [step.send(secondTemplate)],
    })

    await first.fire()
    await H.drain()

    const secondRun = await H.ctx.collections.flowRuns.findOne({ flowSlug: secondFlowSlug })
    expect(secondRun, 'the chained event should have started the second flow').not.toBeNull()
    expect(secondRun?.triggerEvent?.properties).toEqual({ via: 'flow' })
    expect(first.sentCount(), "the second flow's send reaches the same contact").toBe(1)
  })
})

describe('exit step', () => {
  it('ends the run with the given reason and skips later steps', async () => {
    const c = await newCase({ steps: (s) => [step.exit('not_eligible'), step.send(s.tpl)] })
    await c.fire()
    await H.drain()

    const run = await c.run()
    expect(run?.status).toBe('exited')
    expect(run?.exitReason).toBe('not_eligible')
    expect(c.sentCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cancellation and mid-flow state changes
// ---------------------------------------------------------------------------

describe('mid-flow contact changes', () => {
  it('unsubscribing mid-flow exits the run before the next send', async () => {
    freezeAt('2026-03-04T12:00:00Z')
    const c = await newCase({
      steps: (s) => [step.send(s.tpl), step.wait(1, 'days'), step.send(s.tpl)],
    })
    await c.fire()
    await H.drain()
    expect(c.sentCount()).toBe(1)

    await H.mailer.unsubscribe(c.email, { scope: 'marketing', source: 'test', reason: 'user_request' })

    advance(DAY + HOUR)
    await H.drain()

    const run = await c.run()
    expect(run?.status).toBe('exited')
    expect(run?.exitReason).toBe('unsubscribed')
    expect(c.sentCount(), 'no second send after unsubscribe').toBe(1)
  })

  it('a contact that vanishes from the adapter exits the run', async () => {
    freezeAt('2026-03-04T12:00:00Z')
    const c = await newCase({ steps: (s) => [step.wait(1, 'days'), step.send(s.tpl)] })
    await c.fire()
    await H.drain()

    H.memoryAdapter!.delete(c.externalId)
    advance(DAY + HOUR)
    await H.drain()

    const run = await c.run()
    expect(run?.status).toBe('exited')
    expect(run?.exitReason).toBe('contact_missing')
    expect(c.sentCount()).toBe(0)
  })

  it('a suppressed address is not mailed, but the flow still advances', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl), step.tag(['reached-end'])] })
    await H.mailer.suppress(c.email, { scope: 'all', reason: 'manual', source: 'test' })

    await c.fire()
    await H.drain()

    const sends = await c.sends()
    expect(sends).toHaveLength(1)
    expect(sends[0]!.status).toBe('suppressed')
    expect(c.sentCount(), 'provider must never be called for a suppressed address').toBe(0)

    const contact = await H.adapter.getById(c.externalId)
    expect(contact?.tags, 'the flow continues past a suppressed send').toContain('reached-end')
    expect((await c.run())?.status).toBe('completed')
  })
})

describe('abortFlow / abortAllFlows', () => {
  it('aborts an active run parked in a wait', async () => {
    freezeAt('2026-03-04T12:00:00Z')
    const c = await newCase({ steps: (s) => [step.wait(3, 'days'), step.send(s.tpl)] })
    await c.fire()
    await H.drain()
    expect((await c.run())?.status).toBe('active')

    const result = await H.mailer.abortFlow(c.flowSlug, c.externalId, { reason: 'upgraded' })
    expect(result.abortedRuns).toBe(1)

    const run = await c.run()
    expect(run?.status).toBe('exited')
    expect(run?.exitReason).toBe('aborted_by_host:upgraded')

    // The wake-up would have fired here; it must find nothing to do.
    advance(4 * DAY)
    await H.drain()
    expect(c.sentCount()).toBe(0)
  })

  it('cancels sends still sitting in the queue', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl), step.wait(1, 'days')] })
    await c.fire()
    await H.drain({ dispatch: false }) // leave the send queued

    expect((await c.sends())[0]!.status).toBe('queued')

    const result = await H.mailer.abortFlow(c.flowSlug, c.externalId)
    expect(result.cancelledSends).toBe(1)
    expect((await c.sends())[0]!.status).toBe('cancelled')
  })

  it('the dispatch-time guard blocks a send that raced the abort', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl), step.wait(1, 'days')] })
    await c.fire()
    await H.drain({ dispatch: false })

    const send = (await c.sends())[0]!
    // Abort, then force the row back to `queued` — simulating a job already in
    // flight when the abort swept the queue.
    await H.mailer.abortFlow(c.flowSlug, c.externalId)
    await H.ctx.collections.sends.updateOne({ _id: send._id }, { $set: { status: 'queued' } })

    await dispatchSend(send._id!, H.ctx)

    expect((await H.ctx.collections.sends.findOne({ _id: send._id }))?.status).toBe('cancelled')
    expect(c.sentCount()).toBe(0)
  })

  it('abortAllFlows stops every flow for the contact', async () => {
    freezeAt('2026-03-04T12:00:00Z')
    const c = await newCase({ steps: (s) => [step.wait(3, 'days'), step.send(s.tpl)] })
    const otherFlowSlug = `${c.flowSlug}-other`
    const otherEvent = `Other${counter}`
    await H.seedFlow({
      slug: otherFlowSlug,
      eventName: otherEvent,
      steps: [step.wait(3, 'days'), step.send(c.tpl)],
    })
    H.mailer.registerEvent({ name: otherEvent, dedupePolicy: 'every-time' })

    await c.fire()
    await H.mailer.fire(otherEvent, c.externalId)
    await H.drain()

    const result = await H.mailer.abortAllFlows(c.externalId, { reason: 'churned' })
    expect(result.abortedRuns).toBe(2)

    const active = await H.ctx.collections.flowRuns.countDocuments({
      externalId: c.externalId,
      status: 'active',
    })
    expect(active).toBe(0)
  })

  it('is a no-op when nothing is active', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl)] })
    await c.fire()
    await H.drain()

    expect(await H.mailer.abortFlow(c.flowSlug, c.externalId)).toEqual({
      abortedRuns: 0,
      cancelledSends: 0,
    })
  })

  it('rejects an unknown flow slug', async () => {
    await expect(H.mailer.abortFlow('no-such-flow', 'u1')).rejects.toThrow(/unknown flow slug/)
  })
})

// ---------------------------------------------------------------------------
// Failure modes and idempotency
// ---------------------------------------------------------------------------

describe('failure modes', () => {
  it('a missing template fails the run', async () => {
    const c = await newCase({ skipTemplate: true, steps: () => [step.send('does-not-exist')] })
    await c.fire()
    await H.drain()

    const run = await c.run()
    expect(run?.status).toBe('failed')
    expect(run?.exitReason).toContain('template not found')
    expect(c.sentCount()).toBe(0)
  })
})

describe('idempotency', () => {
  it('re-dispatching an already-sent send does not duplicate', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl)] })
    await c.fire()
    await H.drain()
    expect(c.sentCount()).toBe(1)

    const send = (await c.sends())[0]!
    expect(send.status).toBe('sent')
    await dispatchSend(send._id!, H.ctx)
    expect(c.sentCount()).toBe(1)
  })

  it('two drains over the same run produce exactly one send row', async () => {
    const c = await newCase({ steps: (s) => [step.send(s.tpl)] })
    await c.fire()
    await H.drain()
    await H.drain()

    expect(await c.sends()).toHaveLength(1)
    expect(c.sentCount()).toBe(1)
  })
})
