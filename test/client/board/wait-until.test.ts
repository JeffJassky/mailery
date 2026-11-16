import { describe, expect, it } from 'vitest'
import {
  dateFactNames,
  formatOffsetDays,
  parseOffsetDays,
  waitUntilLabel,
  waitUntilMeta,
} from '../../../src/client/screens/flow-wait-until'

describe('wait_until helpers', () => {
  it('summarises the offset', () => {
    expect(waitUntilLabel({ fact: 'trial_ends_at', offsetDays: -3 })).toBe('until trial_ends_at − 3d')
    expect(waitUntilLabel({ fact: 'trial_ends_at' })).toBe('until trial_ends_at')
    expect(waitUntilLabel({ fact: 'trial_ends_at', offsetDays: 0 })).toBe('until trial_ends_at')
    expect(waitUntilLabel({ fact: 'trial_ends_at', offsetDays: 1.5 })).toBe('until trial_ends_at + 1.5d')
    expect(waitUntilLabel({ fact: '' })).toBe('until (no fact)')
    expect(formatOffsetDays(NaN)).toBe('')
  })

  it('describes subject and ifMissing', () => {
    expect(waitUntilMeta({ subjectFrom: 'accountId' })).toBe('via accountId · if missing: exit')
    expect(waitUntilMeta({ subjectFrom: 'accountId', ifMissing: 'continue' })).toBe('via accountId · if missing: continue')
  })

  it('lists only date facts', () => {
    expect(dateFactNames(null)).toEqual([])
    expect(dateFactNames({ b: { type: 'date' }, a: { type: 'date' }, n: { type: 'number' } })).toEqual(['a', 'b'])
  })

  it('parses free-typed offsets', () => {
    expect(parseOffsetDays('-3')).toBe(-3)
    expect(parseOffsetDays('1.5')).toBe(1.5)
    expect(parseOffsetDays('-')).toBeUndefined()
    expect(parseOffsetDays('')).toBeUndefined()
    expect(parseOffsetDays('abc')).toBeUndefined()
  })
})
