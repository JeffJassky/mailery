import { describe, expect, it } from 'vitest'
import { indexIssues, issueTip, normalizeIssues, worst } from '../../../src/client/screens/program-board/issues'
import { action, def } from './fixtures'

const d = def([action('first', 2, ['a']), action('second', 1, ['b', 'c'])])

describe('normalizeIssues', () => {
  it('maps validation paths to actions and 1-based attempts', () => {
    const [a, b, c, e] = normalizeIssues(
      [
        { path: 'actions.1.attempts.0.deliveries.0.templateSlug', message: 'missing' },
        { path: 'actions.1.attempts.1.minGapDays', message: 'bad gap' },
        { path: 'actions.0.title', message: 'empty' },
        { path: 'name', message: 'required' },
      ],
      d,
    )
    expect(a).toMatchObject({ severity: 'error', code: 'invalid', actionId: 'second', attempt: 1 })
    expect(b).toMatchObject({ actionId: 'second', attempt: 2 })
    expect(c).toMatchObject({ actionId: 'first' })
    expect(c!.attempt).toBeUndefined()
    expect(e!.actionId).toBeUndefined()
  })

  it('maps the sunset ask template to the sunset row cell', () => {
    const [a, b] = normalizeIssues(
      [
        { path: 'policy.sunset.askTemplateSlug', message: 'x' },
        { path: 'policy.sunset.askAfter', message: 'y' },
      ],
      d,
    )
    expect(a).toMatchObject({ actionId: '$sunset-ask', attempt: 1 })
    expect(b).toMatchObject({ actionId: '$sunset-ask' })
    expect(b!.attempt).toBeUndefined()
  })

  it('keeps lint-provided fields and severities', () => {
    const [a] = normalizeIssues([{ severity: 'warning', code: 'no-cta', path: 'actions.0.cta', message: 'm', actionId: 'first' }], d)
    expect(a).toMatchObject({ severity: 'warning', code: 'no-cta', actionId: 'first' })
  })

  it('tolerates an out-of-range index', () => {
    const [a] = normalizeIssues([{ path: 'actions.9.title', message: 'm' }], d)
    expect(a!.actionId).toBeUndefined()
  })
})

describe('indexIssues', () => {
  it('splits cell, row and program issues', () => {
    const idx = indexIssues(
      normalizeIssues(
        [
          { path: 'actions.1.attempts.0.deliveries.0.templateSlug', message: 'a' },
          { path: 'actions.1.attempts.0.minGapDays', message: 'b' },
          { path: 'actions.0.cta', message: 'c', severity: 'warning', code: 'no-cta' },
          { path: 'holdoutPct', message: 'd' },
        ],
        d,
      ),
    )
    expect(idx.cells.get('second#1')!.map((i) => i.message)).toEqual(['a', 'b'])
    expect(idx.rows.get('first')!.map((i) => i.message)).toEqual(['c'])
    expect(idx.program.map((i) => i.message)).toEqual(['d'])
  })
})

describe('worst / issueTip', () => {
  it('error beats warning', () => {
    const w = { severity: 'warning', code: 'no-cta', path: '', message: 'w' } as const
    const e = { severity: 'error', code: 'invalid', path: '', message: 'e' } as const
    expect(worst([w])).toBe('warning')
    expect(worst([w, e])).toBe('error')
    expect(worst([])).toBeNull()
    expect(worst(undefined)).toBeNull()
    expect(issueTip([w, e])).toBe('w\ne')
  })
})
