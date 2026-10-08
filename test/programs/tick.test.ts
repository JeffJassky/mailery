/**
 * The tick — plans/15-programs.md §5.4. Every `blockedBy` branch, `hold` vs
 * `skip`, prerequisites, cooldown, monotonic completion (INVARIANT 21),
 * silent ticks (INVARIANT 23), completion + onComplete, exit, entry, Facts
 * Changed, and the decision row's shape.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { tickProgram, buildProgram } from '../../src/testing/index.js'
import { FACTS_CHANGED_EVENT, factsHash } from '../../src/server/runner/programs/index.js'
import type { ProgramDecisionDoc } from '../../src/server/models/index.js'
import { advance, DAY, MINUTE, restoreClock } from '../matrix/clock.js'
import {
  activation,
  decisionsFor,
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

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(P.H, activation())
  P.H.mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
  P.H.mailer.registerEvent({ name: 'Upgraded', dedupePolicy: 'once-per-contact' })
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

const slug = 'activation'
const byId = (d: ProgramDecisionDoc, id: string) => d.candidates.find((c) => c.actionId === id)!

describe('choosing', () => {
  it('first tick picks the highest-priority eligible, unsatisfied action at attempt 1', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, slug, subjectId)
    const res = await tickProgram(P.H.ctx, slug, subjectId)

    expect(res).toMatchObject({ status: 'ticked', reason: 'highest-rank', chosen: 'connect-shopify', attempt: 1 })
    const sends = await programSends(P, subjectId)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({
      status: 'queued',
      externalId: owners[0]!.externalId,
      emailAtSend: owners[0]!.email,
      templateSlug: 'connect-shopify-1',
      kind: 'marketing',
      category: 'lifecycle.onboarding',
      program: {
        slug,
        subjectId,
        actionId: 'connect-shopify',
        actionVersion: 1,
        attempt: 1,
        ladder: 1,
        variantId: 'default',
        holdout: false,
      },
    })
  })

  it('writes a decision row listing every candidate with blockedBy and rank', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const runId = await enter(P, slug, subjectId)
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    const d = (await lastDecision(P, slug, subjectId))!

    expect(d._id).toEqual(res.status === 'ticked' ? res.decisionId : null)
    expect(d).toMatchObject({
      runId,
      programSlug: slug,
      programVersion: 1,
      subjectId,
      arm: 'treatment',
      chosen: 'connect-shopify',
      attempt: 1,
      reason: 'highest-rank',
      ranker: { name: 'priority', version: 1 },
      selectionProb: 1,
      explore: false,
      trigger: 'schedule',
    })
    expect(d.candidates.map((c) => c.actionId)).toEqual(['connect-shopify', 'connect-ga4', 'install-agent', 'run-playbook'])
    expect(byId(d, 'connect-shopify')).toMatchObject({ blockedBy: null, rank: 1, eligible: true, satisfied: false, priority: 100, actionVersion: 1 })
    expect(byId(d, 'connect-ga4')).toMatchObject({ blockedBy: null, rank: 2 })
    expect(byId(d, 'install-agent')).toMatchObject({ blockedBy: null, rank: 3 })
    expect(byId(d, 'run-playbook')).toMatchObject({ blockedBy: 'requires:install-agent' })
    expect(byId(d, 'run-playbook').rank).toBeUndefined()
    const sends = await programSends(P, subjectId)
    expect(d.sendIds).toEqual(sends.map((s) => s._id))
    expect(sends[0]!.program!.decisionId).toEqual(d._id)
  })

  it('records the facts snapshot: hash always, inline when small', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const d = (await lastDecision(P, slug, subjectId))!
    const facts = await P.facts.resolve(subjectId)
    expect(d.factsHash).toBe(factsHash(facts))
    expect(d.facts).toEqual(facts)
  })

  it('stores only the hash when the snapshot is 4 KB or more', async () => {
    startClock()
    const { subjectId } = await subject(P, { timezone: 'x'.repeat(5000) })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const d = (await lastDecision(P, slug, subjectId))!
    expect(d.facts).toBeNull()
    expect(d.factsHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('ineligible → blockedBy ineligible, next action chosen', async () => {
    startClock()
    const { subjectId } = await subject(P, { business_type: 'saas' })
    await enter(P, slug, subjectId)
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    expect(res).toMatchObject({ chosen: 'connect-ga4' })
    expect(byId((await lastDecision(P, slug, subjectId))!, 'connect-shopify')).toMatchObject({ blockedBy: 'ineligible', eligible: false })
  })

  it('satisfied → blockedBy satisfied and completedAt set on the run', async () => {
    const t = startClock()
    const { subjectId } = await subject(P, { shopify_connected: true })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    expect(byId((await lastDecision(P, slug, subjectId))!, 'connect-shopify')).toMatchObject({ blockedBy: 'satisfied', satisfied: true })
    const run = await getRun(P, slug, subjectId)
    expect(run!.actions['connect-shopify']).toMatchObject({ status: 'satisfied', completedAt: t })
  })

  it('a satisfied prerequisite unblocks its dependent', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true, ga4_connected: true, agent_connected: true })
    await enter(P, slug, subjectId)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ chosen: 'run-playbook', attempt: 1 })
  })

  it('priority ties break by definition order', async () => {
    startClock()
    await seedProgramWithTemplates(
      P.H,
      buildProgram({
        slug: 'ties',
        actions: [
          { id: 'tie-b', priority: 10, satisfied: { fact: 'ga4_connected' } },
          { id: 'tie-a', priority: 10, satisfied: { fact: 'agent_connected' } },
        ],
      }),
    )
    const { subjectId } = await subject(P)
    await enter(P, 'ties', subjectId)
    expect(await tickProgram(P.H.ctx, 'ties', subjectId)).toMatchObject({ chosen: 'tie-b' })
  })
})

describe('exhaustion: skip, hold, prerequisites, cooldown', () => {
  /** Drive one action's ladder to exhaustion by sending every attempt. */
  async function exhaust(progSlug: string, subjectId: string, attempts: number, gapDays: number) {
    for (let i = 0; i < attempts; i++) {
      await tickProgram(P.H.ctx, progSlug, subjectId)
      await dispatch(P)
      advance(gapDays * DAY + MINUTE)
    }
  }

  it('skip: an exhausted action is blockedBy exhausted and the next one is chosen', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await exhaust(slug, subjectId, 3, 3)
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    expect(res).toMatchObject({ chosen: 'connect-ga4', attempt: 1 })
    expect(byId((await lastDecision(P, slug, subjectId))!, 'connect-shopify')).toMatchObject({ blockedBy: 'exhausted' })
    const run = await getRun(P, slug, subjectId)
    expect(run!.actions['connect-shopify']).toMatchObject({ status: 'exhausted', attempts: 3 })
    expect(run!.actions['connect-shopify']!.exhaustedAt).toBeInstanceOf(Date)
  })

  it('hold: nothing lower-priority sends, but the decision is still logged', async () => {
    startClock()
    const def = activation({ slug: 'hold-prog' })
    def.actions[0] = { ...def.actions[0]!, attempts: def.actions[0]!.attempts.slice(0, 1), onExhaust: 'hold' }
    await seedProgramWithTemplates(P.H, def)
    const { subjectId } = await subject(P, { ga4_connected: true })
    await enter(P, 'hold-prog', subjectId)
    await exhaust('hold-prog', subjectId, 1, 3)

    const before = (await decisionsFor(P, 'hold-prog', subjectId)).length
    const res = await tickProgram(P.H.ctx, 'hold-prog', subjectId)
    expect(res).toMatchObject({ status: 'ticked', reason: 'none-eligible', chosen: null })
    const d = (await lastDecision(P, 'hold-prog', subjectId))!
    expect((await decisionsFor(P, 'hold-prog', subjectId)).length).toBe(before + 1)
    expect(byId(d, 'connect-shopify').blockedBy).toBe('exhausted')
    // Satisfied lower actions still say so; unsatisfied ones are held.
    expect(byId(d, 'connect-ga4').blockedBy).toBe('satisfied')
    expect(byId(d, 'install-agent').blockedBy).toBe('hold')
    expect(byId(d, 'run-playbook').blockedBy).toBe('hold')
    expect((await getRun(P, 'hold-prog', subjectId))!.status).toBe('active')
  })

  it('hold releases once the held action is satisfied', async () => {
    startClock()
    const def = activation({ slug: 'hold-prog-2' })
    def.actions[0] = { ...def.actions[0]!, attempts: def.actions[0]!.attempts.slice(0, 1), onExhaust: 'hold' }
    await seedProgramWithTemplates(P.H, def)
    const { subjectId } = await subject(P)
    await enter(P, 'hold-prog-2', subjectId)
    await exhaust('hold-prog-2', subjectId, 1, 3)
    P.facts.set(subjectId, { shopify_connected: true })
    expect(await tickProgram(P.H.ctx, 'hold-prog-2', subjectId)).toMatchObject({ chosen: 'connect-ga4' })
  })

  it('an exhausted prerequisite still blocks its dependents', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true, ga4_connected: true })
    await enter(P, slug, subjectId)
    await exhaust(slug, subjectId, 2, 3) // install-agent ×2
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    expect(res).toMatchObject({ reason: 'none-eligible', chosen: null })
    const d = (await lastDecision(P, slug, subjectId))!
    expect(byId(d, 'install-agent').blockedBy).toBe('exhausted')
    expect(byId(d, 'run-playbook').blockedBy).toBe('requires:install-agent')
    expect((await getRun(P, slug, subjectId))!.status).toBe('active')
  })

  it('cooldown: blockedBy cooldown until cooldownUntil, then a fresh ladder (ladder 2, attempt 1)', async () => {
    startClock()
    const def = buildProgram({
      slug: 'cool',
      actions: [{ id: 'connect-shopify', priority: 10, attempts: 1, cooldownDays: 14, satisfied: { fact: 'shopify_connected' } }],
    })
    await seedProgramWithTemplates(P.H, def)
    const { subjectId } = await subject(P)
    await enter(P, 'cool', subjectId)
    await tickProgram(P.H.ctx, 'cool', subjectId)
    await dispatch(P)
    advance(3 * DAY + MINUTE)

    const res = await tickProgram(P.H.ctx, 'cool', subjectId)
    expect(res).toMatchObject({ chosen: null, reason: 'none-eligible' })
    expect(byId((await lastDecision(P, 'cool', subjectId))!, 'connect-shopify').blockedBy).toBe('cooldown')
    const run = (await getRun(P, 'cool', subjectId))!
    expect(run.actions['connect-shopify']!.status).toBe('cooldown')
    const until = run.actions['connect-shopify']!.cooldownUntil!
    expect(until.getTime()).toBe(Date.now() + 14 * DAY)
    expect(run.status).toBe('active') // not completed while cooling down

    advance(14 * DAY)
    const reopened = await tickProgram(P.H.ctx, 'cool', subjectId)
    expect(reopened).toMatchObject({ chosen: 'connect-shopify', attempt: 1 })
    const sends = await programSends(P, subjectId)
    expect(sends.at(-1)!.program).toMatchObject({ attempt: 1, ladder: 2 })
    expect(new Set(sends.map((s) => s.dedupeKey)).size).toBe(sends.length)
  })
})

describe('completion and monotonicity', () => {
  it('completedAt is monotonic under fact regression (INVARIANT 21)', async () => {
    const t = startClock()
    const { subjectId } = await subject(P, { shopify_connected: true })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)

    P.facts.set(subjectId, { shopify_connected: false })
    advance(5 * DAY)
    await tickProgram(P.H.ctx, slug, subjectId)
    const run = (await getRun(P, slug, subjectId))!
    expect(run.actions['connect-shopify']).toMatchObject({ status: 'satisfied', completedAt: t })
    expect(byId((await lastDecision(P, slug, subjectId))!, 'connect-shopify')).toMatchObject({ blockedBy: 'satisfied', satisfied: true })
    expect((await programSends(P, subjectId)).some((s) => s.program!.actionId === 'connect-shopify')).toBe(false)
  })

  it('every action satisfied → completed, onComplete fired once with subjectType account', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true, ga4_connected: true, agent_connected: true, playbooks_run: 2 })
    await enter(P, slug, subjectId)
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    expect(res).toMatchObject({ status: 'ticked', reason: 'completed', chosen: null })
    const run = (await getRun(P, slug, subjectId))!
    expect(run.status).toBe('completed')
    expect(run.completedAt).toBeInstanceOf(Date)

    const events = await P.H.mailer.collections.events.find({ name: 'Activated', externalId: subjectId }).toArray()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      properties: { subjectType: 'account', programSlug: slug },
      dedupeKey: `program:${slug}:${subjectId}:complete`,
    })

    expect(await tickProgram(P.H.ctx, slug, subjectId)).toEqual({ status: 'skipped', skipped: 'inactive' })
    expect(await P.H.mailer.collections.events.countDocuments({ name: 'Activated', externalId: subjectId })).toBe(1)
  })

  it('satisfied + exhausted(skip) actions also complete the run', async () => {
    startClock()
    const def = buildProgram({
      slug: 'short',
      exit: { onComplete: { fireEvent: 'Short Done' } },
      actions: [
        { id: 'connect-ga4', priority: 10, attempts: 1, satisfied: { fact: 'ga4_connected' } },
        { id: 'install-agent', priority: 5, attempts: 1, satisfied: { fact: 'agent_connected' } },
      ],
    })
    await seedProgramWithTemplates(P.H, def)
    const { subjectId } = await subject(P, { agent_connected: true })
    await enter(P, 'short', subjectId)
    await tickProgram(P.H.ctx, 'short', subjectId)
    await dispatch(P)
    advance(3 * DAY + MINUTE)
    expect(await tickProgram(P.H.ctx, 'short', subjectId)).toMatchObject({ reason: 'completed' })
  })

  it('ineligible actions keep the run active (silent), they do not complete it', async () => {
    startClock()
    const def = buildProgram({
      slug: 'ecom-only',
      actions: [{ id: 'connect-shopify', priority: 10, eligible: { fact: 'business_type', equals: 'ecommerce' }, satisfied: { fact: 'shopify_connected' } }],
    })
    await seedProgramWithTemplates(P.H, def)
    const { subjectId } = await subject(P, { business_type: 'saas' })
    await enter(P, 'ecom-only', subjectId)
    expect(await tickProgram(P.H.ctx, 'ecom-only', subjectId)).toMatchObject({ reason: 'none-eligible' })
    expect((await getRun(P, 'ecom-only', subjectId))!.status).toBe('active')
  })

  it('a silent tick still writes exactly one decision (INVARIANT 23)', async () => {
    startClock()
    const { subjectId } = await subject(P, { business_type: 'saas', ga4_connected: true, agent_connected: true })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId) // run-playbook chosen
    await dispatch(P)
    advance(MINUTE)
    const before = (await decisionsFor(P, slug, subjectId)).length
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    expect(res.status).toBe('ticked')
    const after = await decisionsFor(P, slug, subjectId)
    expect(after.length).toBe(before + 1)
    expect(after.at(-1)!.sendIds).toEqual([])
  })
})

describe('exit', () => {
  it('an exit event after entry exits the run and cancels its queued sends', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId) // queued, not dispatched
    advance(MINUTE)
    await P.H.mailer.fire('Upgraded', subjectId, { subjectType: 'account' })
    advance(3 * DAY)
    const res = await tickProgram(P.H.ctx, slug, subjectId)
    expect(res).toMatchObject({ reason: 'exited' })
    const run = (await getRun(P, slug, subjectId))!
    expect(run).toMatchObject({ status: 'exited', exitReason: 'event:Upgraded' })
    const sends = await programSends(P, subjectId)
    expect(sends.every((s) => s.status === 'cancelled')).toBe(true)
  })

  it('an exit event from before entry does not exit the run', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await P.H.mailer.fire('Upgraded', subjectId, { subjectType: 'account' })
    advance(MINUTE)
    await enter(P, slug, subjectId)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'highest-rank' })
  })
})

describe('entry, Facts Changed, definitions', () => {
  it('the entry event creates a run and the scheduler ticks it in the same drain', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    advance(MINUTE)
    await P.H.mailer.fire('Created', subjectId, { subjectType: 'account' })
    await P.H.drain()
    const run = await getRun(P, slug, subjectId)
    expect(run).toMatchObject({ status: 'active', arm: 'treatment' })
    const ds = await decisionsFor(P, slug, subjectId)
    expect(ds[0]).toMatchObject({ trigger: 'entry', chosen: 'connect-shopify' })
    expect(P.H.provider.sent.filter((s) => s.to === owners[0]!.email)).toHaveLength(1)
  })

  it('re-firing the entry event does not create a second run', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await P.H.mailer.fire('Created', subjectId, {}, `again-1-${subjectId}`)
    await P.H.drain()
    advance(MINUTE)
    await P.H.mailer.fire('Created', subjectId, {}, `again-2-${subjectId}`)
    await P.H.drain()
    expect(await P.H.mailer.collections.programRuns.countDocuments({ programSlug: slug, subjectId })).toBe(1)
  })

  it('Facts Changed wakes a sleeping run immediately', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    await dispatch(P)
    advance(DAY)
    P.facts.set(subjectId, { shopify_connected: true })
    await P.H.mailer.fire(FACTS_CHANGED_EVENT, subjectId)
    await P.H.drain()
    const d = (await lastDecision(P, slug, subjectId))!
    expect(d.trigger).toBe('facts_changed')
    expect(byId(d, 'connect-shopify').blockedBy).toBe('satisfied')
    expect((await getRun(P, slug, subjectId))!.actions['connect-shopify']!.completedAt).toBeInstanceOf(Date)
  })

  it('a pending action added in a new version is chosen on the next tick', async () => {
    startClock()
    const v1 = buildProgram({ slug: 'grows-2', actions: [{ id: 'connect-ga4', priority: 10, attempts: 3, satisfied: { fact: 'ga4_connected' } }] })
    await seedProgramWithTemplates(P.H, v1)
    const { subjectId } = await subject(P)
    await enter(P, 'grows-2', subjectId)
    await tickProgram(P.H.ctx, 'grows-2', subjectId)
    await dispatch(P)
    const v2 = buildProgram({
      slug: 'grows-2',
      actions: [
        { id: 'install-agent', priority: 20, attempts: 1, satisfied: { fact: 'agent_connected' } },
        { id: 'connect-ga4', priority: 10, attempts: 3, satisfied: { fact: 'ga4_connected' } },
      ],
    })
    for (const s of ['install-agent-1']) {
      if (!(await P.H.mailer.collections.templates.findOne({ slug: s }))) {
        await P.H.seedTemplate({ slug: s, kind: 'marketing', category: 'lifecycle.onboarding' })
      }
    }
    await P.H.mailer.collections.programs.updateOne({ slug: 'grows-2' }, { $set: { definition: v2, version: 2 } })
    advance(3 * DAY + MINUTE)
    expect(await tickProgram(P.H.ctx, 'grows-2', subjectId)).toMatchObject({ chosen: 'install-agent', attempt: 1 })
    const run = (await getRun(P, 'grows-2', subjectId))!
    expect(run.programVersion).toBe(2)
    expect(run.actions['install-agent']).toMatchObject({ status: 'pending', attempts: 0, ladder: 1 })
    expect(run.actions['connect-ga4']).toMatchObject({ attempts: 1 })
  })

  it('a disabled program does not tick', async () => {
    startClock()
    await seedProgramWithTemplates(P.H, activation({ slug: 'off' }), { enabled: true })
    const { subjectId } = await subject(P)
    await enter(P, 'off', subjectId)
    await P.H.mailer.collections.programs.updateOne({ slug: 'off' }, { $set: { enabled: false } })
    expect(await tickProgram(P.H.ctx, 'off', subjectId)).toEqual({ status: 'skipped', skipped: 'disabled' })
    expect(await decisionsFor(P, 'off', subjectId)).toHaveLength(0)
  })

  it('the scheduler never busy-loops: drain settles with the clock frozen', async () => {
    startClock()
    const { subjectId } = await subject(P, { business_type: 'saas', ga4_connected: true, agent_connected: true, playbooks_run: 0 })
    await P.H.mailer.fire('Created', subjectId)
    const res = await P.H.drain({ maxRounds: 20 })
    expect(res.settled).toBe(true)
    const run = (await getRun(P, slug, subjectId))!
    expect(run.nextTickAt.getTime()).toBeGreaterThan(Date.now())
  })
})
