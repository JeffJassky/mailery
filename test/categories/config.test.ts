/** 0.21 config keys are validated at init; unset keys are no-ops. */

import { describe, expect, it } from 'vitest'

import { assertValidCategories, assertValidContactPolicy } from '../../src/server/config.js'

describe('assertValidCategories', () => {
  it('accepts undefined and a well-formed list', () => {
    expect(() => assertValidCategories(undefined)).not.toThrow()
    expect(() =>
      assertValidCategories([
        { id: 'lifecycle.onboarding', label: 'Tips' },
        { id: 'product-updates', label: 'Updates', description: 'x', defaultOptIn: true },
      ]),
    ).not.toThrow()
  })
  it.each([
    [[{ id: 'Bad.Id', label: 'x' }], 'lowercase'],
    [[{ id: 'a..b', label: 'x' }], 'lowercase'],
    [[{ id: 'x'.repeat(65), label: 'x' }], '64'],
    [[{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }], 'twice'],
    [[{ id: 'a', label: '' }], 'label'],
    [[{ id: 'a', label: 'x', defaultOptIn: false }], 'defaultOptIn'],
  ])('rejects %j', (cats, msg) => {
    expect(() => assertValidCategories(cats as any)).toThrow(msg)
  })
})

describe('assertValidContactPolicy', () => {
  it('accepts undefined and the spec example', () => {
    expect(() => assertValidContactPolicy(undefined)).not.toThrow()
    expect(() =>
      assertValidContactPolicy({
        marketing: {
          minGapHours: 20,
          maxPerRollingDays: { days: 7, count: 3 },
          quietHours: { start: '21:00', end: '08:00' },
          deferral: { maxHours: 72 },
          defaultTimezone: 'America/New_York',
        },
        sourcePriority: ['transactional', 'flow', 'broadcast', 'program'],
      }),
    ).not.toThrow()
  })
  it.each([
    [{ marketing: { minGapHours: 0 } }, 'minGapHours'],
    [{ marketing: { maxPerRollingDays: { days: 7, count: 0 } } }, 'count'],
    [{ marketing: { quietHours: { start: '9pm', end: '08:00' } } }, 'HH:mm'],
    [{ marketing: { quietHours: { start: '08:00', end: '08:00' } } }, 'differ'],
    [{ marketing: { defaultTimezone: 'Mars/Olympus' } }, 'IANA'],
    [{ marketing: { deferral: { maxHours: -1 } } }, 'maxHours'],
    [{ sourcePriority: ['flow', 'email'] }, 'unknown'],
    [{ sourcePriority: ['flow', 'flow'] }, 'duplicates'],
  ])('rejects %j', (policy, msg) => {
    expect(() => assertValidContactPolicy(policy as any)).toThrow(msg)
  })
})
