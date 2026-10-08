/** outlinePredicate / outlineText — the board's condition tooltips. */

import { describe, expect, it } from 'vitest'

import { outlinePredicate, outlineText } from '../../src/shared/program-board.js'
import type { Predicate } from '../../src/shared/types.js'

const o = (p: unknown) => outlinePredicate(p as Predicate)
const text = (p: unknown) => (o(p).kind === 'line' ? (o(p) as any).text : null)

describe('lines', () => {
  it.each([
    [{ fact: 'sells_products_online' }, 'sells products online: yes'],
    [{ fact: 'agent_connected', equals: true }, 'agent connected: yes'],
    [{ fact: 'access_lapsed', equals: false }, 'access lapsed: no'],
    [{ fact: 'business_type', equals: 'ecommerce' }, 'business type is ecommerce'],
    [{ fact: 'business_type', equals: null }, 'business type is empty'],
    [{ fact: 'business_type', in: ['saas', 'agency', 'local'] }, 'business type is saas, agency or local'],
    [{ fact: 'business_type', exists: true }, 'business type is set'],
    [{ fact: 'business_type', exists: false }, 'business type is not set'],
    [{ fact: 'playbooks_run', gte: 1 }, 'playbooks run is at least 1'],
    [{ fact: 'playbooks_run', lte: 5 }, 'playbooks run is at most 5'],
    [{ fact: 'playbooks_run', gte: 1, lte: 5 }, 'playbooks run is between 1 and 5'],
    [{ fact: 'signup_at', gte: '2026-01-01' }, 'signup at is on or after 2026-01-01'],
    [{ hasFiredEvent: 'Upgraded' }, '"Upgraded" happened'],
    [{ hasFiredEvent: 'Upgraded', withinDays: 7 }, '"Upgraded" happened in the last 7 days'],
    [{ notHasFiredEvent: 'Upgraded', withinDays: 1 }, '"Upgraded" hasn\'t happened in the last day'],
  ])('%j → %s', (p, want) => {
    expect(text(p)).toBe(want)
  })
})

describe('negation folds into the condition', () => {
  it.each([
    [{ not: { fact: 'access_lapsed' } }, 'access lapsed: no'],
    [{ not: { fact: 'access_lapsed', equals: false } }, 'access lapsed: yes'],
    [{ not: { fact: 'business_type', exists: true } }, 'business type is not set'],
    [{ not: { fact: 'business_type', equals: 'saas' } }, 'business type is not saas'],
    [{ not: { fact: 'business_type', in: ['saas', 'local'] } }, 'business type is not saas or local'],
    [{ not: { fact: 'playbooks_run', gte: 1 } }, 'playbooks run is below 1'],
    [{ not: { hasFiredEvent: 'Upgraded' } }, '"Upgraded" hasn\'t happened'],
    [{ not: { not: { fact: 'a' } } }, 'a: yes'],
  ])('%j → %s', (p, want) => {
    expect(text(p)).toBe(want)
  })

  it('not(any) is "none of", not(all) is "not all of"', () => {
    expect(o({ not: { any: [{ fact: 'a' }, { fact: 'b' }] } })).toEqual({
      kind: 'group',
      mode: 'none',
      items: [{ kind: 'line', text: 'a: yes' }, { kind: 'line', text: 'b: yes' }],
    })
    expect((o({ not: { all: [{ fact: 'a' }, { fact: 'b' }] } }) as any).mode).toBe('not-all')
  })
})

describe('groups', () => {
  it('the real activation eligibility', () => {
    const p = {
      all: [
        { fact: 'access_lapsed', equals: false },
        { any: [{ not: { fact: 'business_type', exists: true } }, { fact: 'sells_products_online', equals: true }] },
      ],
    }
    expect(o(p)).toEqual({
      kind: 'group',
      mode: 'all',
      items: [
        { kind: 'line', text: 'access lapsed: no' },
        {
          kind: 'group',
          mode: 'any',
          items: [
            { kind: 'line', text: 'business type is not set' },
            { kind: 'line', text: 'sells products online: yes' },
          ],
        },
      ],
    })
    expect(outlineText('Sent only if', o(p))).toBe(
      [
        'Sent only if all of:',
        '• access lapsed: no',
        '• one of:',
        '  – business type is not set',
        '  – sells products online: yes',
      ].join('\n'),
    )
  })

  it('merges nested groups of the same kind and unwraps single children', () => {
    expect(o({ all: [{ fact: 'a' }, { all: [{ fact: 'b' }, { fact: 'c' }] }] })).toEqual({
      kind: 'group',
      mode: 'all',
      items: ['a', 'b', 'c'].map((x) => ({ kind: 'line', text: `${x}: yes` })),
    })
    expect(o({ any: [{ fact: 'a' }] })).toEqual({ kind: 'line', text: 'a: yes' })
    expect(o({ all: [] })).toEqual({ kind: 'line', text: 'always' })
    expect(o({ any: [] })).toEqual({ kind: 'line', text: 'never' })
  })

  it('a single condition reads "Title: condition"', () => {
    expect(outlineText('Done when', o({ fact: 'agent_connected' }))).toBe('Done when: agent connected: yes')
  })

  it('several operators on one fact become an all-of group', () => {
    expect(o({ fact: 'n', exists: true, gte: 2 })).toEqual({
      kind: 'group',
      mode: 'all',
      items: [{ kind: 'line', text: 'n is at least 2' }, { kind: 'line', text: 'n is set' }],
    })
  })
})

// plans/17-cadence-controls.md F1 — relative-time leaves.
describe('relative time', () => {
  it.each([
    [{ fact: 'signed_up_at', minAgeDays: 3 }, 'signed up at least 3 days ago'],
    [{ fact: 'signed_up_at', maxAgeDays: 7 }, 'signed up in the last 7 days'],
    [{ fact: 'signed_up_at', minAgeDays: 3, maxAgeDays: 7 }, 'signed up between 3 and 7 days ago'],
    [{ fact: 'trial_started_on', minAgeDays: 1 }, 'trial started at least 1 day ago'],
    [{ fact: 'created_date', maxAgeDays: 1 }, 'created in the last day'],
    [{ sinceEntry: { minDays: 3 } }, 'at least 3 days into the program'],
    [{ sinceEntry: { maxDays: 7 } }, 'in the first 7 days of the program'],
    [{ sinceEntry: { minDays: 3, maxDays: 7 } }, 'between 3 and 7 days into the program'],
    [{ sinceEntry: { maxDays: 1 } }, 'in the first day of the program'],
    [{ not: { fact: 'signed_up_at', minAgeDays: 3 } }, 'signed up less than 3 days ago'],
    [{ not: { fact: 'signed_up_at', maxAgeDays: 7 } }, 'signed up 7 or more days ago'],
    [{ not: { fact: 'signed_up_at', minAgeDays: 3, maxAgeDays: 7 } }, 'signed up not between 3 and 7 days ago'],
    [{ not: { sinceEntry: { minDays: 3 } } }, 'less than 3 days into the program'],
    [{ not: { sinceEntry: { maxDays: 7 } } }, 'after the first 7 days of the program'],
    [{ not: { sinceEntry: { minDays: 3, maxDays: 7 } } }, 'not between 3 and 7 days into the program'],
  ])('%j → %s', (p, want) => {
    expect(text(p)).toBe(want)
  })

  it('an age operator beside another operator becomes its own line', () => {
    expect(o({ fact: 'signed_up_at', exists: true, minAgeDays: 3 })).toEqual({
      kind: 'group',
      mode: 'all',
      items: [{ kind: 'line', text: 'signed up at is set' }, { kind: 'line', text: 'signed up at least 3 days ago' }],
    })
  })

  it('reads inside a group', () => {
    expect(outlineText('Sent only if', o({ all: [{ sinceEntry: { minDays: 2 } }, { fact: 'access_lapsed', equals: false }] }))).toBe(
      'Sent only if all of:\n• at least 2 days into the program\n• access lapsed: no',
    )
  })
})
