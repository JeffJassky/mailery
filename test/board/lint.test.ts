/** lintProgram — plans/16-program-board.md §4. */

import { describe, expect, it } from 'vitest'

import { lintProgram, type ProgramLintContext } from '../../src/server/programs/lint.js'
import { referencedTemplateSlugs } from '../../src/server/programs/validate.js'
import { buildProgram } from '../../src/testing/index.js'
import type { ProgramDefinition } from '../../src/shared/types.js'

const CATEGORY = 'lifecycle.onboarding'

function def(over: Partial<ProgramDefinition> = {}): ProgramDefinition {
  return {
    ...buildProgram({
      slug: 'p',
      actions: [
        { id: 'a', title: 'A', priority: 100, attempts: 3, cta: { label: 'Go', url: 'https://x.test/a' }, satisfied: { fact: 'a_done' } },
        { id: 'b', title: 'B', priority: 90, attempts: 2, cta: { label: 'Go', url: 'https://x.test/b' }, satisfied: { fact: 'b_done' } },
      ],
    }),
    ...over,
  }
}

function ctx(d: ProgramDefinition, tweak: (t: ProgramLintContext['templates']) => void = () => {}): ProgramLintContext {
  const templates: ProgramLintContext['templates'] = new Map()
  for (const slug of referencedTemplateSlugs(d)) templates.set(slug, { kind: 'marketing', category: CATEGORY, published: true })
  tweak(templates)
  return {
    categories: [{ id: CATEGORY, label: 'Tips' }],
    facts: { a_done: { type: 'boolean' }, b_done: { type: 'boolean' }, last_session_at: { type: 'date' } },
    templates,
  }
}

describe('lintProgram', () => {
  it('a clean definition has no issues', () => {
    const d = def()
    expect(lintProgram(d, ctx(d))).toEqual([])
  })

  it('validation issues are errors with code invalid, mapped to action and 1-based attempt', () => {
    const d = def()
    const issues = lintProgram(d, ctx(d, (t) => t.delete('b-2')))
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'invalid',
        path: 'actions.1.attempts.1.deliveries.0.templateSlug',
        message: 'template "b-2" does not exist',
        actionId: 'b',
        attempt: 2,
      },
    ])
  })

  it('a predicate error maps to the action without an attempt', () => {
    const d = def()
    d.actions[0]!.satisfied = { fact: 'nope' }
    const [i] = lintProgram(d, ctx(d))
    expect(i).toMatchObject({ severity: 'error', code: 'invalid', actionId: 'a', path: 'actions.0.satisfied.fact' })
    expect(i!.attempt).toBeUndefined()
  })

  it('the sunset ask template maps to $sunset-ask', () => {
    const d = def({ policy: { minGapDays: 3, sunset: { slowAfter: 3, slowFactor: 2, askAfter: 6, askTemplateSlug: 'ask' } } })
    const issues = lintProgram(d, ctx(d, (t) => t.delete('ask')))
    expect(issues).toContainEqual(expect.objectContaining({ code: 'invalid', actionId: '$sunset-ask', path: 'policy.sunset.askTemplateSlug' }))
  })

  it('a structurally invalid definition yields only invalid errors and never throws', () => {
    const issues = lintProgram({ slug: 'Bad Slug' }, ctx(def()))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((i) => i.severity === 'error' && i.code === 'invalid')).toBe(true)
  })

  it('template-unpublished: exists and valid, but no published body', () => {
    const d = def()
    const issues = lintProgram(d, ctx(d, (t) => t.set('a-2', { kind: 'marketing', category: CATEGORY, published: false })))
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'template-unpublished',
        path: 'actions.0.attempts.1.deliveries.0.templateSlug',
        actionId: 'a',
        attempt: 2,
      }),
    ])
  })

  it('an invalid template is not also reported unpublished', () => {
    const d = def()
    const issues = lintProgram(d, ctx(d, (t) => t.set('a-1', { kind: 'marketing', category: 'other', published: false })))
    expect(issues.map((i) => i.code)).toEqual(['invalid'])
  })

  it('template-reused: the second use of a slug, naming the first', () => {
    const d = def()
    d.actions[1]!.attempts[1]!.deliveries[0]!.templateSlug = 'a-1'
    const issues = lintProgram(d, ctx(d))
    expect(issues).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'template-reused', actionId: 'b', attempt: 2, path: 'actions.1.attempts.1.deliveries.0.templateSlug' }),
    ])
    expect(issues[0]!.message).toContain('a-1')
  })

  it('priority-tie: the later action of a tie', () => {
    const d = def()
    d.actions[1]!.priority = 100
    expect(lintProgram(d, ctx(d))).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'priority-tie', actionId: 'b', path: 'actions.1.priority' }),
    ])
  })

  it('no-cta: an action without a call to action', () => {
    const d = def()
    delete d.actions[0]!.cta
    expect(lintProgram(d, ctx(d))).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'no-cta', actionId: 'a', path: 'actions.0.cta' }),
    ])
  })

  it('sunset-early: askAfter below the longest ladder', () => {
    const d = def({ policy: { minGapDays: 3, sunset: { slowAfter: 1, slowFactor: 2, askAfter: 2, askTemplateSlug: 'ask' } } })
    expect(lintProgram(d, ctx(d))).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'sunset-early', path: 'policy.sunset.askAfter' }),
    ])
    const ok = def({ policy: { minGapDays: 3, sunset: { slowAfter: 1, slowFactor: 2, askAfter: 3, askTemplateSlug: 'ask' } } })
    expect(lintProgram(ok, ctx(ok))).toEqual([])
  })

  it('errors come before warnings', () => {
    const d = def()
    delete d.actions[0]!.cta
    d.actions[1]!.satisfied = { fact: 'nope' }
    const sev = lintProgram(d, ctx(d)).map((i) => i.severity)
    expect(sev).toEqual(['error', 'warning'])
  })
})
