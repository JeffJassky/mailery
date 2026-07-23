/**
 * A parked run must not be advanced early, no matter who calls the runner.
 *
 * The schedule used to be enforced only by the two callers — the sweep's
 * `nextActionAt <= now` filter and the advance job's delay — which leaves a
 * time-of-check/time-of-use gap: the sweep selects a run while it is due, the
 * run's own advance job parks it on a wait in between, and the sweep then
 * processes the step AFTER the wait. A freshly triggered run is inserted with
 * `nextActionAt = now`, and `runTick` runs the trigger scan and the sweep back
 * to back, so a flow whose FIRST step is a wait could lose that wait entirely.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { processOneRunStep, runTick } from '../../src/server/runner/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer()
  const { mailer } = H
  await H.seedContact({ externalId: 'w1', email: 'wait@example.com', tags: [], fields: {} })
  await H.seedTemplate({ slug: 'wait-tpl', subject: 'S', text: 'B' })
  // First step is a wait — the shape that could lose it.
  await H.seedFlow({
    slug: 'wait-first',
    eventName: 'Wait Started',
    steps: [step.wait(4, 'days'), step.send('wait-tpl')],
  })
  mailer.registerEvent({ name: 'Wait Started', dedupePolicy: 'once-per-contact' })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('parked runs', () => {
  it('does not process the next step while the run is parked in the future', async () => {
    const { mailer } = H
    const ctx = mailer.getRunnerContext()

    await mailer.fire('Wait Started', 'w1')
    await runTick(ctx) // trigger scan creates the run; sweep runs in the same tick

    const run = await mailer.collections.flowRuns.findOne({ externalId: 'w1', flowSlug: 'wait-first' })
    expect(run).not.toBeNull()
    // Parked ~4 days out, pointer past the wait.
    expect(run!.currentStepIndex).toBe(1)
    expect(run!.nextActionAt.getTime()).toBeGreaterThan(Date.now() + 3 * 86_400_000)

    // An extra invocation — a stray sweep, a duplicated job — must be a no-op.
    await processOneRunStep(run!._id!, ctx)
    await runTick(ctx)

    const after = await mailer.collections.flowRuns.findOne({ _id: run!._id })
    expect(after!.currentStepIndex).toBe(1) // still parked, wait intact
    expect(await mailer.collections.sends.countDocuments({ flowRunId: run!._id })).toBe(0)
  })

  it('processes the step once the park time has passed', async () => {
    const { mailer } = H
    const ctx = mailer.getRunnerContext()
    const run = await mailer.collections.flowRuns.findOne({ externalId: 'w1', flowSlug: 'wait-first' })

    await mailer.collections.flowRuns.updateOne(
      { _id: run!._id },
      { $set: { nextActionAt: new Date(Date.now() - 1000) } },
    )
    await runTick(ctx)

    expect(await mailer.collections.sends.countDocuments({ flowRunId: run!._id })).toBe(1)
  })
})
