/**
 * Contact policy (0.21) — plans/15-programs.md §4, rules in
 * src/server/runner/contact-policy.ts.
 *
 * Two layers: `decideContactPolicy` vectors (pure, every rule and boundary),
 * then the stage in `dispatchSend` against a real database: defer writes
 * `deferred` + `notBefore`, re-dispatch re-runs suppression, expiry drops,
 * transactional bypasses, unset config is a no-op.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ObjectId } from 'mongodb'

import {
  decideContactPolicy,
  resolvePolicyTimezone,
  type ContactPolicyInput,
} from '../../src/server/runner/contact-policy.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { runTick } from '../../src/server/runner/index.js'
import type { ContactPolicy } from '../../src/shared/types.js'
import { advance, DAY, freezeAt, HOUR, MINUTE, restoreClock } from '../matrix/clock.js'

const NOW = new Date('2026-03-10T12:00:00Z') // Tuesday, noon UTC
const at = (ms: number) => new Date(NOW.getTime() + ms)

const SPEC: ContactPolicy = {
  marketing: {
    minGapHours: 20,
    maxPerRollingDays: { days: 7, count: 3 },
    quietHours: { start: '21:00', end: '08:00' },
    deferral: { maxHours: 72 },
  },
  sourcePriority: ['transactional', 'flow', 'broadcast', 'program'],
}

function input(over: Partial<ContactPolicyInput> = {}): ContactPolicyInput {
  return {
    policy: SPEC,
    now: NOW,
    kind: 'marketing',
    origin: 'flow',
    queuedAt: over.now ?? NOW,
    timezone: 'UTC',
    history: [],
    pending: [],
    ...over,
  }
}

const only = (marketing: NonNullable<ContactPolicy['marketing']>, extra: Partial<ContactPolicy> = {}): ContactPolicy => ({
  marketing,
  ...extra,
})

describe('decideContactPolicy — no-ops', () => {
  it('unset policy → send', () => {
    expect(decideContactPolicy(input({ policy: undefined, history: [at(-1 * MINUTE)] }))).toEqual({ action: 'send' })
  })
  it('policy without a marketing block → send', () => {
    expect(decideContactPolicy(input({ policy: { sourcePriority: ['flow'] }, history: [at(-MINUTE)] }))).toEqual({ action: 'send' })
  })
  it('transactional bypasses every rule', () => {
    const d = decideContactPolicy(
      input({ kind: 'transactional', history: [at(-MINUTE), at(-2 * MINUTE), at(-3 * MINUTE)], now: new Date('2026-03-10T23:30:00Z') }),
    )
    expect(d).toEqual({ action: 'send' })
  })
  it('empty history, inside allowed hours → send', () => {
    expect(decideContactPolicy(input())).toEqual({ action: 'send' })
  })
})

describe('minGapHours', () => {
  it('defers to lastSentAt + gap', () => {
    expect(decideContactPolicy(input({ policy: only({ minGapHours: 20 }), history: [at(-10 * HOUR)] }))).toEqual({
      action: 'defer',
      notBefore: at(10 * HOUR),
      reason: 'min_gap',
    })
  })
  it('measures from the most recent send regardless of history order', () => {
    const d = decideContactPolicy(input({ policy: only({ minGapHours: 20 }), history: [at(-30 * HOUR), at(-5 * HOUR), at(-50 * HOUR)] }))
    expect(d).toMatchObject({ action: 'defer', notBefore: at(15 * HOUR) })
  })
  it('gap exactly elapsed → send', () => {
    expect(decideContactPolicy(input({ policy: only({ minGapHours: 20 }), history: [at(-20 * HOUR)] }))).toEqual({ action: 'send' })
  })
})

describe('maxPerRollingDays (rolling, not calendar)', () => {
  const cap = only({ maxPerRollingDays: { days: 7, count: 3 } })
  it('at the cap → defer until the oldest counted send leaves the window', () => {
    expect(decideContactPolicy(input({ policy: cap, history: [at(-1 * DAY), at(-2 * DAY), at(-6 * DAY)] }))).toEqual({
      action: 'defer',
      notBefore: at(1 * DAY),
      reason: 'rolling_cap',
    })
  })
  it('uses the count-th most recent send, ignoring older ones', () => {
    // +4d is past the default 72h expiry, so widen it: this vector is about the cap.
    const wide = only({ maxPerRollingDays: { days: 7, count: 3 }, deferral: { maxHours: 24 * 30 } })
    const d = decideContactPolicy(input({ policy: wide, history: [at(-1 * DAY), at(-2 * DAY), at(-3 * DAY), at(-5 * DAY)] }))
    expect(d).toMatchObject({ action: 'defer', notBefore: at(4 * DAY) })
  })
  it('a send just outside the window does not count', () => {
    expect(decideContactPolicy(input({ policy: cap, history: [at(-1 * DAY), at(-2 * DAY), at(-7 * DAY - 1)] }))).toEqual({ action: 'send' })
  })
  it('the window is (now − days, now]: a send exactly `days` ago does not count', () => {
    expect(decideContactPolicy(input({ policy: cap, history: [at(-1 * DAY), at(-2 * DAY), at(-7 * DAY)] }))).toEqual({ action: 'send' })
  })
  it('calendar-day thinking would allow two sends two hours apart; rolling does not', () => {
    const d = decideContactPolicy(
      input({ policy: only({ maxPerRollingDays: { days: 1, count: 1 } }), now: new Date('2026-03-11T01:00:00Z'), history: [new Date('2026-03-10T23:00:00Z')] }),
    )
    expect(d).toMatchObject({ action: 'defer', notBefore: new Date('2026-03-11T23:00:00Z') })
  })
})

describe('gap and cap together', () => {
  it('takes the later constraint and names it', () => {
    const d = decideContactPolicy(
      input({ policy: only({ minGapHours: 20, maxPerRollingDays: { days: 7, count: 2 } }), history: [at(-2 * HOUR), at(-6 * DAY)] }),
    )
    // gap → +18h; cap (2 in window) → oldest (−6d) + 7d = +1d. Cap is later.
    expect(d).toEqual({ action: 'defer', notBefore: at(1 * DAY), reason: 'rolling_cap' })
  })
})

describe('quietHours', () => {
  const q = (start: string, end: string, tz?: string) => only({ quietHours: { start, end }, ...(tz ? { defaultTimezone: tz } : {}) })
  it('inside an overnight window → end of window, next morning', () => {
    expect(decideContactPolicy(input({ policy: q('21:00', '08:00'), now: new Date('2026-03-10T23:00:00Z') }))).toEqual({
      action: 'defer',
      notBefore: new Date('2026-03-11T08:00:00Z'),
      reason: 'quiet_hours',
    })
  })
  it('after midnight inside an overnight window → same morning', () => {
    expect(decideContactPolicy(input({ policy: q('21:00', '08:00'), now: new Date('2026-03-10T07:59:00Z') }))).toMatchObject({
      action: 'defer',
      notBefore: new Date('2026-03-10T08:00:00Z'),
    })
  })
  it('start is inclusive, end is exclusive', () => {
    expect(decideContactPolicy(input({ policy: q('21:00', '08:00'), now: new Date('2026-03-10T08:00:00Z') }))).toEqual({ action: 'send' })
    expect(decideContactPolicy(input({ policy: q('21:00', '08:00'), now: new Date('2026-03-10T21:00:00Z') }))).toMatchObject({ action: 'defer' })
    expect(decideContactPolicy(input({ policy: q('21:00', '08:00'), now: new Date('2026-03-10T20:59:00Z') }))).toEqual({ action: 'send' })
  })
  it('a same-day window (start < end)', () => {
    expect(decideContactPolicy(input({ policy: q('12:00', '14:00'), now: new Date('2026-03-10T13:00:00Z') }))).toMatchObject({
      action: 'defer',
      notBefore: new Date('2026-03-10T14:00:00Z'),
    })
    expect(decideContactPolicy(input({ policy: q('12:00', '14:00'), now: new Date('2026-03-10T15:00:00Z') }))).toEqual({ action: 'send' })
  })
  it('is evaluated in the recipient zone', () => {
    // 02:00Z on 10 Mar = 22:00 EDT on 9 Mar (DST began 8 Mar 2026).
    const d = decideContactPolicy(input({ policy: q('21:00', '08:00'), timezone: 'America/New_York', now: new Date('2026-03-10T02:00:00Z') }))
    expect(d).toMatchObject({ action: 'defer', notBefore: new Date('2026-03-10T12:00:00Z') })
  })
  it('spring-forward night: quiet period ends at 08:00 EDT, not 08:00 EST', () => {
    // 04:30Z on 8 Mar = 23:30 EST on 7 Mar. Clocks jump at 02:00 local.
    const d = decideContactPolicy(input({ policy: q('21:00', '08:00'), timezone: 'America/New_York', now: new Date('2026-03-08T04:30:00Z') }))
    expect(d).toMatchObject({ action: 'defer', notBefore: new Date('2026-03-08T12:00:00Z') })
  })
  it('fall-back night: quiet period ends at 08:00 EST', () => {
    // 03:00Z on 1 Nov = 23:00 EDT on 31 Oct. Clocks fall back at 02:00 local.
    const d = decideContactPolicy(input({ policy: q('21:00', '08:00'), timezone: 'America/New_York', now: new Date('2026-11-01T03:00:00Z') }))
    expect(d).toMatchObject({ action: 'defer', notBefore: new Date('2026-11-01T13:00:00Z') })
  })
  it('a gap that lands inside quiet hours is pushed to the end of them', () => {
    const d = decideContactPolicy(
      input({ policy: only({ minGapHours: 20, quietHours: { start: '21:00', end: '08:00' } }), history: [at(-10 * HOUR)] }),
    )
    // gap → 22:00Z, inside quiet → 08:00Z next day.
    expect(d).toEqual({ action: 'defer', notBefore: new Date('2026-03-11T08:00:00Z'), reason: 'quiet_hours' })
  })
})

describe('resolvePolicyTimezone — contact → send hint → policy default → UTC', () => {
  it('prefers the contact zone', () => {
    expect(resolvePolicyTimezone('Europe/Paris', 'America/New_York', 'Asia/Tokyo')).toBe('Europe/Paris')
  })
  it('falls back to the send hint (Programs: the account timezone fact)', () => {
    expect(resolvePolicyTimezone(undefined, 'America/New_York', 'Asia/Tokyo')).toBe('America/New_York')
  })
  it('then to the policy default', () => {
    expect(resolvePolicyTimezone(null, null, 'Asia/Tokyo')).toBe('Asia/Tokyo')
  })
  it('then UTC', () => {
    expect(resolvePolicyTimezone(undefined, undefined, undefined)).toBe('UTC')
  })
  it('skips invalid zones instead of throwing', () => {
    expect(resolvePolicyTimezone('Bogus/Zone', 'Also/Bogus', 'Asia/Tokyo')).toBe('Asia/Tokyo')
  })
})

describe('deferral expiry', () => {
  it('drops when the earliest allowed time is past queuedAt + maxHours', () => {
    const d = decideContactPolicy(
      input({ policy: only({ minGapHours: 20, deferral: { maxHours: 72 } }), queuedAt: at(-70 * HOUR), history: [at(-15 * HOUR)] }),
    )
    expect(d).toEqual({ action: 'drop', reason: 'min_gap', wouldBe: at(5 * HOUR) })
  })
  it('defaults maxHours to 72', () => {
    const d = decideContactPolicy(input({ policy: only({ minGapHours: 20 }), queuedAt: at(-71 * HOUR), history: [at(-18 * HOUR)] }))
    expect(d).toMatchObject({ action: 'drop' })
  })
  it('exactly at the limit still defers', () => {
    const d = decideContactPolicy(
      input({ policy: only({ minGapHours: 20, deferral: { maxHours: 72 } }), queuedAt: at(-67 * HOUR), history: [at(-15 * HOUR)] }),
    )
    expect(d).toMatchObject({ action: 'defer', notBefore: at(5 * HOUR) })
  })
})

describe('sourcePriority contention', () => {
  const p = (extra: Partial<ContactPolicy> = {}): ContactPolicy => ({ marketing: { minGapHours: 20 }, ...extra })
  it('a lower-priority send meeting a due higher-priority one defers by minGapHours', () => {
    const d = decideContactPolicy(input({ policy: p(), origin: 'program', pending: [{ origin: 'flow', dueAt: at(-MINUTE) }] }))
    expect(d).toEqual({ action: 'defer', notBefore: at(20 * HOUR), reason: 'priority' })
  })
  it('a higher-priority pending send due later is not contention', () => {
    expect(decideContactPolicy(input({ policy: p(), origin: 'program', pending: [{ origin: 'flow', dueAt: at(HOUR) }] }))).toEqual({ action: 'send' })
  })
  it('the higher-priority send itself goes', () => {
    expect(decideContactPolicy(input({ policy: p(), origin: 'flow', pending: [{ origin: 'program', dueAt: at(-MINUTE) }] }))).toEqual({ action: 'send' })
  })
  it('equal priority is first come, first served', () => {
    expect(decideContactPolicy(input({ policy: p(), origin: 'flow', pending: [{ origin: 'flow', dueAt: at(-MINUTE) }] }))).toEqual({ action: 'send' })
  })
  it('without minGapHours the contention deferral is one hour', () => {
    const d = decideContactPolicy(input({ policy: { marketing: {} }, origin: 'program', pending: [{ origin: 'broadcast', dueAt: NOW }] }))
    expect(d).toEqual({ action: 'defer', notBefore: at(HOUR), reason: 'priority' })
  })
  it('the default order is transactional, flow, oneoff, broadcast, program', () => {
    const base = { marketing: { minGapHours: 1 } }
    expect(decideContactPolicy(input({ policy: base, origin: 'broadcast', pending: [{ origin: 'oneoff', dueAt: NOW }] }))).toMatchObject({ action: 'defer' })
    expect(decideContactPolicy(input({ policy: base, origin: 'oneoff', pending: [{ origin: 'broadcast', dueAt: NOW }] }))).toEqual({ action: 'send' })
  })
  it('an origin missing from sourcePriority ranks below every listed one', () => {
    const d = decideContactPolicy(
      input({ policy: p({ sourcePriority: ['flow', 'program'] }), origin: 'oneoff', pending: [{ origin: 'program', dueAt: NOW }] }),
    )
    expect(d).toMatchObject({ action: 'defer', reason: 'priority' })
  })
})

// ---------------------------------------------------------------------------
// The stage inside dispatchSend
// ---------------------------------------------------------------------------

describe('dispatchSend with a contact policy', () => {
  let H: TestMailerHarness
  let n = 0

  beforeAll(async () => {
    H = await createTestMailer({
      config: {
        contactPolicy: { marketing: { minGapHours: 20, deferral: { maxHours: 72 } } },
      },
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
    await H.seedContact({ externalId: `p${n}`, email: `p${n}@example.com`, tags: [], fields: {} })
    return `p${n}`
  }

  async function oneOff(externalId: string, slug: string) {
    const key = `${externalId}-${slug}-${Math.random()}`
    await H.mailer.sendOneOff({ templateSlug: slug, externalId, dedupeKey: key })
    const row = await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:${key}` })
    await dispatchSend(row!._id as ObjectId, H.ctx)
    return (await H.mailer.collections.sends.findOne({ _id: row!._id }))!
  }

  it('first marketing send goes; the second inside the gap is deferred, not sent', async () => {
    const t0 = freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    const first = await oneOff(id, 'mkt')
    expect(first.status).toBe('sent')

    advance(2 * HOUR)
    const before = H.provider.sent.length
    const second = await oneOff(id, 'mkt')
    expect(H.provider.sent.length).toBe(before)
    expect(second.status).toBe('deferred')
    expect(second.notBefore).toEqual(new Date(t0.getTime() + 20 * HOUR))
    expect(second.policyDeferral).toMatchObject({ reason: 'min_gap', count: 1 })
    expect(second.policyDeferral?.firstDeferredAt).toEqual(new Date(t0.getTime() + 2 * HOUR))
  })

  it('a deferred send is released and sent once notBefore passes', async () => {
    freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    await oneOff(id, 'mkt')
    advance(HOUR)
    const deferred = await oneOff(id, 'mkt')
    expect(deferred.status).toBe('deferred')

    advance(20 * HOUR)
    await H.drain()
    const after = await H.mailer.collections.sends.findOne({ _id: deferred._id })
    expect(after?.status).toBe('sent')
  })

  it('the mailer tick releases due deferrals too (lost delayed job)', async () => {
    freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    await oneOff(id, 'mkt')
    advance(HOUR)
    const deferred = await oneOff(id, 'mkt')
    advance(20 * HOUR)
    await runTick(H.ctx)
    const after = await H.mailer.collections.sends.findOne({ _id: deferred._id })
    expect(after?.status).toBe('queued')
  })

  it('a due deferred send can be claimed directly by its delayed job', async () => {
    freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    await oneOff(id, 'mkt')
    advance(HOUR)
    const deferred = await oneOff(id, 'mkt')
    advance(20 * HOUR)
    await dispatchSend(deferred._id as ObjectId, H.ctx)
    expect((await H.mailer.collections.sends.findOne({ _id: deferred._id }))?.status).toBe('sent')
  })

  it('re-dispatch re-checks suppression (INVARIANT 3)', async () => {
    freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    await oneOff(id, 'mkt')
    advance(HOUR)
    const deferred = await oneOff(id, 'mkt')
    await H.mailer.unsubscribe(`${id}@example.com`, { scope: 'marketing', reason: 'user_request', source: 'test' })
    advance(20 * HOUR)
    await H.drain()
    expect((await H.mailer.collections.sends.findOne({ _id: deferred._id }))?.status).toBe('suppressed')
  })

  it('past deferral.maxHours the send is cancelled with policy_expired and never sent', async () => {
    freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    await oneOff(id, 'mkt')
    // Queue a send now but let it sit (stuck queue) for 70h, then dispatch.
    advance(HOUR)
    const key = `${id}-stale`
    await H.mailer.sendOneOff({ templateSlug: 'mkt', externalId: id, dedupeKey: key })
    const row = await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:${key}` })
    // A second marketing send just before dispatch resets the gap.
    advance(68 * HOUR)
    await oneOff(id, 'mkt')
    advance(HOUR)
    const before = H.provider.sent.length
    await dispatchSend(row!._id as ObjectId, H.ctx)
    const after = await H.mailer.collections.sends.findOne({ _id: row!._id })
    expect(H.provider.sent.length).toBe(before)
    expect(after?.status).toBe('cancelled')
    expect(after?.exitReason).toBe('policy_expired')
  })

  it('transactional bypasses the policy but is still recorded', async () => {
    freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    await oneOff(id, 'mkt')
    advance(MINUTE)
    const tx = await oneOff(id, 'tx')
    expect(tx.status).toBe('sent')
    expect(tx.sentAt).not.toBeNull()
  })

  it('transactional sends count toward nothing', async () => {
    freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    await oneOff(id, 'mkt')
    advance(21 * HOUR)
    await oneOff(id, 'tx')
    advance(MINUTE)
    expect((await oneOff(id, 'mkt')).status).toBe('sent')
  })

  it('a deferred send is not history: it does not push the next send back', async () => {
    freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    await oneOff(id, 'mkt')
    advance(HOUR)
    await oneOff(id, 'mkt') // deferred to +20h
    advance(20 * HOUR)
    // Not released yet; a fresh send at +21h measures the gap from the first send.
    expect((await oneOff(id, 'mkt')).status).toBe('sent')
  })

  it('abortFlow cancels a deferred flow send', async () => {
    freezeAt('2026-03-10T12:00:00Z')
    const id = await contact()
    await H.seedFlow({ slug: `pol-flow-${n}`, eventName: `Pol ${n}`, steps: [step.send('mkt')] })
    H.mailer.registerEvent({ name: `Pol ${n}`, dedupePolicy: 'once-per-contact' })
    await oneOff(id, 'mkt')
    advance(MINUTE)
    await H.mailer.fire(`Pol ${n}`, id)
    await H.drain()
    const flowSend = await H.mailer.collections.sends.findOne({ externalId: id, flowRunId: { $ne: null } })
    expect(flowSend?.status).toBe('deferred')
    const res = await H.mailer.abortFlow(`pol-flow-${n}`, id, { reason: 'upgraded' })
    expect(res.cancelledSends).toBe(1)
    expect((await H.mailer.collections.sends.findOne({ _id: flowSend!._id }))?.status).toBe('cancelled')
  })

  it('with no contactPolicy configured the stage is a no-op', async () => {
    const plain = await createTestMailer()
    try {
      await plain.seedContact({ externalId: 'z', email: 'z@example.com', tags: [], fields: {} })
      await plain.seedTemplate({ slug: 'mkt', kind: 'marketing' })
      for (const k of ['a', 'b', 'c']) {
        await plain.mailer.sendOneOff({ templateSlug: 'mkt', externalId: 'z', dedupeKey: k })
      }
      await plain.drain()
      expect(plain.provider.sent).toHaveLength(3)
    } finally {
      await plain.stop()
    }
  }, 120_000)
})
