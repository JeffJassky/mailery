/** Board chips for plans/17: the usual-hour window and the progress gap. */

import { describe, expect, it } from 'vitest'

import { policyChips, progressChip, windowChip } from '../../../src/client/screens/program-board/policy-format'
import { applyChipEdit, chipFields, EDITABLE_CHIPS } from '../../../src/client/screens/program-board/edit'
import { action, def } from './fixtures'

describe('usual-hour window chip', () => {
  it('names the usual hour, the fallback and the offset', () => {
    expect(windowChip({ weekdaysOnly: true, timeOfDay: '10:00', timezone: 'America/New_York', useSessionHour: true, sessionHourOffsetMinutes: -30 })).toEqual({
      key: 'window',
      icon: 'Calendar',
      value: 'Wkdays Usual hr',
      tip: "Delivery window: weekdays at the subject's usual hour (fallback 10:00, -30 min) America/New_York",
    })
    expect(windowChip({ timeOfDay: '10:00', useSessionHour: true })).toMatchObject({
      value: 'Usual hr',
      tip: "Delivery window: every day at the subject's usual hour (fallback 10:00)",
    })
    expect(windowChip({ useSessionHour: true, sessionHourOffsetMinutes: 45 })).toMatchObject({
      value: 'Usual hr',
      tip: "Delivery window: every day at the subject's usual hour (+45 min)",
    })
  })
  it('a plain window is unchanged', () => {
    expect(windowChip({ weekdaysOnly: true, timeOfDay: '10:00', timezone: 'America/New_York' })).toMatchObject({
      value: 'Wkdays 10:00',
      tip: 'Delivery window: weekdays at 10:00 America/New_York',
    })
    expect(windowChip({ useSessionHour: false })).toBeNull()
  })
  it('the window popover edits the two new fields', () => {
    const d = def([action('a', 10, ['t'])], { policy: { minGapDays: 3, delivery: { timeOfDay: '10:00' } } })
    const fields = chipFields('window', d)
    expect(fields.map((f) => [f.name, f.kind, f.value])).toEqual([
      ['weekdays', 'bool', ''],
      ['time', 'time', '10:00'],
      ['useSessionHour', 'bool', ''],
      ['sessionHourOffsetMinutes', 'number', ''],
    ])
    const on = applyChipEdit(d, 'window', { weekdays: '', time: '10:00', useSessionHour: '1', sessionHourOffsetMinutes: '-30' })
    expect(on.policy.delivery).toEqual({ timeOfDay: '10:00', useSessionHour: true, sessionHourOffsetMinutes: -30 })
    const off = applyChipEdit(on, 'window', { weekdays: '', time: '10:00', useSessionHour: '', sessionHourOffsetMinutes: '' })
    expect(off.policy.delivery).toEqual({ timeOfDay: '10:00' })
    expect(applyChipEdit(d, 'window', { weekdays: '', time: '10:00', useSessionHour: '1', sessionHourOffsetMinutes: '900' })).toBe(d)
    expect(applyChipEdit(d, 'window', { weekdays: '', time: '10:00', useSessionHour: '1', sessionHourOffsetMinutes: '1.5' })).toBe(d)
  })
})

describe('progress chip', () => {
  it('formats the gap after progress', () => {
    expect(progressChip(1)).toEqual({ key: 'progress', icon: 'Rocket', value: '1d', tip: 'Gap after progress: 1 day' })
    expect(progressChip(2.5)).toMatchObject({ value: '2.5d', tip: 'Gap after progress: 2.5 days' })
    expect(progressChip(undefined)).toBeNull()
  })
  it('appears right after the gap chip, only when set', () => {
    const with_ = def([action('a', 10, ['t'])], { policy: { minGapDays: 5, progressGapDays: 1 } })
    expect(policyChips(with_).map((c) => c.key).slice(0, 2)).toEqual(['gap', 'progress'])
    const without = def([action('a', 10, ['t'])])
    expect(policyChips(without).map((c) => c.key)).not.toContain('progress')
  })
  it('is editable: a number field; empty removes the key; negative is rejected', () => {
    expect(EDITABLE_CHIPS.has('progress')).toBe(true)
    const d = def([action('a', 10, ['t'])], { policy: { minGapDays: 5, progressGapDays: 1 } })
    expect(chipFields('progress', d)).toEqual([{ name: 'days', kind: 'number', value: '1', label: 'Gap after progress (days)' }])
    expect(applyChipEdit(d, 'progress', { days: '2' }).policy.progressGapDays).toBe(2)
    expect(applyChipEdit(d, 'progress', { days: '' }).policy).toEqual({ minGapDays: 5 })
    expect(applyChipEdit(d, 'progress', { days: '0' }).policy).toEqual({ minGapDays: 5 })
    expect(applyChipEdit(d, 'progress', { days: '-1' })).toBe(d)
    expect(applyChipEdit(d, 'progress', { days: 'x' })).toBe(d)
  })
})
