import { describe, expect, it } from 'vitest'
import { policyChips, windowChip, sunsetChip, gapChip } from '../../../src/client/screens/program-board/policy-format'
import { action, def } from './fixtures'

describe('policy chips', () => {
  it('formats the window', () => {
    expect(windowChip({ weekdaysOnly: true, timeOfDay: '10:00', timezone: 'America/New_York' })).toMatchObject({
      value: 'Wkdays 10:00',
      tip: 'Delivery window: weekdays at 10:00 America/New_York',
    })
    expect(windowChip({ timeOfDay: '10:00' })!.value).toBe('10:00')
    expect(windowChip({ weekdaysOnly: true })!.value).toBe('Wkdays')
    expect(windowChip({ timeOfDay: '09:30', useContactTimezone: true, timezone: 'UTC' })!.tip).toBe(
      "Delivery window: every day at 09:30 in the contact's timezone (fallback UTC)",
    )
    expect(windowChip({})).toBeNull()
    expect(windowChip(undefined)).toBeNull()
  })

  it('formats sunset as "slow · ask"', () => {
    expect(sunsetChip({ slowAfter: 3, slowFactor: 2, askAfter: 6, askTemplateSlug: 'x' })).toMatchObject({
      value: '3 · 6',
      tip: 'Slows after 3 unanswered (×2), asks after 6',
    })
  })

  it('formats the gap', () => {
    expect(gapChip(3)).toMatchObject({ value: '3d', tip: 'Min gap between emails: 3 days' })
    expect(gapChip(1).tip).toBe('Min gap between emails: 1 day')
    expect(gapChip(0.5).value).toBe('0.5d')
  })

  it('shows only the settings that are set', () => {
    const bare = policyChips(def([action('a', 1, ['x'])]))
    expect(bare.map((c) => c.key)).toEqual(['gap', 'recipients', 'entry'])
    const full = policyChips(
      def([action('a', 1, ['x'])], {
        holdoutPct: 10,
        recipients: 'owners',
        exit: { eventNames: ['Account Upgraded', 'Account Cancelled'], onComplete: { fireEvent: 'Activated' } },
        policy: {
          minGapDays: 3,
          delivery: { weekdaysOnly: true, timeOfDay: '10:00' },
          suppressIfSessionWithinHours: 12,
          sunset: { slowAfter: 3, slowFactor: 2, askAfter: 6, askTemplateSlug: 'ask' },
        },
      }),
    )
    expect(full.map((c) => [c.key, c.value])).toEqual([
      ['gap', '3d'],
      ['window', 'Wkdays 10:00'],
      ['quiet', '12h'],
      ['sunset', '3 · 6'],
      ['holdout', '10%'],
      ['recipients', 'Owners'],
      ['entry', 'Account Created'],
      ['exit', '2'],
      ['complete', 'Activated'],
    ])
    expect(full.find((c) => c.key === 'exit')!.tip).toBe('Exits on: Account Upgraded, Account Cancelled')
    expect(full.find((c) => c.key === 'quiet')!.tip).toBe('Quiet for 12 h after a session')
    expect(full.find((c) => c.key === 'holdout')!.tip).toBe('Holdout: 10% get nothing')
    expect(full.find((c) => c.key === 'entry')!.tip).toBe('Enters on "Account Created"')
    expect(full.find((c) => c.key === 'complete')!.tip).toBe('Fires "Activated" on completion')
  })
})
