import { describe, expect, it } from 'vitest'

import { computeDeliveryTime } from '../../src/server/runner/delivery-window.js'

// All fixture instants are UTC. 2026-07-20 is a Monday.
const MON_10_UTC = new Date('2026-07-20T10:00:00Z')
const SAT_10_UTC = new Date('2026-07-18T10:00:00Z')
const SUN_10_UTC = new Date('2026-07-19T10:00:00Z')

describe('computeDeliveryTime — no constraints', () => {
  it('returns now unchanged for an empty window', () => {
    expect(computeDeliveryTime(MON_10_UTC, {}).toISOString()).toBe(MON_10_UTC.toISOString())
  })
})

describe('computeDeliveryTime — weekdaysOnly', () => {
  it('pushes Saturday to Monday, preserving clock time', () => {
    const out = computeDeliveryTime(SAT_10_UTC, { weekdaysOnly: true })
    expect(out.toISOString()).toBe('2026-07-20T10:00:00.000Z')
  })

  it('pushes Sunday to Monday', () => {
    const out = computeDeliveryTime(SUN_10_UTC, { weekdaysOnly: true })
    expect(out.toISOString()).toBe('2026-07-20T10:00:00.000Z')
  })

  it('leaves weekdays alone', () => {
    const out = computeDeliveryTime(MON_10_UTC, { weekdaysOnly: true })
    expect(out.toISOString()).toBe(MON_10_UTC.toISOString())
  })

  it('uses the LOCAL weekend: Sat 23:00 in Auckland is still Friday UTC', () => {
    // 2026-07-17T23:30Z = Sat 11:30 in Pacific/Auckland (UTC+12) → Monday local.
    const out = computeDeliveryTime(new Date('2026-07-17T23:30:00Z'), {
      weekdaysOnly: true,
      timezone: 'Pacific/Auckland',
    })
    // Monday 11:30 Auckland = Sunday 23:30 UTC.
    expect(out.toISOString()).toBe('2026-07-19T23:30:00.000Z')
  })
})

describe('computeDeliveryTime — timeOfDay', () => {
  it('waits for the slot later the same day', () => {
    const out = computeDeliveryTime(new Date('2026-07-20T06:00:00Z'), { timeOfDay: '09:00' })
    expect(out.toISOString()).toBe('2026-07-20T09:00:00.000Z')
  })

  it('sends immediately when within the grace period after the slot', () => {
    const now = new Date('2026-07-20T09:20:00Z')
    expect(computeDeliveryTime(now, { timeOfDay: '09:00' }).toISOString()).toBe(now.toISOString())
  })

  it('rolls to tomorrow when the slot is more than the grace period past', () => {
    const out = computeDeliveryTime(new Date('2026-07-20T14:00:00Z'), { timeOfDay: '09:00' })
    expect(out.toISOString()).toBe('2026-07-21T09:00:00.000Z')
  })

  it('interprets the slot in the given timezone', () => {
    // 09:00 in New York (EDT, UTC-4) = 13:00 UTC.
    const out = computeDeliveryTime(new Date('2026-07-20T06:00:00Z'), {
      timeOfDay: '09:00',
      timezone: 'America/New_York',
    })
    expect(out.toISOString()).toBe('2026-07-20T13:00:00.000Z')
  })

  it('prefers the contact timezone when useContactTimezone is set', () => {
    const out = computeDeliveryTime(
      new Date('2026-07-20T06:00:00Z'),
      { timeOfDay: '09:00', useContactTimezone: true, timezone: 'UTC' },
      'America/Los_Angeles', // PDT, UTC-7 → 09:00 local = 16:00 UTC
    )
    expect(out.toISOString()).toBe('2026-07-20T16:00:00.000Z')
  })

  it('falls back to the window timezone when the contact has none', () => {
    const out = computeDeliveryTime(
      new Date('2026-07-20T06:00:00Z'),
      { timeOfDay: '09:00', useContactTimezone: true, timezone: 'America/New_York' },
      undefined,
    )
    expect(out.toISOString()).toBe('2026-07-20T13:00:00.000Z')
  })

  it('falls back to UTC on an invalid contact timezone', () => {
    const out = computeDeliveryTime(
      new Date('2026-07-20T06:00:00Z'),
      { timeOfDay: '09:00', useContactTimezone: true },
      'Not/AZone',
    )
    expect(out.toISOString()).toBe('2026-07-20T09:00:00.000Z')
  })
})

describe('computeDeliveryTime — combined weekdaysOnly + timeOfDay', () => {
  it('Friday-evening send waits for Monday 09:00 (rolls past the weekend)', () => {
    // Friday 2026-07-17 14:00 UTC, slot 09:00 already past → Sat 09:00 → weekend → Mon 09:00.
    const out = computeDeliveryTime(new Date('2026-07-17T14:00:00Z'), {
      timeOfDay: '09:00',
      weekdaysOnly: true,
    })
    expect(out.toISOString()).toBe('2026-07-20T09:00:00.000Z')
  })

  it('T+N landing Saturday delivers Monday at the slot time', () => {
    const out = computeDeliveryTime(new Date('2026-07-18T03:00:00Z'), {
      timeOfDay: '09:00',
      weekdaysOnly: true,
    })
    expect(out.toISOString()).toBe('2026-07-20T09:00:00.000Z')
  })
})
