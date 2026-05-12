import { describe, it, expect } from 'vitest'
import { locateStep } from '../../src/server/runner/step.js'
import type { FlowStep } from '../../src/shared/types.js'

describe('locateStep', () => {
  const steps: FlowStep[] = [
    { type: 'wait', value: 1, unit: 'days' },
    {
      type: 'branch',
      test: { hasTag: 'vip' },
      ifTrueSteps: [
        { type: 'send', templateSlug: 'vip-1' },
        { type: 'send', templateSlug: 'vip-2' },
      ],
      ifFalseSteps: [{ type: 'send', templateSlug: 'normal' }],
    },
    { type: 'exit' },
  ]

  it('returns a top-level step at the given index', () => {
    expect(locateStep(steps, 0, [])).toEqual({ type: 'wait', value: 1, unit: 'days' })
    expect(locateStep(steps, 2, [])).toEqual({ type: 'exit' })
  })

  it('descends into the true branch', () => {
    expect(locateStep(steps, 0, [1, 'true', 0])).toEqual({ type: 'send', templateSlug: 'vip-1' })
    expect(locateStep(steps, 1, [1, 'true', 0])).toEqual({ type: 'send', templateSlug: 'vip-2' })
  })

  it('descends into the false branch', () => {
    expect(locateStep(steps, 0, [1, 'false', 0])).toEqual({ type: 'send', templateSlug: 'normal' })
  })

  it('returns null past the end of the array', () => {
    expect(locateStep(steps, 99, [])).toBeNull()
  })

  it('returns null for an invalid path', () => {
    expect(locateStep(steps, 0, [0, 'true', 0])).toBeNull() // step 0 isn't a branch
  })
})
