/**
 * describePredicate — plans/16-program-board.md §5. These strings are the
 * contract: the board shows them in tooltips.
 */

import { describe, expect, it } from 'vitest'

import { describePredicate } from '../../src/shared/program-board.js'
import type { Predicate } from '../../src/shared/types.js'

const d = (p: unknown) => describePredicate(p as Predicate)

describe('fact leaves', () => {
  it.each([
    [{ fact: 'agent_connected' }, 'agent_connected'],
    [{ fact: 'agent_connected', equals: true }, 'agent_connected'],
    [{ fact: 'agent_connected', equals: false }, 'not agent_connected'],
    [{ fact: 'business_type', equals: 'ecommerce' }, 'business_type = ecommerce'],
    [{ fact: 'playbooks_run', equals: 3 }, 'playbooks_run = 3'],
    [{ fact: 'business_type', equals: null }, 'business_type is empty'],
    [{ fact: 'playbooks_run', gte: 1 }, 'playbooks_run ≥ 1'],
    [{ fact: 'playbooks_run', lte: 5 }, 'playbooks_run ≤ 5'],
    [{ fact: 'playbooks_run', gte: 1, lte: 5 }, '1 ≤ playbooks_run ≤ 5'],
    [{ fact: 'signup_at', gte: '2026-01-01' }, 'signup_at ≥ 2026-01-01'],
    [{ fact: 'business_type', in: ['saas'] }, 'business_type = saas'],
    [{ fact: 'business_type', in: ['saas', 'agency'] }, 'business_type is saas or agency'],
    [{ fact: 'business_type', in: ['saas', 'agency', 'local'] }, 'business_type is saas, agency or local'],
    [{ fact: 'business_type', exists: true }, 'business_type is set'],
    [{ fact: 'business_type', exists: false }, 'business_type is not set'],
  ])('%j → %s', (p, want) => {
    expect(d(p)).toBe(want)
  })

  it('joins several operators on one leaf with "and" (equals, in, range, exists)', () => {
    expect(d({ fact: 'n', exists: true, gte: 2 })).toBe('n ≥ 2 and n is set')
  })
})

describe('not', () => {
  it.each([
    [{ not: { fact: 'a' } }, 'not a'],
    [{ not: { fact: 'a', equals: true } }, 'not a'],
    [{ not: { fact: 'a', equals: false } }, 'a'],
    [{ not: { fact: 'a', exists: true } }, 'a is not set'],
    [{ not: { fact: 'a', exists: false } }, 'a is set'],
    [{ not: { fact: 'n', gte: 1 } }, 'not (n ≥ 1)'],
    [{ not: { any: [{ fact: 'a' }, { fact: 'b' }] } }, 'not (a or b)'],
    [{ not: { hasFiredEvent: 'Upgraded' } }, 'Upgraded hasn\'t happened'],
  ])('%j → %s', (p, want) => {
    expect(d(p)).toBe(want)
  })
})

describe('all / any', () => {
  it('joins with and / or, parenthesising the other kind when it has 2+ parts', () => {
    expect(d({ all: [{ fact: 'a' }, { fact: 'b' }] })).toBe('a and b')
    expect(d({ any: [{ fact: 'a' }, { fact: 'b' }] })).toBe('a or b')
    expect(d({ all: [{ fact: 'a' }, { any: [{ fact: 'b' }, { fact: 'c' }] }] })).toBe('a and (b or c)')
    expect(d({ any: [{ all: [{ fact: 'a' }, { fact: 'b' }] }, { fact: 'c' }] })).toBe('(a and b) or c')
    expect(d({ all: [{ fact: 'a' }, { all: [{ fact: 'b' }, { fact: 'c' }] }] })).toBe('a and b and c')
  })

  it('a single-element group is its child; empty groups are always / never', () => {
    expect(d({ all: [{ fact: 'a' }] })).toBe('a')
    expect(d({ any: [{ any: [{ fact: 'a' }, { fact: 'b' }] }] })).toBe('a or b')
    expect(d({ all: [] })).toBe('always')
    expect(d({ any: [] })).toBe('never')
  })

  it('the real activation eligibility reads naturally', () => {
    expect(
      d({
        all: [
          { fact: 'access_lapsed', equals: false },
          { any: [{ not: { fact: 'business_type', exists: true } }, { fact: 'sells_products_online', equals: true }] },
        ],
      }),
    ).toBe('not access_lapsed and (business_type is not set or sells_products_online)')
  })
})

describe('events', () => {
  it.each([
    [{ hasFiredEvent: 'Upgraded' }, 'Upgraded happened'],
    [{ hasFiredEvent: 'Upgraded', withinDays: 1 }, 'Upgraded happened in the last day'],
    [{ hasFiredEvent: 'Upgraded', withinDays: 7 }, 'Upgraded happened in the last 7 days'],
    [{ notHasFiredEvent: 'Upgraded' }, 'Upgraded hasn\'t happened'],
    [{ notHasFiredEvent: 'Upgraded', withinDays: 30 }, 'Upgraded hasn\'t happened in the last 30 days'],
  ])('%j → %s', (p, want) => {
    expect(d(p)).toBe(want)
  })
})

it('an unknown leaf falls back to its JSON', () => {
  expect(d({ hasTag: 'vip' })).toBe('{"hasTag":"vip"}')
})
