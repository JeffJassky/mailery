/**
 * abortFlow / abortAllFlows integration tests.
 *
 * Covers: exiting active runs (including runs parked in a wait), cancelling
 * queued sends so aborted flows produce no further mail, the dispatch-time
 * aborted-run guard, no-op on nothing-active, and unknown-slug rejection.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { processOneRunStep, runTick, dispatchSend } from '../../src/server/runner/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer()
  const { mailer } = H
  await H.seedContact({ externalId: 'u1', email: 'alice@example.com', tags: [], fields: { firstName: 'Alice' } })
  await H.seedContact({ externalId: 'u2', email: 'bob@example.com', tags: [], fields: { firstName: 'Bob' } })
  await H.seedTemplate({ slug: 'abort-tpl', subject: 'Hello', text: 'Hello {{contact.fields.firstName}}' })
  await H.seedFlow({
    slug: 'trial-onboarding',
    eventName: 'Trial Started',
    steps: [step.send('abort-tpl'), step.wait(1, 'days'), step.send('abort-tpl')],
  })
  await H.seedFlow({
    slug: 'trial-winback',
    eventName: 'Trial Expired',
    steps: [step.wait(1, 'days'), step.send('abort-tpl')],
  })
  mailer.registerEvent({ name: 'Trial Started', dedupePolicy: 'once-per-contact' })
  mailer.registerEvent({ name: 'Trial Expired', dedupePolicy: 'once-per-contact' })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('abortFlow', () => {
  it('exits a run parked in wait and cancels its queued send', async () => {
    const { mailer } = H
    const ctx = mailer.getRunnerContext()

    await mailer.fire('Trial Started', 'u1')
    await runTick(ctx)

    const run = await mailer.collections.flowRuns.findOne({ externalId: 'u1', flowSlug: 'trial-onboarding' })
    expect(run).not.toBeNull()
    if (!run) return

    // The tick's recovery sweep already processed step 0 (send queued, pointer
    // at 1). One more step processes the wait, parking the run.
    expect(run.currentStepIndex).toBe(1)
    await processOneRunStep(run._id!, ctx)

    const parked = await mailer.collections.flowRuns.findOne({ _id: run._id })
    expect(parked?.status).toBe('active')
    expect(parked?.currentStepIndex).toBe(2)

    const send = await mailer.collections.sends.findOne({ flowRunId: run._id })
    expect(send?.status).toBe('queued')

    const result = await mailer.abortFlow('trial-onboarding', 'u1', { reason: 'upgraded' })
    expect(result).toEqual({ abortedRuns: 1, cancelledSends: 1 })

    const aborted = await mailer.collections.flowRuns.findOne({ _id: run._id })
    expect(aborted?.status).toBe('exited')
    expect(aborted?.exitReason).toBe('aborted_by_host:upgraded')

    const cancelledSend = await mailer.collections.sends.findOne({ flowRunId: run._id })
    expect(cancelledSend?.status).toBe('cancelled')

    // The wait's delayed wake-up finds the run exited and no-ops.
    await processOneRunStep(run._id!, ctx)
    const after = await mailer.collections.flowRuns.findOne({ _id: run._id })
    expect(after?.status).toBe('exited')
    expect(after?.currentStepIndex).toBe(2)

    // Dispatching the cancelled send sends nothing.
    const sentBefore = H.provider.sent.length
    await dispatchSend(cancelledSend!._id!, ctx)
    expect(H.provider.sent.length).toBe(sentBefore)

    // Audit row written.
    const audit = await mailer.collections.auditLog.findOne({ action: 'flow.abort' })
    expect(audit?.diffSummary).toContain('externalId=u1')
  }, 60_000)

  it('dispatch-time guard cancels a queued send whose run was aborted', async () => {
    const { mailer } = H
    const ctx = mailer.getRunnerContext()

    // Simulate the race: send re-queued after the abort's cancellation sweep.
    const send = await mailer.collections.sends.findOne({ externalId: 'u1', status: 'cancelled' })
    expect(send).not.toBeNull()
    if (!send) return
    await mailer.collections.sends.updateOne({ _id: send._id }, { $set: { status: 'queued' } })

    const sentBefore = H.provider.sent.length
    await dispatchSend(send._id!, ctx)
    expect(H.provider.sent.length).toBe(sentBefore)

    const after = await mailer.collections.sends.findOne({ _id: send._id })
    expect(after?.status).toBe('cancelled')
    expect(after?.errorMessage).toContain('aborted_by_host')
  })

  it('is a no-op when the contact has no active runs', async () => {
    const result = await H.mailer.abortFlow('trial-onboarding', 'u1', { reason: 'upgraded' })
    expect(result).toEqual({ abortedRuns: 0, cancelledSends: 0 })
  })

  it('rejects an unknown flow slug', async () => {
    await expect(H.mailer.abortFlow('no-such-flow', 'u1')).rejects.toThrow(/unknown flow slug/)
  })
})

describe('abortAllFlows', () => {
  it('exits active runs across all flows for the contact', async () => {
    const { mailer } = H
    const ctx = mailer.getRunnerContext()

    await mailer.fire('Trial Started', 'u2')
    await mailer.fire('Trial Expired', 'u2')
    await runTick(ctx)

    const active = await mailer.collections.flowRuns.countDocuments({ externalId: 'u2', status: 'active' })
    expect(active).toBe(2)

    const result = await mailer.abortAllFlows('u2', { reason: 'account-deleted' })
    expect(result.abortedRuns).toBe(2)

    const remaining = await mailer.collections.flowRuns.countDocuments({ externalId: 'u2', status: 'active' })
    expect(remaining).toBe(0)

    const reasons = await mailer.collections.flowRuns
      .find({ externalId: 'u2' })
      .map((r) => r.exitReason)
      .toArray()
    expect(reasons).toEqual(['aborted_by_host:account-deleted', 'aborted_by_host:account-deleted'])
  }, 60_000)
})
