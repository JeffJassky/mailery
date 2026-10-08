/** diffProgramDefinitions — plans/16-program-board.md §6. */

import { describe, expect, it } from 'vitest'

import { diffProgramDefinitions } from '../../src/shared/program-board.js'
import { buildProgram } from '../../src/testing/index.js'
import type { ProgramDefinition } from '../../src/shared/types.js'

const base = (): ProgramDefinition =>
  buildProgram({
    slug: 'p',
    holdoutPct: 10,
    exit: { eventNames: ['Upgraded'] },
    policy: { minGapDays: 3, sunset: { slowAfter: 3, slowFactor: 2, askAfter: 6, askTemplateSlug: 'ask' } },
    actions: [
      { id: 'a', title: 'A', priority: 100, attempts: 3, satisfied: { fact: 'a_done' } },
      { id: 'b', title: 'B', priority: 90, attempts: 2, satisfied: { fact: 'b_done' } },
    ],
  })
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

describe('diffProgramDefinitions', () => {
  it('identical definitions (even with different key order) are unchanged', () => {
    const a = base()
    const b = clone(a)
    b.actions[0] = Object.fromEntries(Object.entries(b.actions[0]!).reverse()) as any
    expect(diffProgramDefinitions(a, b)).toEqual({ changed: false, fields: [], actions: {} })
  })

  it('reports action field changes, attempts per 0-based index', () => {
    const a = base()
    const b = clone(a)
    b.actions[0]!.priority = 95
    b.actions[0]!.attempts[1]!.deliveries[0]!.templateSlug = 'a-2b'
    b.actions[1]!.attempts.push({ deliveries: [{ channel: 'email', templateSlug: 'b-3' }] })
    b.actions[1]!.eligible = { fact: 'x' }
    const r = diffProgramDefinitions(a, b)
    expect(r.changed).toBe(true)
    expect(r.fields).toEqual([])
    expect(r.actions.a).toEqual({ kind: 'changed', fields: ['attempts.1', 'priority'] })
    expect(r.actions.b).toEqual({ kind: 'changed', fields: ['attempts.2', 'eligible'] })
  })

  it('field lists are sorted', () => {
    const a = base()
    const b = clone(a)
    b.actions[0]!.title = 'A2'
    b.actions[0]!.cooldownDays = 30
    b.actions[0]!.attempts[0]!.minGapDays = 5
    expect(diffProgramDefinitions(a, b).actions.a!.fields).toEqual(['attempts.0', 'cooldownDays', 'title'])
  })

  it('added and removed actions', () => {
    const a = base()
    const b = clone(a)
    b.actions.splice(1, 1)
    b.actions.push({ ...clone(a.actions[0]!), id: 'c' })
    const r = diffProgramDefinitions(a, b)
    expect(r.actions).toEqual({ b: { kind: 'removed', fields: [] }, c: { kind: 'added', fields: [] } })
  })

  it('reordering actions without changing them is not a change', () => {
    const a = base()
    const b = clone(a)
    b.actions.reverse()
    expect(diffProgramDefinitions(a, b).changed).toBe(false)
  })

  it('policy, entry and exit report one level down; other keys at the top', () => {
    const a = base()
    const b = clone(a)
    b.policy.minGapDays = 4
    b.policy.sunset!.askAfter = 5
    b.policy.delivery = { weekdaysOnly: true }
    b.exit.onComplete = { fireEvent: 'Activated' }
    b.holdoutPct = 20
    b.name = 'Renamed'
    expect(diffProgramDefinitions(a, b).fields).toEqual([
      'exit.onComplete',
      'holdoutPct',
      'name',
      'policy.delivery',
      'policy.minGapDays',
      'policy.sunset',
    ])
  })

  it('a null side: everything added / removed', () => {
    const a = base()
    const added = diffProgramDefinitions(null, a)
    expect(added.changed).toBe(true)
    expect(added.actions).toEqual({ a: { kind: 'added', fields: [] }, b: { kind: 'added', fields: [] } })
    const removed = diffProgramDefinitions(a, null)
    expect(removed.actions).toEqual({ a: { kind: 'removed', fields: [] }, b: { kind: 'removed', fields: [] } })
    expect(diffProgramDefinitions(null, null)).toEqual({ changed: false, fields: [], actions: {} })
  })
})
