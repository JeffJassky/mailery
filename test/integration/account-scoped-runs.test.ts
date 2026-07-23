/**
 * Per-scope (e.g. per-account) flow runs for a single contact.
 *
 * A host whose subject is an ACCOUNT but whose contact is a USER needs one
 * series per account for the same person. That requires three things to line
 * up, and this suite pins all three:
 *
 *   1. an explicit, scope-qualified dedupeKey on fire() so the second
 *      account's event isn't swallowed as a duplicate,
 *   2. `once: false` on the trigger so a second run may be created — the
 *      unique (flowId, triggerDedupeKey) index still keeps it to one run per
 *      event, so re-scans stay idempotent,
 *   3. `matchTriggerProperties` on abortFlow so ending one account's series
 *      leaves the same contact's other accounts running.
 *
 * Plus the handoff case: a fire_event step inherits the triggering event's
 * properties, so the downstream flow knows which account it is about.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { runTick } from '../../src/server/runner/index.js'

let H: TestMailerHarness

const ACCT_A = 'acct-aaa'
const ACCT_B = 'acct-bbb'

beforeAll(async () => {
  H = await createTestMailer()
  const { mailer } = H
  await H.seedContact({ externalId: 'u1', email: 'multi@example.com', tags: [], fields: { firstName: 'Multi' } })
  await H.seedContact({ externalId: 'u2', email: 'handoff@example.com', tags: [], fields: { firstName: 'Hand' } })
  await H.seedTemplate({ slug: 'acct-tpl', subject: 'Hi', text: 'Hi {{contact.fields.firstName}}' })

  // Handoff source: no wait, so a single drain reaches the fire_event step.
  await H.seedFlow({
    slug: 'handoff-src',
    eventName: 'Handoff Started',
    once: false,
    steps: [step.fireEvent('Trial Expired')],
  })

  // Gate driven by the trigger event rather than a contact tag: the optional
  // send is skipped when the property is falsy.
  await H.seedFlow({
    slug: 'gated',
    eventName: 'Gate Started',
    once: false,
    steps: [
      { type: 'condition', test: { triggerPropertyTruthy: 'isPremium' }, ifFalse: 'continue' } as never,
      step.send('acct-tpl'),
      step.send('acct-tpl'),
    ],
  })

  await H.seedFlow({
    slug: 'trial-onboarding',
    eventName: 'Trial Started',
    once: false,
    steps: [step.send('acct-tpl'), step.wait(1, 'days'), step.fireEvent('Trial Expired')],
  })
  await H.seedFlow({
    slug: 'trial-winback',
    eventName: 'Trial Expired',
    once: false,
    steps: [step.send('acct-tpl')],
  })

  mailer.registerEvent({ name: 'Trial Started', dedupePolicy: 'once-per-contact' })
  mailer.registerEvent({ name: 'Trial Expired', dedupePolicy: 'once-per-contact' })
  mailer.registerEvent({ name: 'Handoff Started', dedupePolicy: 'once-per-contact' })
  mailer.registerEvent({ name: 'Gate Started', dedupePolicy: 'once-per-contact' })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

/** Mirrors the host's key: contact + event + the scope the event is about. */
const trialKey = (externalId: string, accountId: string) =>
  `${externalId}:Trial Started:${accountId}`

describe('per-account runs for one contact', () => {
  it('creates an independent run per account, and abort scopes to one account', async () => {
    const { mailer } = H
    const ctx = mailer.getRunnerContext()

    await mailer.fire('Trial Started', 'u1', { accountId: ACCT_A }, trialKey('u1', ACCT_A))
    await mailer.fire('Trial Started', 'u1', { accountId: ACCT_B }, trialKey('u1', ACCT_B))

    // Both survive insert: the scope-qualified key keeps them distinct where a
    // once-per-contact key would have collapsed them into one.
    expect(await mailer.collections.events.countDocuments({ name: 'Trial Started' })).toBe(2)

    await runTick(ctx)

    const runs = await mailer.collections.flowRuns
      .find({ externalId: 'u1', flowSlug: 'trial-onboarding' })
      .toArray()
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.triggerEvent?.properties?.accountId).sort()).toEqual([ACCT_A, ACCT_B])

    // Re-scanning must not manufacture duplicates (unique triggerDedupeKey).
    await runTick(ctx)
    expect(
      await mailer.collections.flowRuns.countDocuments({ externalId: 'u1', flowSlug: 'trial-onboarding' }),
    ).toBe(2)

    // Abort ONLY account A.
    const res = await mailer.abortFlow('trial-onboarding', 'u1', {
      reason: 'upgraded',
      matchTriggerProperties: { accountId: ACCT_A },
    })
    expect(res.abortedRuns).toBe(1)

    const after = await mailer.collections.flowRuns
      .find({ externalId: 'u1', flowSlug: 'trial-onboarding' })
      .toArray()
    const byAccount = Object.fromEntries(
      after.map((r) => [String(r.triggerEvent?.properties?.accountId), r.status]),
    )
    expect(byAccount[ACCT_A]).not.toBe('active')
    expect(byAccount[ACCT_B]).toBe('active')
  })

  it('rejects operator-shaped match values instead of aborting everything', async () => {
    const { mailer } = H
    // `{ $ne: null }` would reach Mongo as an operator and match every scoped
    // run — a one-account abort silently becoming abort-all.
    await expect(
      mailer.abortFlow('trial-onboarding', 'u1', {
        matchTriggerProperties: { accountId: { $ne: null } as never },
      }),
    ).rejects.toThrow()
    // `$`-prefixed and dotted keys are rejected for the same reason.
    await expect(
      mailer.abortFlow('trial-onboarding', 'u1', {
        matchTriggerProperties: { $where: 'true' } as never,
      }),
    ).rejects.toThrow()
    await expect(
      mailer.abortFlow('trial-onboarding', 'u1', {
        matchTriggerProperties: { 'a.b': 'c' } as never,
      }),
    ).rejects.toThrow()
  })

  it('an unscoped abort still ends every run for the contact', async () => {
    const { mailer } = H
    const res = await mailer.abortFlow('trial-onboarding', 'u1', { reason: 'churned' })
    expect(res.abortedRuns).toBe(1) // account B — A was already aborted above

    const stillActive = await mailer.collections.flowRuns.countDocuments({
      externalId: 'u1',
      flowSlug: 'trial-onboarding',
      status: 'active',
    })
    expect(stillActive).toBe(0)
  })
})

describe('trigger-property gate', () => {
  it('branches per run, so concurrent runs for one contact can disagree', async () => {
    const { mailer } = H
    await H.seedContact({ externalId: 'u3', email: 'gate@example.com', tags: [], fields: { firstName: 'Gate' } })

    // Same contact, same flow, two scopes — one gated on, one gated off. A
    // contact-level tag could not express this: the second fire would
    // overwrite the first and both runs would read the same value.
    await mailer.fire('Gate Started', 'u3', { accountId: ACCT_A, isPremium: true }, `u3:Gate Started:${ACCT_A}`)
    await mailer.fire('Gate Started', 'u3', { accountId: ACCT_B, isPremium: false }, `u3:Gate Started:${ACCT_B}`)
    await H.drain()

    const runs = await mailer.collections.flowRuns.find({ externalId: 'u3', flowSlug: 'gated' }).toArray()
    expect(runs).toHaveLength(2)

    const sendsFor = async (accountId: string) => {
      const run = runs.find((r) => r.triggerEvent?.properties?.accountId === accountId)
      return mailer.collections.sends.countDocuments({ flowRunId: run!._id })
    }
    expect(await sendsFor(ACCT_A)).toBe(2) // gate true → both sends
    expect(await sendsFor(ACCT_B)).toBe(1) // gate false → first send skipped
  })
})

describe('fire_event handoff', () => {
  it("inherits the triggering event's properties so the next flow knows its scope", async () => {
    const { mailer } = H

    await mailer.fire('Handoff Started', 'u2', { accountId: ACCT_A }, `u2:Handoff Started:${ACCT_A}`)
    await H.drain()

    const fired = await mailer.collections.events.findOne({ externalId: 'u2', name: 'Trial Expired' })
    expect(fired).not.toBeNull()
    // Not authored on the step — carried over from the run's trigger event.
    expect(fired?.properties?.accountId).toBe(ACCT_A)

    const winback = await mailer.collections.flowRuns.findOne({
      externalId: 'u2',
      flowSlug: 'trial-winback',
    })
    expect(winback?.triggerEvent?.properties?.accountId).toBe(ACCT_A)
  })
})
