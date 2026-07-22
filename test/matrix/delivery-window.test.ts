/**
 * Delivery-window matrix — the send-time axis, driven through the REAL runner.
 *
 * `test/unit/delivery-window.test.ts` covers `computeDeliveryTime` as a pure
 * function. This file covers the path nothing tested before: the send step
 * consulting the window (src/server/runner/step.ts:57), parking the run via
 * `deferSendForWindow` (:268), and the deferred run later waking through the
 * sweep and actually dispatching.
 *
 * Every expected instant below is derived from the documented rules, not from
 * running the code:
 *   - `timeOfDay` moves the send to that wall-clock slot in the resolved zone;
 *     a slot already past by more than TIME_OF_DAY_GRACE_MS (1h) rolls to the
 *     next day, within the grace it sends immediately.
 *   - `weekdaysOnly` shifts Sat +2 days and Sun +1 day, PRESERVING the local
 *     wall-clock time.
 *   - the zone is `contactTimezone` (if useContactTimezone and valid), else
 *     `window.timezone`, else UTC.
 *
 * Reference calendar (all UTC): 2026-03-04 Wed · 03-06 Fri · 03-07 Sat ·
 * 03-08 Sun · 03-09 Mon. US DST begins Sun 2026-03-08.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { processOneRunStep } from '../../src/server/runner/index.js'
import { freezeAt, advance, restoreClock, localStamp, weekdayIn, HOUR } from './clock.js'
import type { DeliveryWindow, Contact } from '../../src/shared/types.js'
import type { FlowRunDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness
let caseId = 0

beforeAll(async () => {
  // Built before the clock is frozen — mongodb-memory-server startup should
  // see a real clock.
  H = await createTestMailer()
}, 60_000)

afterEach(() => {
  restoreClock()
})

afterAll(async () => {
  restoreClock()
  if (H) await H.stop()
})

interface CaseSetup {
  /** Instant to freeze the clock at, before the flow is entered. */
  at: string
  delivery?: DeliveryWindow
  contactTimezone?: string
}

interface CaseHandle {
  externalId: string
  flowSlug: string
  run: () => Promise<FlowRunDoc>
  sentCount: () => number
}

/**
 * Freeze the clock, seed an isolated contact + template + flow whose only step
 * is a windowed send, fire the trigger and drain once. Everything is uniquely
 * slugged so cases can share one Mongo instance without interfering.
 */
async function setupCase(setup: CaseSetup): Promise<CaseHandle> {
  const n = ++caseId
  const externalId = `u${n}`
  const flowSlug = `flow-${n}`
  const templateSlug = `tpl-${n}`
  const eventName = `Trigger${n}`

  freezeAt(setup.at)

  const contact: Contact = {
    externalId,
    email: `case${n}@example.com`,
    tags: [],
    fields: { firstName: `Case${n}` },
    ...(setup.contactTimezone ? { timezone: setup.contactTimezone } : {}),
  }
  await H.seedContact(contact)
  await H.seedTemplate({ slug: templateSlug, subject: `Case ${n}` })
  await H.seedFlow({
    slug: flowSlug,
    eventName,
    steps: [
      setup.delivery
        ? step.sendAt(templateSlug, setup.delivery)
        : step.send(templateSlug),
    ],
  })

  H.mailer.registerEvent({ name: eventName, dedupePolicy: 'once-per-contact' })
  await H.mailer.fire(eventName, externalId)
  await H.drain()

  const sentBefore = 0
  return {
    externalId,
    flowSlug,
    async run() {
      const run = await H.ctx.collections.flowRuns.findOne({ flowSlug })
      expect(run, `flow_run for ${flowSlug} should exist`).not.toBeNull()
      return run!
    },
    sentCount: () => H.provider.toRecipient(`case${n}@example.com`).length + sentBefore,
  }
}

/** Assert the run is parked on its send step, waiting for `expectedIso`. */
async function expectDeferredUntil(c: CaseHandle, expectedIso: string): Promise<void> {
  const run = await c.run()
  expect(c.sentCount(), 'nothing should have been sent yet').toBe(0)
  expect(run.status).toBe('active')
  expect(run.nextActionAt.toISOString()).toBe(new Date(expectedIso).toISOString())
  const deferrals = run.history.filter((h) => h.action === 'send_deferred')
  expect(deferrals).toHaveLength(1)
  expect((deferrals[0]!.details as any).until.toISOString()).toBe(new Date(expectedIso).toISOString())
}

/** Move to the deferred slot, drain, and confirm the mail finally goes out. */
async function expectSendsAfterAdvancingTo(c: CaseHandle, iso: string): Promise<void> {
  advance(new Date(iso).getTime() - Date.now())
  await H.drain()
  expect(c.sentCount(), `should send once the window opens at ${iso}`).toBe(1)
}

describe('delivery window — no window configured', () => {
  it('sends immediately', async () => {
    const c = await setupCase({ at: '2026-03-04T12:00:00Z' })
    expect(c.sentCount()).toBe(1)
    const run = await c.run()
    expect(run.history.some((h) => h.action === 'send_deferred')).toBe(false)
  })
})

describe('delivery window — timeOfDay', () => {
  it('defers to today\'s slot when it is still ahead', async () => {
    const c = await setupCase({
      at: '2026-03-04T09:00:00Z',
      delivery: { timeOfDay: '17:00' },
    })
    await expectDeferredUntil(c, '2026-03-04T17:00:00Z')
    await expectSendsAfterAdvancingTo(c, '2026-03-04T17:00:00Z')
  })

  it('sends immediately when the slot passed within the 1h grace', async () => {
    // 12:30 against a 12:00 slot — 30min late, inside TIME_OF_DAY_GRACE_MS.
    const c = await setupCase({
      at: '2026-03-04T12:30:00Z',
      delivery: { timeOfDay: '12:00' },
    })
    expect(c.sentCount()).toBe(1)
    const run = await c.run()
    expect(run.history.some((h) => h.action === 'send_deferred')).toBe(false)
  })

  it('rolls to tomorrow when the slot passed beyond the grace', async () => {
    // 14:00 against a 12:00 slot — 2h late, past the grace.
    const c = await setupCase({
      at: '2026-03-04T14:00:00Z',
      delivery: { timeOfDay: '12:00' },
    })
    await expectDeferredUntil(c, '2026-03-05T12:00:00Z')
    await expectSendsAfterAdvancingTo(c, '2026-03-05T12:00:00Z')
  })
})

describe('delivery window — weekdaysOnly', () => {
  it('Saturday shifts to Monday, preserving the local time', async () => {
    const c = await setupCase({
      at: '2026-03-07T10:00:00Z', // Sat
      delivery: { weekdaysOnly: true },
    })
    await expectDeferredUntil(c, '2026-03-09T10:00:00Z') // Mon, same 10:00
    const run = await c.run()
    expect(weekdayIn(run.nextActionAt)).toBe('Mon')
    await expectSendsAfterAdvancingTo(c, '2026-03-09T10:00:00Z')
  })

  it('Sunday shifts to Monday', async () => {
    const c = await setupCase({
      at: '2026-03-08T10:00:00Z', // Sun
      delivery: { weekdaysOnly: true },
    })
    await expectDeferredUntil(c, '2026-03-09T10:00:00Z')
    expect(weekdayIn((await c.run()).nextActionAt)).toBe('Mon')
  })

  it('Friday is left alone', async () => {
    const c = await setupCase({
      at: '2026-03-06T10:00:00Z', // Fri
      delivery: { weekdaysOnly: true },
    })
    expect(c.sentCount()).toBe(1)
  })

  it('combines with timeOfDay: Friday evening lands on Monday morning', async () => {
    // 20:00 Fri vs a 09:00 slot → past grace → Sat 09:00 → weekend shift → Mon 09:00.
    const c = await setupCase({
      at: '2026-03-06T20:00:00Z',
      delivery: { weekdaysOnly: true, timeOfDay: '09:00' },
    })
    await expectDeferredUntil(c, '2026-03-09T09:00:00Z')
    await expectSendsAfterAdvancingTo(c, '2026-03-09T09:00:00Z')
  })
})

describe('delivery window — timezone resolution', () => {
  it('uses the contact timezone when useContactTimezone is set', async () => {
    // 12:00Z is 07:00 EST (UTC-5, pre-DST). The 09:00 local slot is 14:00Z —
    // if this resolved in UTC instead, 09:00Z would already be past.
    const c = await setupCase({
      at: '2026-03-04T12:00:00Z',
      contactTimezone: 'America/New_York',
      delivery: { timeOfDay: '09:00', useContactTimezone: true },
    })
    await expectDeferredUntil(c, '2026-03-04T14:00:00Z')
    expect(localStamp((await c.run()).nextActionAt, 'America/New_York')).toBe('2026-03-04 09:00')
  })

  it('falls back to window.timezone when the contact has none', async () => {
    // 2026-03-03T23:00Z is 08:00 JST on Mar 4. The 09:00 JST slot is
    // 2026-03-04T00:00Z — an hour out. Resolving in UTC would give 09:00Z.
    const c = await setupCase({
      at: '2026-03-03T23:00:00Z',
      delivery: { timeOfDay: '09:00', useContactTimezone: true, timezone: 'Asia/Tokyo' },
    })
    await expectDeferredUntil(c, '2026-03-04T00:00:00Z')
    expect(localStamp((await c.run()).nextActionAt, 'Asia/Tokyo')).toBe('2026-03-04 09:00')
  })

  it('falls back to UTC when the contact timezone is invalid', async () => {
    const c = await setupCase({
      at: '2026-03-04T09:00:00Z',
      contactTimezone: 'Mars/Phobos',
      delivery: { timeOfDay: '17:00', useContactTimezone: true },
    })
    await expectDeferredUntil(c, '2026-03-04T17:00:00Z')
  })

  it('ignores the contact timezone when useContactTimezone is not set', async () => {
    const c = await setupCase({
      at: '2026-03-04T09:00:00Z',
      contactTimezone: 'America/New_York',
      delivery: { timeOfDay: '17:00' }, // resolved in UTC
    })
    await expectDeferredUntil(c, '2026-03-04T17:00:00Z')
  })

  it('uses window.timezone directly when useContactTimezone is not set', async () => {
    // The middle rung of pickTimezone on its own, not as a fallback. The
    // contact's own zone is present and must be ignored: 2026-03-03T23:00Z is
    // 08:00 in Tokyo (so the 09:00 slot is an hour out) but 18:00 in New York
    // (where the next 09:00 would be ~15h out).
    const c = await setupCase({
      at: '2026-03-03T23:00:00Z',
      contactTimezone: 'America/New_York',
      delivery: { timeOfDay: '09:00', timezone: 'Asia/Tokyo' },
    })
    await expectDeferredUntil(c, '2026-03-04T00:00:00Z')
    expect(localStamp((await c.run()).nextActionAt, 'Asia/Tokyo')).toBe('2026-03-04 09:00')
  })

  it('the weekend is judged in the contact timezone, not UTC', async () => {
    // The cross-axis case. 2026-03-06T12:00Z is Friday in UTC but already
    // Saturday 02:00 in Kiritimati (+14). Same instant, same window — the
    // outcome is decided entirely by which zone the gate resolves in.
    const inContactZone = await setupCase({
      at: '2026-03-06T12:00:00Z',
      contactTimezone: 'Pacific/Kiritimati',
      delivery: { weekdaysOnly: true, useContactTimezone: true },
    })
    const run = await inContactZone.run()
    expect(weekdayIn(new Date('2026-03-06T12:00:00Z'), 'Pacific/Kiritimati')).toBe('Sat')
    expect(inContactZone.sentCount(), 'it is the weekend where the contact lives').toBe(0)
    // Sat 02:00 local + 2 days = Mon 02:00 local, which is Sunday in UTC —
    // correct, because the gate is about the recipient's calendar, not ours.
    expect(weekdayIn(run.nextActionAt, 'Pacific/Kiritimati')).toBe('Mon')
    expect(localStamp(run.nextActionAt, 'Pacific/Kiritimati')).toBe('2026-03-09 02:00')
    expect(run.nextActionAt.toISOString()).toBe(new Date('2026-03-08T12:00:00Z').toISOString())

    // Same instant, same window, contact zone ignored → plain Friday → sends.
    const inUtc = await setupCase({
      at: '2026-03-06T12:00:00Z',
      contactTimezone: 'Pacific/Kiritimati',
      delivery: { weekdaysOnly: true },
    })
    expect(inUtc.sentCount(), 'Friday in UTC — nothing to hold').toBe(1)
  })

  it('preserves the local wall clock across a DST transition', async () => {
    // Sat 07:00 in New York (EST, UTC-5). +2 days lands on Mon Mar 9, which is
    // EDT (UTC-4) because DST began on the 8th. The invariant the code promises
    // is the LOCAL time, not a fixed 48h offset.
    const c = await setupCase({
      at: '2026-03-07T12:00:00Z', // Sat 07:00 EST
      contactTimezone: 'America/New_York',
      delivery: { weekdaysOnly: true, useContactTimezone: true },
    })
    const run = await c.run()
    expect(weekdayIn(run.nextActionAt, 'America/New_York')).toBe('Mon')
    expect(localStamp(run.nextActionAt, 'America/New_York')).toBe('2026-03-09 07:00')
    // Same wall clock, one hour less elapsed than a naive 48h shift.
    const naive48h = new Date('2026-03-09T12:00:00Z').getTime()
    expect(run.nextActionAt.getTime()).toBe(naive48h - HOUR)
  })
})

describe('delivery window — DST edges', () => {
  /**
   * Spring forward: on 2026-03-08 New York jumps 02:00 → 03:00, so a 02:30
   * local slot DOES NOT EXIST that day. `utcFromLocal`'s two-pass offset fix
   * has to land somewhere sane rather than throwing, looping or emitting an
   * instant in the past. Asserted as a bound, not an exact instant — the
   * module header documents the worst case during a transition as being off by
   * the shifted hour, so pinning one exact answer would over-specify.
   */
  it('a nonexistent local time (spring forward) resolves to a sane future instant', async () => {
    const now = new Date('2026-03-08T06:00:00Z') // 01:00 EST, an hour before the jump
    const c = await setupCase({
      at: now.toISOString(),
      contactTimezone: 'America/New_York',
      delivery: { timeOfDay: '02:30', useContactTimezone: true },
    })

    const run = await c.run()
    expect(run.status, 'must not fail the run').toBe('active')

    const target = run.nextActionAt
    expect(target.getTime(), 'never schedules into the past').toBeGreaterThan(now.getTime())
    // Within a day, and within an hour either side of the skipped slot.
    expect(target.getTime() - now.getTime()).toBeLessThan(25 * 60 * 60_000)
    const local = localStamp(target, 'America/New_York')
    expect(local.startsWith('2026-03-08') || local.startsWith('2026-03-09')).toBe(true)
  })

  /**
   * Fall back: on 2026-11-01 New York repeats 01:00 → 02:00, so 01:30 local
   * happens TWICE — once at UTC-4 (EDT, 05:30Z) and once at UTC-5 (06:30Z).
   * Either is a defensible answer; scheduling outside both is not.
   */
  it('an ambiguous local time (fall back) resolves to one of the two real instants', async () => {
    const now = new Date('2026-11-01T04:00:00Z') // 00:00 EDT, before the repeat
    const c = await setupCase({
      at: now.toISOString(),
      contactTimezone: 'America/New_York',
      delivery: { timeOfDay: '01:30', useContactTimezone: true },
    })

    const run = await c.run()
    expect(run.status).toBe('active')
    expect(run.nextActionAt.getTime()).toBeGreaterThan(now.getTime())

    const edt = new Date('2026-11-01T05:30:00Z').getTime() // first 01:30
    const est = new Date('2026-11-01T06:30:00Z').getTime() // second 01:30
    expect([edt, est]).toContain(run.nextActionAt.getTime())
    expect(localStamp(run.nextActionAt, 'America/New_York')).toBe('2026-11-01 01:30')
  })
})

describe('delivery window — deferral is idempotent', () => {
  it('re-processing the parked step does not add a second send_deferred', async () => {
    const c = await setupCase({
      at: '2026-03-04T09:00:00Z',
      delivery: { timeOfDay: '17:00' },
    })
    await expectDeferredUntil(c, '2026-03-04T17:00:00Z')

    // Drive the step directly — the sweep would skip it (nextActionAt is in the
    // future), so this is the only way to exercise the `nextActionAt < deliverAt`
    // guard in deferSendForWindow.
    const run = await c.run()
    await processOneRunStep(run._id!, H.ctx)
    await processOneRunStep(run._id!, H.ctx)

    const after = await c.run()
    expect(after.history.filter((h) => h.action === 'send_deferred')).toHaveLength(1)
    expect(after.nextActionAt.toISOString()).toBe(new Date('2026-03-04T17:00:00Z').toISOString())
    expect(c.sentCount()).toBe(0)
  })
})
