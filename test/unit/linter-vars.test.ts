import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { findUnknownVariables, lintTemplate, type LintInput } from '../../src/server/templates/linter.js'
import { defineVars, varsJsonSchema } from '../../src/server/adapters/vars.js'

const schema = varsJsonSchema(
  defineVars({
    schema: z.object({
      user: z.object({ name: z.string(), email: z.string() }),
      account: z.object({ plan: z.object({ name: z.string() }) }),
      firstActiveTopic: z.object({ title: z.string() }).nullable(),
      topics: z.array(z.object({ title: z.string() })),
    }),
    resolve: async () => ({ user: { name: '', email: '' }, account: { plan: { name: '' } }, firstActiveTopic: null, topics: [] }),
  }),
)

describe('findUnknownVariables', () => {
  it('accepts known paths, builtins, and helper syntax', () => {
    const src = [
      'Hi {{user.name}} — {{account.plan.name}}',
      '{{unsubscribeUrl}} {{contact.fields.firstName}} {{vars.custom}}',
      '{{formatDate user.name "long"}}',
      '{{#if firstActiveTopic}}{{firstActiveTopic.title}}{{/if}}',
      '{{topics.length}}',
    ].join('\n')
    expect(findUnknownVariables(src, schema)).toEqual([])
  })

  it('flags typos at the root and in nested paths', () => {
    const out = findUnknownVariables('{{user.nmae}} and {{firstComparisonPrompt}}', schema)
    expect(out).toContain('user.nmae')
    expect(out).toContain('firstComparisonPrompt')
  })

  it('flags unknown helper arguments', () => {
    expect(findUnknownVariables('{{formatDate account.createdat}}', schema)).toEqual(['account.createdat'])
  })

  it('skips bare identifiers when block scopes exist (each-relative paths)', () => {
    const src = '{{#each topics}}{{title}}{{/each}} {{user.nmae}}'
    const out = findUnknownVariables(src, schema)
    expect(out).toEqual(['user.nmae']) // `title` is each-relative, not flagged
  })

  it('validates paths through array items', () => {
    expect(findUnknownVariables('{{#each topics}}{{/each}}', schema)).toEqual([])
  })
})

describe('lintTemplate unknown_variable rule', () => {
  const input: LintInput = {
    subject: 'Hello {{user.nmae}}',
    preheader: '',
    mjml: '',
    html: '<html><body><p>hi <a href="{{unsubscribeUrl}}">unsub</a></p></body></html>',
    plainText: 'hi',
    kind: 'marketing',
    fromEmail: 'hello@example.com',
  }

  it('warns when the subject references an unknown variable', () => {
    const r = lintTemplate(input, { varsJsonSchema: schema })
    const issue = r.warnings.find((w) => w.rule === 'unknown_variable')
    expect(issue).toBeDefined()
    expect(issue!.message).toContain('user.nmae')
  })

  it('is silent without a schema', () => {
    const r = lintTemplate(input, {})
    expect(r.warnings.some((w) => w.rule === 'unknown_variable')).toBe(false)
  })
})
