import { describe, expect, it } from 'vitest'
import { buildRows, maxLadder, neighbour, orderedActions, SUNSET_ID } from '../../../src/client/screens/program-board/model'
import type { ProgramDiff } from '../../../src/shared/program-board'
import { action, def } from './fixtures'

describe('orderedActions', () => {
  it('sorts by priority desc, ties by definition order', () => {
    const d = def([action('a', 10, ['t']), action('b', 30, ['t']), action('c', 10, ['t']), action('d', 30, ['t'])])
    expect(orderedActions(d).map((a) => a.id)).toEqual(['b', 'd', 'a', 'c'])
  })
})

describe('buildRows', () => {
  it('one row per action with cells per attempt, sunset ask last', () => {
    const d = def([action('a', 10, ['x', 'y', 'z']), action('b', 20, ['w'])], {
      policy: { minGapDays: 3, sunset: { slowAfter: 3, slowFactor: 2, askAfter: 6, askTemplateSlug: 'ask' } },
    })
    const rows = buildRows(d)
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', SUNSET_ID])
    expect(rows[1]!.cells.map((c) => c.templateSlug)).toEqual(['x', 'y', 'z'])
    expect(rows[2]!.kind).toBe('sunset')
    expect(rows[2]!.cells[0]!.templateSlug).toBe('ask')
    expect(maxLadder(rows)).toBe(3)
  })

  it('carries per-attempt gaps', () => {
    const a = action('a', 1, ['x', 'y'])
    a.attempts[1]!.minGapDays = 7
    expect(buildRows(def([a]))[0]!.cells.map((c) => c.gapDays)).toEqual([undefined, 7])
  })

  it('flags changed rows and cells from the diff, ghosts removed actions at their old place', () => {
    const base = def([action('a', 30, ['x']), action('gone', 20, ['g']), action('b', 10, ['y', 'z'])])
    const next = def([action('a', 30, ['x']), action('b', 10, ['y', 'z2']), action('new', 5, ['n'])])
    const diff: ProgramDiff = {
      changed: true,
      fields: [],
      actions: {
        gone: { kind: 'removed', fields: [] },
        b: { kind: 'changed', fields: ['title', 'attempts.1'] },
        new: { kind: 'added', fields: [] },
      },
    }
    const rows = buildRows(next, diff, base)
    expect(rows.map((r) => r.id)).toEqual(['a', 'gone', 'b', 'new'])
    const gone = rows[1]!
    expect(gone.ghost).toBe(true)
    expect(gone.changedFields).toEqual(['removed'])
    const b = rows[2]!
    expect(b.changedFields).toEqual(['title'])
    expect(b.cells.map((c) => c.changed)).toEqual([false, true])
    expect(rows[3]!.changedFields).toEqual(['added'])
    expect(rows[3]!.cells.every((c) => c.changed)).toBe(true)
  })

  it('puts a removed top action back at the top', () => {
    const base = def([action('top', 50, ['t']), action('a', 10, ['x'])])
    const next = def([action('a', 10, ['x'])])
    const diff: ProgramDiff = { changed: true, fields: [], actions: { top: { kind: 'removed', fields: [] } } }
    expect(buildRows(next, diff, base).map((r) => r.id)).toEqual(['top', 'a'])
  })

  it('flags the sunset row when policy.sunset changed', () => {
    const d = def([action('a', 1, ['x'])], { policy: { minGapDays: 1, sunset: { slowAfter: 1, slowFactor: 2, askAfter: 2, askTemplateSlug: 'ask' } } })
    const rows = buildRows(d, { changed: true, fields: ['policy.sunset'], actions: {} }, d)
    expect(rows.at(-1)!.changedFields).toEqual(['policy.sunset'])
    expect(rows.at(-1)!.cells[0]!.changed).toBe(true)
  })
})

describe('neighbour', () => {
  const rows = buildRows(def([action('a', 3, ['x', 'y', 'z']), action('b', 2, ['w']), action('c', 1, ['u', 'v'])]))
  it('moves within a ladder', () => {
    expect(neighbour(rows, { actionId: 'a', attempt: 1 }, 'right')).toEqual({ actionId: 'a', attempt: 2 })
    expect(neighbour(rows, { actionId: 'a', attempt: 1 }, 'left')).toBeNull()
    expect(neighbour(rows, { actionId: 'a', attempt: 3 }, 'right')).toBeNull()
  })
  it('moves between rows, clamping the column', () => {
    expect(neighbour(rows, { actionId: 'a', attempt: 3 }, 'down')).toEqual({ actionId: 'b', attempt: 1 })
    expect(neighbour(rows, { actionId: 'b', attempt: 1 }, 'down')).toEqual({ actionId: 'c', attempt: 1 })
    expect(neighbour(rows, { actionId: 'c', attempt: 2 }, 'up')).toEqual({ actionId: 'b', attempt: 1 })
    expect(neighbour(rows, { actionId: 'a', attempt: 1 }, 'up')).toBeNull()
  })
  it('skips ghost rows', () => {
    const base = def([action('a', 3, ['x']), action('g', 2, ['g']), action('c', 1, ['u'])])
    const next = def([action('a', 3, ['x']), action('c', 1, ['u'])])
    const r = buildRows(next, { changed: true, fields: [], actions: { g: { kind: 'removed', fields: [] } } }, base)
    expect(neighbour(r, { actionId: 'a', attempt: 1 }, 'down')).toEqual({ actionId: 'c', attempt: 1 })
  })
})
