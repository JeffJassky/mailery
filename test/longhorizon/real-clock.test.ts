/**
 * Real-clock delivery gating — no frozen time anywhere in this file.
 *
 * `test/matrix/delivery-window.test.ts` freezes the clock to pin exact
 * instants. That is fast and precise, but it can only ever prove the code is
 * self-consistent with a fake `Date`. This file runs the same machinery
 * against whatever moment it happens to execute in, and derives its
 * expectations from the real calendar.
 *
 * Consequences, by design:
 *   - The weekend branch only executes ON a real weekend. That is why CI runs
 *     this on a Sat/Sun cron as well as on every push — the calendar supplies
 *     the axis instead of a mock. On a Wednesday the same test asserts the
 *     opposite branch (no deferral), so it is never vacuous.
 *   - The timezone case needs no waiting at all: Pacific/Kiritimati (+14) and
 *     Pacific/Midway (-11) are 25 hours apart, so they can never share a
 *     calendar date. Whatever the instant, one is always a day ahead.
 *
 * Under `libfaketime` (the CI workflow_dispatch job) the process clock is
 * shifted, so this same file exercises whichever calendar the operator picked.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import type { FlowRunDoc } from '../../src/server/models/index.js'

const AHEAD = 'Pacific/Kiritimati' // UTC+14
const BEHIND = 'Pacific/Midway' //   UTC-11

let H: TestMailerHarness
let counter = 0

beforeAll(async () => {
  H = await createTestMailer()
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

function weekdayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date)
}

function dateIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function isWeekend(day: string): boolean {
  return day === 'Sat' || day === 'Sun'
}

interface Fired {
  run: () => Promise<FlowRunDoc>
  sentCount: () => number
}

async function fireWindowedSend(opts: {
  delivery: Parameters<typeof step.sendAt>[1]
  timezone?: string
}): Promise<Fired> {
  const i = ++counter
  const externalId = `rc${i}`
  const email = `realclock${i}@example.com`
  const tpl = `rc-tpl-${i}`
  const eventName = `RealClock${i}`

  await H.seedContact({
    externalId,
    email,
    tags: [],
    fields: {},
    ...(opts.timezone ? { timezone: opts.timezone } : {}),
  })
  await H.seedTemplate({ slug: tpl, subject: `real clock ${i}` })
  await H.seedFlow({
    slug: `rc-flow-${i}`,
    eventName,
    steps: [step.sendAt(tpl, opts.delivery)],
  })
  H.mailer.registerEvent({ name: eventName, dedupePolicy: 'every-time' })
  await H.mailer.fire(eventName, externalId)
  await H.drain()

  return {
    run: async () => (await H.ctx.collections.flowRuns.findOne({ flowSlug: `rc-flow-${i}` }))!,
    sentCount: () => H.provider.toRecipient(email).length,
  }
}

describe('weekday gating against the real calendar', () => {
  it('defers to a weekday if and only if today really is a weekend', async () => {
    const now = new Date()
    const today = weekdayIn(now, 'UTC')
    const f = await fireWindowedSend({ delivery: { weekdaysOnly: true } })

    if (isWeekend(today)) {
      const run = await f.run()
      expect(f.sentCount(), `today is ${today} — the send must be held`).toBe(0)
      expect(run.status).toBe('active')
      expect(
        isWeekend(weekdayIn(run.nextActionAt, 'UTC')),
        'the deferred slot must not itself be a weekend',
      ).toBe(false)
      expect(weekdayIn(run.nextActionAt, 'UTC')).toBe('Mon')
      expect(run.nextActionAt.getTime()).toBeGreaterThan(now.getTime())
    } else {
      expect(f.sentCount(), `today is ${today} — the send must go out now`).toBe(1)
      const run = await f.run()
      expect(run.history.some((h) => h.action === 'send_deferred')).toBe(false)
    }
  }, 60_000)

  it('a send with no window goes out regardless of the day', async () => {
    const i = ++counter
    const externalId = `rcplain${i}`
    const email = `realclockplain${i}@example.com`
    await H.seedContact({ externalId, email, tags: [], fields: {} })
    await H.seedTemplate({ slug: `rc-plain-${i}`, subject: 'plain' })
    await H.seedFlow({
      slug: `rc-plain-flow-${i}`,
      eventName: `RealClockPlain${i}`,
      steps: [step.send(`rc-plain-${i}`)],
    })
    H.mailer.registerEvent({ name: `RealClockPlain${i}`, dedupePolicy: 'every-time' })
    await H.mailer.fire(`RealClockPlain${i}`, externalId)
    await H.drain()

    expect(H.provider.toRecipient(email)).toHaveLength(1)
  }, 60_000)
})

describe('contact timezone against the real clock', () => {
  it('two contacts 25 hours apart are never on the same calendar day', () => {
    // A property of the zones, not of our code — asserted so that a tzdata
    // change which invalidates the premise fails loudly here rather than
    // silently weakening the test below.
    const now = new Date()
    expect(dateIn(now, AHEAD)).not.toBe(dateIn(now, BEHIND))
  })

  it('resolves the same daily slot to different instants per contact timezone', async () => {
    const ahead = await fireWindowedSend({
      delivery: { timeOfDay: '09:00', useContactTimezone: true },
      timezone: AHEAD,
    })
    const behind = await fireWindowedSend({
      delivery: { timeOfDay: '09:00', useContactTimezone: true },
      timezone: BEHIND,
    })

    const aheadRun = await ahead.run()
    const behindRun = await behind.run()

    // Whichever way the current hour falls, at most one of them can be inside
    // its 09:00 window right now — so they cannot both have sent immediately.
    expect(ahead.sentCount() + behind.sentCount()).toBeLessThan(2)

    // Each parked run must sit at 09:00 local in its OWN zone.
    for (const [run, tz, count] of [
      [aheadRun, AHEAD, ahead.sentCount()],
      [behindRun, BEHIND, behind.sentCount()],
    ] as const) {
      if (count > 0) continue // sent inside its window; nothing parked to check
      const local = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(run.nextActionAt)
      expect(local.replace(/^24/, '00')).toBe('09:00')
    }
  }, 60_000)

  it('an invalid contact timezone never throws, it falls back', async () => {
    const f = await fireWindowedSend({
      delivery: { weekdaysOnly: true, useContactTimezone: true },
      timezone: 'Not/AZone',
    })
    // Either sent or parked — the only unacceptable outcome is a failed run.
    const run = await f.run()
    expect(['active', 'completed']).toContain(run.status)
  }, 60_000)
})
