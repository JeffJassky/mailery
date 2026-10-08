/**
 * Blackout dates — plans/17-cadence-controls.md F5.
 *
 * `contactPolicy.marketing.blackoutDates`: inclusive local calendar ranges
 * with no marketing sends. A send landing inside one is deferred to the local
 * midnight after the range (then quiet hours), reason 'blackout'; that deferral
 * never expires. Programs check the same ranges in the tick (`programSendTime`)
 * so the board shows the true next send. Transactional mail is untouched.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ObjectId } from 'mongodb'

import { blackoutEnd, decideContactPolicy, type ContactPolicyInput } from '../../src/server/runner/contact-policy.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { assertValidContactPolicy } from '../../src/server/config.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import type { ContactPolicy } from '../../src/shared/types.js'
import { advance, DAY, freezeAt, HOUR, restoreClock } from '../matrix/clock.js'
import { activation, delivered, enter, getRun, lastDecision, programHarness, seedProgramWithTemplates, subject, type ProgramHarness } from '../programs/helpers.js'
import { tickProgram } from '../../src/testing/index.js'

const d = (iso: string) => new Date(iso)

// ---------------------------------------------------------------------------
// Pure: blackoutEnd
// ---------------------------------------------------------------------------

describe('blackoutEnd', () => {
  const THANKSGIVING = [{ from: '2026-11-26', to: '2026-11-27' }]

  it('inside a range → the local midnight after it (recipient zone)', () => {
    expect(blackoutEnd(d('2026-11-26T15:00:00Z'), THANKSGIVING, 'America/New_York')).toEqual(d('2026-11-28T05:00:00Z'))
    expect(blackoutEnd(d('2026-11-28T04:59:00Z'), THANKSGIVING, 'America/New_York')).toEqual(d('2026-11-28T05:00:00Z')) // 23:59 EST on the 27th
    expect(blackoutEnd(d('2026-11-26T00:00:00Z'), THANKSGIVING, 'UTC')).toEqual(d('2026-11-28T00:00:00Z'))
  })
  it('outside → null (before, and from the first instant after)', () => {
    expect(blackoutEnd(d('2026-11-26T04:59:00Z'), THANKSGIVING, 'America/New_York')).toBeNull() // 23:59 EST on the 25th
    expect(blackoutEnd(d('2026-11-28T05:00:00Z'), THANKSGIVING, 'America/New_York')).toBeNull()
    expect(blackoutEnd(d('2026-11-26T04:59:00Z'), THANKSGIVING, 'UTC')).toEqual(d('2026-11-28T00:00:00Z')) // same instant, UTC date is the 26th
  })
  it('a single day', () => {
    expect(blackoutEnd(d('2026-12-25T12:00:00Z'), [{ from: '2026-12-25', to: '2026-12-25' }], 'UTC')).toEqual(d('2026-12-26T00:00:00Z'))
  })
  it('consecutive or overlapping ranges are one blackout, whatever their order', () => {
    const ranges = [{ from: '2026-11-28', to: '2026-11-28' }, ...THANKSGIVING, { from: '2026-11-27', to: '2026-11-29' }]
    expect(blackoutEnd(d('2026-11-26T15:00:00Z'), ranges, 'UTC')).toEqual(d('2026-11-30T00:00:00Z'))
    expect(blackoutEnd(d('2026-11-26T15:00:00Z'), [...THANKSGIVING, { from: '2026-11-30', to: '2026-11-30' }], 'UTC')).toEqual(d('2026-11-28T00:00:00Z'))
  })
  it('the end is midnight in the zone, across a DST change', () => {
    // Clocks fall back on 2026-11-01 in New York: midnight after the range is EST (UTC−5).
    expect(blackoutEnd(d('2026-10-31T12:00:00Z'), [{ from: '2026-10-31', to: '2026-11-01' }], 'America/New_York')).toEqual(d('2026-11-02T05:00:00Z'))
  })
  it('no ranges → null', () => {
    expect(blackoutEnd(d('2026-11-26T15:00:00Z'), undefined, 'UTC')).toBeNull()
    expect(blackoutEnd(d('2026-11-26T15:00:00Z'), [], 'UTC')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure: decideContactPolicy
// ---------------------------------------------------------------------------

describe('decideContactPolicy — blackout', () => {
  const NOW = d('2026-03-10T12:00:00Z') // Tuesday
  const at = (ms: number) => new Date(NOW.getTime() + ms)
  const RANGE = [{ from: '2026-03-10', to: '2026-03-12' }]
  const only = (marketing: NonNullable<ContactPolicy['marketing']>): ContactPolicy => ({ marketing })
  const input = (over: Partial<ContactPolicyInput> = {}): ContactPolicyInput => ({
    policy: only({ blackoutDates: RANGE }),
    now: NOW,
    kind: 'marketing',
    origin: 'flow',
    queuedAt: over.now ?? NOW,
    timezone: 'UTC',
    history: [],
    pending: [],
    ...over,
  })

  it('inside a blackout → defer to the midnight after it, reason blackout', () => {
    expect(decideContactPolicy(input())).toEqual({ action: 'defer', notBefore: d('2026-03-13T00:00:00Z'), reason: 'blackout' })
  })
  it('outside → send; transactional → send', () => {
    expect(decideContactPolicy(input({ now: d('2026-03-13T00:00:00Z') }))).toEqual({ action: 'send' })
    expect(decideContactPolicy(input({ now: d('2026-03-09T23:59:00Z') }))).toEqual({ action: 'send' })
    expect(decideContactPolicy(input({ kind: 'transactional' }))).toEqual({ action: 'send' })
  })
  it('quiet hours are re-applied after the blackout; the reason stays blackout', () => {
    const p = only({ blackoutDates: RANGE, quietHours: { start: '21:00', end: '08:00' } })
    expect(decideContactPolicy(input({ policy: p }))).toEqual({ action: 'defer', notBefore: d('2026-03-13T08:00:00Z'), reason: 'blackout' })
  })
  it('a blackout never drops, however long it is', () => {
    const p = only({ blackoutDates: [{ from: '2026-03-10', to: '2026-03-25' }], deferral: { maxHours: 72 } })
    expect(decideContactPolicy(input({ policy: p }))).toEqual({ action: 'defer', notBefore: d('2026-03-26T00:00:00Z'), reason: 'blackout' })
  })
  it('expiry is still judged on the pre-blackout time', () => {
    const p = only({ blackoutDates: RANGE, minGapHours: 20, deferral: { maxHours: 72 } })
    const out = decideContactPolicy(input({ policy: p, queuedAt: at(-70 * HOUR), history: [at(-15 * HOUR)] }))
    expect(out).toEqual({ action: 'drop', reason: 'min_gap', wouldBe: at(5 * HOUR) })
  })
  it('a gap that lands inside a blackout is pushed past it', () => {
    const p = only({ blackoutDates: [{ from: '2026-03-11', to: '2026-03-11' }], minGapHours: 20 })
    expect(decideContactPolicy(input({ policy: p, history: [at(-8 * HOUR)] }))).toEqual({
      action: 'defer',
      notBefore: d('2026-03-12T00:00:00Z'),
      reason: 'blackout',
    })
  })
  it('is evaluated in the recipient zone', () => {
    // 03:00Z on 13 Mar = 23:00 EDT on 12 Mar, still inside; midnight after = 04:00Z.
    expect(decideContactPolicy(input({ now: d('2026-03-13T03:00:00Z'), timezone: 'America/New_York' }))).toEqual({
      action: 'defer',
      notBefore: d('2026-03-13T04:00:00Z'),
      reason: 'blackout',
    })
  })
  it('a marketing block with only blackoutDates is a live policy', () => {
    expect(decideContactPolicy(input({ policy: { marketing: { blackoutDates: RANGE } } }))).toMatchObject({ action: 'defer' })
    expect(decideContactPolicy(input({ policy: { marketing: {} } }))).toEqual({ action: 'send' })
  })
})

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('assertValidContactPolicy — blackoutDates', () => {
  const policy = (dates: unknown): ContactPolicy => ({ marketing: { blackoutDates: dates as any } })
  it('accepts well-formed ranges', () => {
    expect(() => assertValidContactPolicy(policy([{ from: '2026-11-26', to: '2026-11-27', label: 'Thanksgiving' }]))).not.toThrow()
    expect(() => assertValidContactPolicy(policy([]))).not.toThrow()
  })
  it('rejects bad dates, inverted ranges, long labels and too many entries, naming each', () => {
    expect(() => assertValidContactPolicy(policy([{ from: '2026-13-01', to: '2026-13-02' }]))).toThrow(/blackoutDates\[0\]\.from/)
    expect(() => assertValidContactPolicy(policy([{ from: '26-11-26', to: '2026-11-27' }]))).toThrow(/blackoutDates\[0\]\.from/)
    expect(() => assertValidContactPolicy(policy([{ from: '2026-11-27', to: '2026-11-26' }]))).toThrow(/blackoutDates\[0\].*from must not be after to/)
    expect(() => assertValidContactPolicy(policy([{ from: '2026-11-26', to: '2026-11-26', label: 'x'.repeat(65) }]))).toThrow(/blackoutDates\[0\]\.label/)
    expect(() => assertValidContactPolicy(policy(Array.from({ length: 51 }, (_, i) => ({ from: '2026-01-01', to: '2026-01-01', label: String(i) }))))).toThrow(
      /blackoutDates.*at most 50/,
    )
    expect(() => assertValidContactPolicy(policy([{ from: '2026-11-26' }]))).toThrow(/blackoutDates\[0\]\.to/)
    expect(() => assertValidContactPolicy(policy('2026-11-26'))).toThrow(/blackoutDates/)
  })
  it('lists every problem at once', () => {
    expect(() => assertValidContactPolicy(policy([{ from: 'x', to: '2026-11-27' }, { from: '2026-11-27', to: '2026-11-26' }]))).toThrow(
      /blackoutDates\[0\][\s\S]*blackoutDates\[1\]/,
    )
  })
})

// ---------------------------------------------------------------------------
// Dispatch: flows, broadcasts and one-offs defer at the stage
// ---------------------------------------------------------------------------

describe('dispatchSend during a blackout', () => {
  let H: TestMailerHarness
  let n = 0

  beforeAll(async () => {
    H = await createTestMailer({
      config: { contactPolicy: { marketing: { blackoutDates: [{ from: '2026-11-26', to: '2026-11-27' }], defaultTimezone: 'America/New_York' } } },
    })
    await H.seedTemplate({ slug: 'mkt', kind: 'marketing', subject: 'News' })
    await H.seedTemplate({ slug: 'tx', kind: 'transactional', subject: 'Receipt' })
  }, 120_000)
  afterAll(async () => {
    restoreClock()
    if (H) await H.stop()
  })
  afterEach(() => restoreClock())

  async function contact() {
    n++
    await H.seedContact({ externalId: `b${n}`, email: `b${n}@example.com`, tags: [], fields: {} })
    return `b${n}`
  }
  async function oneOff(externalId: string, slug: string) {
    const key = `${externalId}-${slug}-${Math.random()}`
    await H.mailer.sendOneOff({ templateSlug: slug, externalId, dedupeKey: key })
    const row = await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:${key}` })
    await dispatchSend(row!._id as ObjectId, H.ctx)
    return (await H.mailer.collections.sends.findOne({ _id: row!._id }))!
  }

  it('a marketing send is deferred to the end of the blackout and released after it', async () => {
    freezeAt('2026-11-26T15:00:00Z')
    const id = await contact()
    const before = H.provider.sent.length
    const s = await oneOff(id, 'mkt')
    expect(H.provider.sent.length).toBe(before)
    expect(s.status).toBe('deferred')
    expect(s.notBefore).toEqual(d('2026-11-28T05:00:00Z'))
    expect(s.policyDeferral).toMatchObject({ reason: 'blackout' })

    advance(2 * DAY) // 15:00Z on the 28th, past the end
    await H.drain()
    expect((await H.mailer.collections.sends.findOne({ _id: s._id }))!.status).toBe('sent')
  })

  it('transactional mail goes out', async () => {
    freezeAt('2026-11-26T15:00:00Z')
    const id = await contact()
    expect((await oneOff(id, 'tx')).status).toBe('sent')
  })

  it('outside the range marketing goes out', async () => {
    freezeAt('2026-11-28T15:00:00Z')
    const id = await contact()
    expect((await oneOff(id, 'mkt')).status).toBe('sent')
  })
})

// ---------------------------------------------------------------------------
// Programs: the tick and the simulator see the blackout
// ---------------------------------------------------------------------------

describe('program tick during a blackout', () => {
  let P: ProgramHarness
  // 2027-11-25 is a Thursday; the blackout covers Thursday and Friday (UTC dates).
  const RANGE = [{ from: '2027-11-25', to: '2027-11-26' }]

  beforeAll(async () => {
    P = await programHarness({ contactPolicy: { marketing: { blackoutDates: RANGE } } })
    await seedProgramWithTemplates(P.H, activation({ slug: 'bo' }))
    await seedProgramWithTemplates(P.H, activation({ slug: 'bo-window', policy: { minGapDays: 3, delivery: { timeOfDay: '10:00', timezone: 'UTC' } } }))
    await seedProgramWithTemplates(P.H, activation({ slug: 'bo-tz', policy: { minGapDays: 3 } }))
  }, 120_000)
  afterAll(async () => {
    restoreClock()
    if (P) await P.H.stop()
  })
  afterEach(() => restoreClock())

  it('is silent with reason blackout and wakes at the end of the range', async () => {
    freezeAt('2027-11-25T15:00:00Z')
    const { subjectId, owners } = await subject(P)
    await enter(P, 'bo', subjectId)
    expect(await tickProgram(P.H.ctx, 'bo', subjectId)).toMatchObject({ reason: 'blackout', chosen: 'connect-shopify', attempt: 1, sendIds: [] })
    const run = (await getRun(P, 'bo', subjectId))!
    expect(run.nextTickAt).toEqual(d('2027-11-27T00:00:00Z'))
    expect((await lastDecision(P, 'bo', subjectId))!).toMatchObject({ reason: 'blackout', chosen: 'connect-shopify' })
    expect(delivered(P, owners)).toHaveLength(0)

    advance(run.nextTickAt.getTime() - Date.now())
    expect(await tickProgram(P.H.ctx, 'bo', subjectId)).toMatchObject({ reason: 'highest-rank' })
  })

  it('the delivery window is applied after the blackout, and the reason is still blackout', async () => {
    freezeAt('2027-11-25T15:00:00Z')
    const { subjectId } = await subject(P)
    await enter(P, 'bo-window', subjectId)
    expect(await tickProgram(P.H.ctx, 'bo-window', subjectId)).toMatchObject({ reason: 'blackout' })
    expect((await getRun(P, 'bo-window', subjectId))!.nextTickAt).toEqual(d('2027-11-27T10:00:00Z'))
  })

  it('uses the timezone fact for the local date', async () => {
    // 02:00Z on the 27th is still 21:00 on the 26th in New York: inside.
    freezeAt('2027-11-27T02:00:00Z')
    const { subjectId } = await subject(P, { timezone: 'America/New_York' })
    await enter(P, 'bo-tz', subjectId)
    expect(await tickProgram(P.H.ctx, 'bo-tz', subjectId)).toMatchObject({ reason: 'blackout' })
    expect((await getRun(P, 'bo-tz', subjectId))!.nextTickAt).toEqual(d('2027-11-27T05:00:00Z'))

    const utc = await subject(P)
    await enter(P, 'bo-tz', utc.subjectId)
    expect(await tickProgram(P.H.ctx, 'bo-tz', utc.subjectId)).toMatchObject({ reason: 'highest-rank' })
  })

  it('the simulator agrees and projects from the end of the blackout', async () => {
    freezeAt('2027-11-25T15:00:00Z')
    const { subjectId } = await subject(P)
    await enter(P, 'bo-window', subjectId)
    const s = await P.H.mailer.simulateProgram('bo-window', { subjectId })
    expect(s.next).toMatchObject({ reason: 'blackout', actionId: 'connect-shopify', attempt: 1 })
    expect(s.next.at).toEqual(d('2027-11-27T10:00:00Z'))
    expect(s.sequence[0]!.at).toEqual(d('2027-11-27T10:00:00Z'))
    expect(s.sequence[1]!.at).toEqual(d('2027-11-30T10:00:00Z'))
  })

  it('a projected send that would land in a later blackout is moved past it', async () => {
    freezeAt('2027-11-22T15:00:00Z') // Monday, before the range
    const s = await P.H.mailer.simulateProgram('bo', { facts: { business_type: 'ecommerce' } })
    expect(s.next.reason).toBe('send')
    // 3-day gap → the 25th (inside) → the 27th 00:00; then the 30th.
    expect(s.sequence.slice(0, 3).map((x) => x.at.toISOString())).toEqual([
      '2027-11-22T15:00:00.000Z',
      '2027-11-27T00:00:00.000Z',
      '2027-11-30T00:00:00.000Z',
    ])
  })
})
