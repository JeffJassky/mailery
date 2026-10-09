/**
 * Concurrency — two workers ticking the same run must produce one send and
 * one decision; a crashed worker's lease expires; onComplete fires once.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { buildProgram } from '../../src/testing/index.js'
import { runProgramScheduler, tickProgramRun } from '../../src/server/runner/programs/index.js'
import { advance, MINUTE, restoreClock } from '../matrix/clock.js'
import {
  activation,
  decisionsFor,
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
  P = await programHarness({ programs: { leaseMs: 60_000 } })
  await seedProgramWithTemplates(P.H, activation())
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

describe('lease', () => {
  it('two concurrent ticks of one run → one ticked, one skipped, one send, one decision', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const runId = await enter(P, slug, subjectId)
    const results = await Promise.all([
      tickProgramRun(P.H.ctx, runId, { worker: 'w1' }),
      tickProgramRun(P.H.ctx, runId, { worker: 'w2' }),
    ])
    expect(results.filter((r) => r.status === 'ticked')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'skipped')).toEqual([{ status: 'skipped', skipped: 'leased' }])
    expect(await programSends(P, subjectId)).toHaveLength(1)
    expect(await decisionsFor(P, slug, subjectId)).toHaveLength(1)
  })

  it('the lease is released after a tick', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const runId = await enter(P, slug, subjectId)
    await tickProgramRun(P.H.ctx, runId, { worker: 'w1' })
    expect((await getRun(P, slug, subjectId))!.lease).toBeNull()
  })

  it('a live lease held by another worker → skipped', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const runId = await enter(P, slug, subjectId)
    await P.H.mailer.collections.programRuns.updateOne(
      { _id: runId },
      { $set: { lease: { until: new Date(Date.now() + 30_000), worker: 'other' } } },
    )
    expect(await tickProgramRun(P.H.ctx, runId, { worker: 'w1' })).toEqual({ status: 'skipped', skipped: 'leased' })
  })

  it('a stale lease (crashed worker) is taken over', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const runId = await enter(P, slug, subjectId)
    await P.H.mailer.collections.programRuns.updateOne(
      { _id: runId },
      { $set: { lease: { until: new Date(Date.now() - 1), worker: 'dead' } } },
    )
    expect(await tickProgramRun(P.H.ctx, runId, { worker: 'w1' })).toMatchObject({ status: 'ticked' })
  })

  it('the lease is released when the facts adapter throws, and the error propagates', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const runId = await enter(P, slug, subjectId)
    const original = P.facts.resolve.bind(P.facts)
    P.facts.resolve = async () => { throw new Error('host db down') }
    try {
      await expect(tickProgramRun(P.H.ctx, runId, { worker: 'w1' })).rejects.toThrow('host db down')
    } finally {
      P.facts.resolve = original
    }
    expect((await getRun(P, slug, subjectId))!.lease).toBeNull()
    expect(await programSends(P, subjectId)).toHaveLength(0)
  })

  it('onComplete fires exactly once under concurrent ticks', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true, ga4_connected: true, agent_connected: true, playbooks_run: 1 })
    const runId = await enter(P, slug, subjectId)
    await Promise.all([1, 2, 3, 4].map((i) => tickProgramRun(P.H.ctx, runId, { worker: `w${i}` })))
    advance(MINUTE)
    await Promise.all([1, 2].map((i) => tickProgramRun(P.H.ctx, runId, { worker: `w${i}` })))
    expect(await P.H.mailer.collections.events.countDocuments({ name: 'Activated', externalId: subjectId })).toBe(1)
  })

  it('two scheduler passes in parallel send once per due run', async () => {
    startClock()
    await seedProgramWithTemplates(P.H, buildProgram({ slug: 'par', actions: [{ id: 'connect-ga4', priority: 1, satisfied: { fact: 'ga4_connected' } }] }))
    const subjects = await Promise.all([1, 2, 3].map(() => subject(P)))
    for (const s of subjects) await enter(P, 'par', s.subjectId)
    await Promise.all([runProgramScheduler(P.H.ctx), runProgramScheduler(P.H.ctx)])
    for (const s of subjects) {
      const sends = (await programSends(P, s.subjectId)).filter((x) => x.program!.slug === 'par')
      expect(sends).toHaveLength(1)
    }
  })
})
