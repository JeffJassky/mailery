/**
 * Pure parts of `wait_until` (plans/19): schema, misconfiguration codes,
 * subject lookup, target arithmetic, wake cap, publish validation.
 */

import { describe, expect, it } from 'vitest'

import { flowStepSchema } from '../../src/shared/schemas.js'
import { defaultFlowStep, FLOW_STEP_KINDS } from '../../src/shared/options.js'
import { assertValidFlowWaitUntilRecheckHours, resolveConfig } from '../../src/server/config.js'
import {
  DAY_MS,
  HOUR_MS,
  validateFlowWaitUntilSteps,
  waitUntilMisconfiguration,
  waitUntilSubject,
  waitUntilTarget,
  waitUntilWakeAt,
} from '../../src/server/runner/wait-until.js'
import type { FactDecl } from '../../src/shared/types.js'

const DECLARE: Record<string, FactDecl> = {
  trial_ends_at: { type: 'date' },
  plan: { type: 'string' },
}
const ok = { type: 'wait_until', fact: 'trial_ends_at', subjectFrom: 'accountId' }
const END = new Date('2026-03-12T09:00:00Z')

describe('flowStepSchema: wait_until', () => {
  it.each([
    ok,
    { ...ok, offsetDays: -3 },
    { ...ok, offsetDays: 1.5 },
    { ...ok, offsetDays: 0, ifMissing: 'continue' },
    { ...ok, ifMissing: 'exit' },
  ])('accepts %j', (s) => {
    expect(flowStepSchema.safeParse(s).success).toBe(true)
  })

  it.each([
    { ...ok, fact: '' },
    { ...ok, subjectFrom: '' },
    { type: 'wait_until', subjectFrom: 'accountId' },
    { type: 'wait_until', fact: 'trial_ends_at' },
    { ...ok, offsetDays: Number.POSITIVE_INFINITY },
    { ...ok, offsetDays: '-3' },
    { ...ok, ifMissing: 'skip' },
  ])('rejects %j', (s) => {
    expect(flowStepSchema.safeParse(s).success).toBe(false)
  })
})

describe('options', () => {
  it('lists the kind and has a default that parses', () => {
    expect(FLOW_STEP_KINDS.some((k) => k.value === 'wait_until')).toBe(true)
    const d = defaultFlowStep('wait_until')
    expect(d.type).toBe('wait_until')
    // The default is an empty draft (no fact chosen yet), so it is NOT publishable as is.
    expect(flowStepSchema.safeParse(d).success).toBe(false)
  })
})

describe('config: flowWaitUntilRecheckHours', () => {
  it('defaults to 24', () => {
    expect(resolveConfig({} as never).flowWaitUntilRecheckHours).toBe(24)
    expect(resolveConfig({ flowWaitUntilRecheckHours: 6 } as never).flowWaitUntilRecheckHours).toBe(6)
  })
  it.each([1, 1.5, 24, 168])('accepts %s', (h) => {
    expect(() => assertValidFlowWaitUntilRecheckHours(h)).not.toThrow()
  })
  it('accepts unset', () => {
    expect(() => assertValidFlowWaitUntilRecheckHours(undefined)).not.toThrow()
  })
  it.each([0, 0.99, -5, Number.NaN, Number.POSITIVE_INFINITY, '24'])('rejects %s', (h) => {
    expect(() => assertValidFlowWaitUntilRecheckHours(h as never)).toThrow(/flowWaitUntilRecheckHours/)
  })
})

describe('waitUntilMisconfiguration', () => {
  it('null for a valid step', () => {
    expect(waitUntilMisconfiguration(ok, DECLARE)).toBeNull()
    expect(waitUntilMisconfiguration({ ...ok, offsetDays: -1.5, ifMissing: 'continue' }, DECLARE)).toBeNull()
  })
  it.each([
    [{ ...ok, fact: 7 }, 'invalid_fact'],
    [{ ...ok, fact: '' }, 'invalid_fact'],
    [{ ...ok, subjectFrom: undefined }, 'invalid_subject_from'],
    [{ ...ok, subjectFrom: '' }, 'invalid_subject_from'],
    [{ ...ok, offsetDays: '1' }, 'invalid_offset_days'],
    [{ ...ok, offsetDays: Number.NaN }, 'invalid_offset_days'],
    [{ ...ok, ifMissing: 'skip' }, 'invalid_if_missing'],
    [{ ...ok, fact: 'nope' }, 'fact_not_declared'],
    [{ ...ok, fact: 'plan' }, 'fact_not_date'],
  ])('%j → %s', (s, code) => {
    expect(waitUntilMisconfiguration(s, DECLARE)).toBe(code)
  })
  it('no adapter → no_facts_adapter, after the shape checks', () => {
    expect(waitUntilMisconfiguration(ok, undefined)).toBe('no_facts_adapter')
    expect(waitUntilMisconfiguration({ ...ok, fact: 7 }, undefined)).toBe('invalid_fact')
  })
  it('does not treat inherited keys as declared', () => {
    expect(waitUntilMisconfiguration({ ...ok, fact: 'toString' }, DECLARE)).toBe('fact_not_declared')
  })
})

describe('waitUntilSubject', () => {
  const run = (properties: Record<string, unknown> | undefined) =>
    ({ triggerEvent: properties ? { name: 'x', properties, occurredAt: new Date() } : null }) as never
  it('reads the named property', () => {
    expect(waitUntilSubject(run({ accountId: 'a1' }), { subjectFrom: 'accountId' })).toBe('a1')
  })
  it.each([
    [undefined],
    [{}],
    [{ accountId: '' }],
    [{ accountId: '   ' }],
    [{ accountId: 42 }],
    [{ accountId: null }],
    [{ accountId: { id: 'a1' } }],
  ])('null for %j', (props) => {
    expect(waitUntilSubject(run(props as never), { subjectFrom: 'accountId' })).toBeNull()
  })
  it('is a property name, never a template', () => {
    expect(waitUntilSubject(run({ accountId: 'a1' }), { subjectFrom: '{{event.accountId}}' })).toBeNull()
  })
})

describe('waitUntilTarget', () => {
  it.each([
    [END, undefined, END.getTime()],
    [END, 0, END.getTime()],
    [END, -3, END.getTime() - 3 * DAY_MS],
    [END, 1.5, END.getTime() + 1.5 * DAY_MS],
    [END.toISOString(), -1, END.getTime() - DAY_MS],
    [END.getTime(), 2, END.getTime() + 2 * DAY_MS],
  ])('%s %s', (value, offsetDays, expected) => {
    expect(waitUntilTarget({ fact: 'f', offsetDays: offsetDays as number | undefined }, { f: value })?.getTime()).toBe(expected)
  })
  it.each([[undefined], [null], ['soon'], [true], ['']])('null for %j', (value) => {
    expect(waitUntilTarget({ fact: 'f' }, { f: value as never })).toBeNull()
  })
})

describe('waitUntilWakeAt', () => {
  const now = new Date('2026-03-02T09:00:00Z')
  it('the target when inside the recheck window', () => {
    const target = new Date(now.getTime() + 5 * HOUR_MS)
    expect(waitUntilWakeAt(target, now, 24).getTime()).toBe(target.getTime())
  })
  it('now + recheck when the target is further out', () => {
    const target = new Date(now.getTime() + 10 * DAY_MS)
    expect(waitUntilWakeAt(target, now, 24).getTime()).toBe(now.getTime() + 24 * HOUR_MS)
    expect(waitUntilWakeAt(target, now, 6).getTime()).toBe(now.getTime() + 6 * HOUR_MS)
  })
})

describe('validateFlowWaitUntilSteps', () => {
  it('ignores every other step type, and flows without wait_until', () => {
    expect(validateFlowWaitUntilSteps([{ type: 'wait', value: 1, unit: 'days' }, { type: 'send', templateSlug: 'x' }], null)).toEqual([])
    // A malformed non-wait_until step is not this check's business (19a trap 2).
    expect(validateFlowWaitUntilSteps([{ type: 'wait', value: -1 }], DECLARE)).toEqual([])
    expect(validateFlowWaitUntilSteps([], DECLARE)).toEqual([])
  })
  it('passes a valid step', () => {
    expect(validateFlowWaitUntilSteps([{ type: 'send', templateSlug: 'x' }, ok], DECLARE)).toEqual([])
  })
  it('no adapter → one issue on the step', () => {
    const issues = validateFlowWaitUntilSteps([{ type: 'send', templateSlug: 'x' }, ok], null)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.path).toBe('steps.1')
    expect(issues[0]!.message).toMatch(/factsAdapter/)
  })
  it('undeclared fact', () => {
    const issues = validateFlowWaitUntilSteps([{ ...ok, fact: 'nope' }], DECLARE)
    expect(issues).toEqual([{ path: 'steps.0.fact', message: expect.stringMatching(/not declared/) }])
  })
  it('non-date fact', () => {
    const issues = validateFlowWaitUntilSteps([{ ...ok, fact: 'plan' }], DECLARE)
    expect(issues).toEqual([{ path: 'steps.0.fact', message: expect.stringMatching(/needs a date fact/) }])
  })
  it('shape problems carry the field path', () => {
    const issues = validateFlowWaitUntilSteps([{ ...ok, subjectFrom: '' }], DECLARE)
    expect(issues.some((i) => i.path === 'steps.0.subjectFrom')).toBe(true)
  })
  it('walks branches', () => {
    const steps = [
      {
        type: 'branch',
        test: { hasTag: 'x' },
        ifTrueSteps: [{ type: 'send', templateSlug: 'x' }, { ...ok, fact: 'nope' }],
        ifFalseSteps: [{ ...ok, fact: 'plan' }],
      },
    ]
    const paths = validateFlowWaitUntilSteps(steps, DECLARE).map((i) => i.path).sort()
    expect(paths).toEqual(['steps.0.ifFalseSteps.0.fact', 'steps.0.ifTrueSteps.1.fact'])
  })
  it('a non-array is no steps', () => {
    expect(validateFlowWaitUntilSteps(null, DECLARE)).toEqual([])
  })
})
