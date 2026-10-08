/**
 * Program publish validation (0.21) — every rejection
 * `validateProgramDefinition` makes, then the Mailer facade that runs it
 * (`saveProgramDraft` → `publishProgram` → `setProgramEnabled`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildProgram, createTestMailer, MemoryFactsAdapter, type TestMailerHarness } from '../../src/testing/index.js'
import {
  findRequiresCycle,
  referencedTemplateSlugs,
  validateProgramDefinition,
  type ProgramValidationContext,
} from '../../src/server/programs/validate.js'
import type { ProgramDefinition } from '../../src/shared/types.js'
import { DECLARE } from './helpers.js'

const C = 'lifecycle.onboarding'

function ctx(over: Partial<ProgramValidationContext> = {}): ProgramValidationContext {
  const templates = new Map<string, { kind: 'marketing' | 'transactional'; category?: string | null }>()
  for (const slug of ['a-1', 'a-2', 'b-1', 'c-1', 'ask']) templates.set(slug, { kind: 'marketing', category: C })
  return { categories: [{ id: C, label: 'Tips' }], facts: { ...DECLARE } as any, templates, ...over }
}

function def(over: Partial<ProgramDefinition> = {}): ProgramDefinition {
  return {
    ...buildProgram({
      slug: 'activation',
      actions: [
        { id: 'a', priority: 3, attempts: 2, satisfied: { fact: 'shopify_connected' } },
        { id: 'b', priority: 2, satisfied: { fact: 'ga4_connected' }, requires: ['a'] },
        { id: 'c', priority: 1, satisfied: { fact: 'playbooks_run', gte: 1 }, eligible: { fact: 'business_type', in: ['ecommerce', 'saas'] } },
      ],
    }),
    ...over,
  }
}

function issues(input: unknown, c = ctx()): string[] {
  const r = validateProgramDefinition(input, c)
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`)
}

describe('accepts', () => {
  it('a well-formed program', () => {
    expect(issues(def())).toEqual([])
  })
  it('returns the parsed definition', () => {
    const r = validateProgramDefinition(def(), ctx())
    expect(r.ok && r.definition.slug).toBe('activation')
  })
})

describe('structure (zod)', () => {
  const cases: Array<[string, (d: any) => void, RegExp]> = [
    ['no actions', (d) => { d.actions = [] }, /actions/],
    ['zero attempts', (d) => { d.actions[0].attempts = [] }, /at least one attempt/],
    ['two deliveries in one attempt', (d) => {
      d.actions[0].attempts[0].deliveries.push({ channel: 'email', templateSlug: 'a-2' })
    }, /exactly one delivery/],
    ['a non-email channel', (d) => { d.actions[0].attempts[0].deliveries[0].channel = 'push' }, /channel/],
    ['subject other than account', (d) => { d.subject = 'contact' }, /subject/],
    ['holdoutPct over 100', (d) => { d.holdoutPct = 101 }, /holdoutPct/],
    ['minGapDays 0', (d) => { d.policy.minGapDays = 0 }, /minGapDays/],
    ['bad action id', (d) => { d.actions[0].id = 'Connect Shopify' }, /actions\.0\.id/],
    ['unknown key (typo)', (d) => { d.actions[0].priorty = 3 }, /actions\.0/],
    ['onExhaust other than skip/hold', (d) => { d.actions[0].onExhaust = 'retry' }, /onExhaust/],
    ['a contact-scoped predicate leaf (hasTag)', (d) => { d.actions[0].satisfied = { hasTag: 'vip' } }, /satisfied/],
    ['a contact-scoped leaf nested in all', (d) => { d.actions[0].eligible = { all: [{ fact: 'ga4_connected' }, { fieldEquals: { field: 'x', value: 1 } }] } }, /eligible/],
    ['an opens predicate', (d) => { d.actions[0].satisfied = { hasOpened: {} } }, /satisfied/],
    ['sunset askAfter ≤ slowAfter', (d) => { d.policy.sunset = { slowAfter: 3, slowFactor: 2, askAfter: 3, askTemplateSlug: 'ask' } }, /askAfter/],
    ['bad delivery timeOfDay', (d) => { d.policy.delivery = { timeOfDay: '9am' } }, /HH:mm/],
  ]
  for (const [name, mutate, re] of cases) {
    it(`rejects ${name}`, () => {
      const d = structuredClone(def()) as any
      mutate(d)
      const out = issues(d)
      expect(out.length).toBeGreaterThan(0)
      expect(out.join('\n')).toMatch(re)
    })
  }
})

describe('semantics', () => {
  it('rejects an undeclared category', () => {
    expect(issues(def({ category: 'not.declared' })).join()).toMatch(/category "not.declared" is not declared/)
  })

  it('rejects when no facts adapter is configured', () => {
    expect(issues(def(), ctx({ facts: null })).join()).toMatch(/factsAdapter/)
  })

  it('rejects an undeclared fact, with its path', () => {
    const d = def()
    d.actions[0]!.satisfied = { fact: 'shopfy_connected' }
    expect(issues(d)).toContain('actions.0.satisfied.fact: fact "shopfy_connected" is not declared by the facts adapter')
  })

  it('finds undeclared facts nested in all/any/not', () => {
    const d = def()
    d.actions[1]!.eligible = { any: [{ fact: 'ga4_connected' }, { not: { fact: 'nope' } }] }
    expect(issues(d).join()).toMatch(/actions\.1\.eligible\.any\.1\.not\.fact/)
  })

  it('rejects an enum value outside the declared values', () => {
    const d = def()
    d.actions[2]!.eligible = { fact: 'business_type', equals: 'retail' }
    expect(issues(d).join()).toMatch(/enum/)
  })

  it('rejects a type mismatch (boolean fact compared to a string)', () => {
    const d = def()
    d.actions[0]!.satisfied = { fact: 'shopify_connected', equals: 'yes' }
    expect(issues(d).join()).toMatch(/boolean/)
  })

  it('rejects gte on a boolean fact and a non-number gte on a number fact', () => {
    const d = def()
    d.actions[0]!.satisfied = { fact: 'shopify_connected', gte: 1 }
    d.actions[2]!.satisfied = { fact: 'playbooks_run', gte: 'one' }
    const out = issues(d).join('\n')
    expect(out).toMatch(/actions\.0\.satisfied\.gte/)
    expect(out).toMatch(/actions\.2\.satisfied\.gte/)
  })

  it('rejects duplicate action ids', () => {
    const d = def()
    d.actions[1]!.id = 'a'
    expect(issues(d).join()).toMatch(/duplicate action id "a"/)
  })

  it('rejects requires on an unknown action and on itself', () => {
    const d = def()
    d.actions[1]!.requires = ['zzz', 'b']
    const out = issues(d).join('\n')
    expect(out).toMatch(/unknown action "zzz"/)
    expect(out).toMatch(/cannot require itself/)
  })

  it('rejects a requires cycle and names it', () => {
    const d = def()
    d.actions[0]!.requires = ['c']
    d.actions[2]!.requires = ['b']
    expect(issues(d).join()).toMatch(/requires cycle: (a → c → b → a|c → b → a → c|b → a → c → b)/)
  })

  it('rejects a missing template', () => {
    const c = ctx()
    c.templates.delete('b-1')
    expect(issues(def(), c).join()).toMatch(/template "b-1" does not exist/)
  })

  it('rejects a transactional template', () => {
    const c = ctx()
    c.templates.set('b-1', { kind: 'transactional' })
    expect(issues(def(), c).join()).toMatch(/must be marketing/)
  })

  it('rejects a template in another category, or none (its unsubscribe would not stop the program)', () => {
    const c = ctx()
    c.templates.set('a-1', { kind: 'marketing', category: 'product.updates' })
    c.templates.set('b-1', { kind: 'marketing', category: null })
    const out = issues(def(), c).join('\n')
    expect(out).toMatch(/"a-1" has category "product.updates"/)
    expect(out).toMatch(/"b-1" has category none/)
  })

  it('checks the sunset ask template too', () => {
    const c = ctx()
    c.templates.delete('ask')
    const d = def()
    d.policy.sunset = { slowAfter: 2, slowFactor: 2, askAfter: 4, askTemplateSlug: 'ask' }
    expect(issues(d, c).join()).toMatch(/policy\.sunset\.askTemplateSlug/)
  })

  it('suppressIfSessionWithinHours requires a declared date fact last_session_at', () => {
    const facts = { ...DECLARE } as any
    delete facts.last_session_at
    const d = def()
    d.policy.suppressIfSessionWithinHours = 12
    expect(issues(d, ctx({ facts })).join()).toMatch(/last_session_at/)
  })

  it('rejects an entry event that is also an exit event', () => {
    expect(issues(def({ exit: { eventNames: ['Created'] } })).join()).toMatch(/entry event/)
  })

  it('reports every problem at once', () => {
    const c = ctx()
    c.templates.delete('a-1')
    const d = def({ category: 'nope' })
    d.actions[1]!.id = 'a'
    expect(issues(d, c).length).toBeGreaterThanOrEqual(3)
  })
})

describe('helpers', () => {
  it('referencedTemplateSlugs lists attempts and the sunset ask once each', () => {
    const d = def()
    d.policy.sunset = { slowAfter: 2, slowFactor: 2, askAfter: 4, askTemplateSlug: 'ask' }
    expect(referencedTemplateSlugs(d).sort()).toEqual(['a-1', 'a-2', 'ask', 'b-1', 'c-1'])
  })
  it('findRequiresCycle returns null for a DAG', () => {
    expect(findRequiresCycle(def())).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Facade (PR 4)
// ---------------------------------------------------------------------------

describe('saveProgramDraft → publishProgram → setProgramEnabled', () => {
  let H: TestMailerHarness

  beforeAll(async () => {
    H = await createTestMailer({
      config: { categories: [{ id: C, label: 'Tips' }], factsAdapter: new MemoryFactsAdapter({ declare: { ...DECLARE } as any }) },
    })
    for (const slug of ['a-1', 'a-2', 'b-1', 'c-1']) await H.seedTemplate({ slug, kind: 'marketing', category: C })
  }, 120_000)

  afterAll(async () => {
    if (H) await H.stop()
  })

  it('a new draft creates a disabled, unpublished program', async () => {
    const doc = await H.mailer.saveProgramDraft(def(), { actor: 'test' })
    expect(doc).toMatchObject({ slug: 'activation', version: 0, enabled: false, definition: null })
    expect(doc.draft!.definition.slug).toBe('activation')
  })

  it('enabling an unpublished program throws', async () => {
    await expect(H.mailer.setProgramEnabled('activation', true, { actor: 'test' })).rejects.toThrow()
  })

  it('publish validates, bumps the version, snapshots, clears the draft, audits', async () => {
    const res = await H.mailer.publishProgram('activation', { actor: 'test' })
    expect(res).toEqual({ ok: true, version: 1 })
    const doc = (await H.mailer.collections.programs.findOne({ slug: 'activation' }))!
    expect(doc).toMatchObject({ version: 1, draft: null, publishedBy: 'test' })
    expect(doc.definition!.actions).toHaveLength(3)
    expect(await H.mailer.collections.programVersions.countDocuments({ slug: 'activation', version: 1 })).toBe(1)
    expect(await H.mailer.collections.auditLog.countDocuments({ action: 'program.publish' })).toBe(1)
  })

  it('an invalid draft is not published and the issues come back', async () => {
    const bad = def()
    bad.actions[0]!.satisfied = { fact: 'nope' }
    await H.mailer.saveProgramDraft(bad, { actor: 'test' })
    const res = await H.mailer.publishProgram('activation', { actor: 'test' })
    expect(res.ok).toBe(false)
    expect(!res.ok && res.issues[0]!.path).toBe('actions.0.satisfied.fact')
    expect((await H.mailer.collections.programs.findOne({ slug: 'activation' }))!.version).toBe(1)
  })

  it('saveProgramDraft rejects structurally invalid input outright', async () => {
    await expect(H.mailer.saveProgramDraft({ slug: 'x' } as any, { actor: 'test' })).rejects.toThrow()
  })

  it('enable / disable a published program, audited', async () => {
    await H.mailer.setProgramEnabled('activation', true, { actor: 'test' })
    expect((await H.mailer.collections.programs.findOne({ slug: 'activation' }))!.enabled).toBe(true)
    await H.mailer.setProgramEnabled('activation', false, { actor: 'test' })
    expect((await H.mailer.collections.programs.findOne({ slug: 'activation' }))!.enabled).toBe(false)
    expect(await H.mailer.collections.auditLog.countDocuments({ action: 'program.enable' })).toBe(1)
    expect(await H.mailer.collections.auditLog.countDocuments({ action: 'program.disable' })).toBe(1)
  })

  it('Facts Changed is registered when a factsAdapter is configured', () => {
    expect(H.mailer.events.has('Facts Changed')).toBe(true)
  })
})
