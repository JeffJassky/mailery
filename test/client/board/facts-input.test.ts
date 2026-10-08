import { describe, expect, it } from 'vitest'
import { controlValue, fromLocalInput, hasOverrides, setOverride, toLocalInput } from '../../../src/client/screens/program-board/facts-input'

describe('facts input', () => {
  it('round-trips date-time inputs', () => {
    const iso = '2026-10-08T14:30:00.000Z'
    const local = toLocalInput(iso)
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(fromLocalInput(local)).toBe(iso)
    expect(fromLocalInput('')).toBeNull()
    expect(toLocalInput(null)).toBe('')
    expect(toLocalInput('nope')).toBe('')
  })

  it('sets and clears overrides by type', () => {
    let o = setOverride({}, 'paid', { type: 'boolean' }, 'yes')
    expect(o).toEqual({ paid: true })
    o = setOverride(o, 'seats', { type: 'number' }, '4')
    o = setOverride(o, 'plan', { type: 'enum', values: ['a', 'b'] }, 'b')
    o = setOverride(o, 'note', { type: 'string' }, 'hi')
    expect(o).toEqual({ paid: true, seats: 4, plan: 'b', note: 'hi' })
    expect(setOverride(o, 'paid', { type: 'boolean' }, 'no').paid).toBe(false)
    const cleared = setOverride(o, 'paid', { type: 'boolean' }, '')
    expect('paid' in cleared).toBe(false)
    expect(hasOverrides(cleared)).toBe(true)
    expect(hasOverrides({})).toBe(false)
  })

  it('ignores a non-numeric number and an invalid date', () => {
    expect(setOverride({}, 'n', { type: 'number' }, 'abc')).toEqual({})
    expect(setOverride({}, 'd', { type: 'date' }, 'garbage')).toEqual({})
    const iso = fromLocalInput('2026-10-08T09:00')!
    expect(setOverride({}, 'd', { type: 'date' }, '2026-10-08T09:00')).toEqual({ d: iso })
  })

  it('control value prefers the override, falls back to the resolved fact', () => {
    expect(controlValue({ type: 'boolean' }, undefined, true)).toBe('yes')
    expect(controlValue({ type: 'boolean' }, false, true)).toBe('no')
    expect(controlValue({ type: 'boolean' }, undefined, undefined)).toBe('')
    expect(controlValue({ type: 'number' }, undefined, 3)).toBe('3')
    expect(controlValue({ type: 'string' }, undefined, null)).toBe('')
    expect(controlValue({ type: 'date' }, undefined, '2026-10-08T14:30:00.000Z')).toBe(toLocalInput('2026-10-08T14:30:00.000Z'))
  })
})
