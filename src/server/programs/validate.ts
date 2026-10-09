/**
 * Program publish validation (0.21). Structure is checked by
 * `programDefinitionSchema`; this adds the checks that need context the
 * schema cannot see — declared categories, declared facts, the templates the
 * program sends — plus graph checks on `requires`.
 *
 * Pure: the caller loads templates and passes them in, so the admin API, the
 * agent API, `mailer.publishProgram` and the `doctor` CLI all run the same
 * rules and a test can exercise every rejection without a database.
 *
 * Every problem is reported, not just the first: an editor fixing a program
 * one error per publish attempt is the failure mode this avoids.
 */

import type { CategoryDef, FactDecl, ProgramDefinition } from '../../shared/types.js'
import { programDefinitionSchema } from '../../shared/schemas.js'

export interface ProgramValidationIssue {
  /** Dotted path into the definition, e.g. `actions.2.requires.0`. Empty for whole-program issues. */
  path: string
  message: string
}

export interface ProgramValidationContext {
  categories: CategoryDef[]
  /** `factsAdapter.declare`, or null when no facts adapter is configured. */
  facts: Record<string, FactDecl> | null
  /** Every template the program references, by slug. Missing slugs are reported. */
  templates: Map<string, { kind: 'marketing' | 'transactional'; category?: string | null }>
}

export type ProgramValidationResult =
  | { ok: true; definition: ProgramDefinition }
  | { ok: false; issues: ProgramValidationIssue[] }

/** Template slugs a definition references (attempt deliveries + sunset ask), deduplicated. */
export function referencedTemplateSlugs(def: Pick<ProgramDefinition, 'actions' | 'policy'>): string[] {
  const out = new Set<string>()
  for (const a of def.actions ?? []) {
    for (const at of a.attempts ?? []) {
      for (const d of at.deliveries ?? []) if (d?.templateSlug) out.add(d.templateSlug)
    }
  }
  if (def.policy?.sunset?.askTemplateSlug) out.add(def.policy.sunset.askTemplateSlug)
  return [...out]
}

export function validateProgramDefinition(
  input: unknown,
  ctx: ProgramValidationContext,
): ProgramValidationResult {
  const parsed = programDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }
  }
  const def = parsed.data as ProgramDefinition
  const issues: ProgramValidationIssue[] = []

  // Category -------------------------------------------------------------
  const declaredCategories = new Set(ctx.categories.map((c) => c.id))
  if (!declaredCategories.has(def.category)) {
    issues.push({ path: 'category', message: `category "${def.category}" is not declared in MailerConfig.categories` })
  }

  // Facts adapter --------------------------------------------------------
  if (!ctx.facts) {
    issues.push({ path: '', message: 'programs require MailerConfig.factsAdapter' })
  }
  const facts = ctx.facts ?? {}

  if (def.policy.suppressIfSessionWithinHours !== undefined && ctx.facts) {
    const decl = facts.last_session_at
    if (!decl || decl.type !== 'date') {
      issues.push({
        path: 'policy.suppressIfSessionWithinHours',
        message: 'requires a declared date fact "last_session_at"',
      })
    }
  }

  if (def.policy.delivery?.useSessionHour === true && ctx.facts) {
    const decl = facts.usual_session_hour_utc
    if (!decl || decl.type !== 'number') {
      issues.push({
        path: 'policy.delivery.useSessionHour',
        message: 'requires a declared number fact "usual_session_hour_utc"',
      })
    }
  }

  // Entry / exit ---------------------------------------------------------
  if (def.exit.eventNames?.includes(def.entry.eventName)) {
    issues.push({ path: 'exit.eventNames', message: 'the entry event cannot also be an exit event' })
  }

  // Actions: ids, requires, predicates ------------------------------------
  const ids = new Map<string, number>()
  def.actions.forEach((a, i) => {
    if (ids.has(a.id)) issues.push({ path: `actions.${i}.id`, message: `duplicate action id "${a.id}"` })
    else ids.set(a.id, i)
  })

  def.actions.forEach((a, i) => {
    a.requires?.forEach((r, j) => {
      if (r === a.id) issues.push({ path: `actions.${i}.requires.${j}`, message: 'an action cannot require itself' })
      else if (!ids.has(r)) issues.push({ path: `actions.${i}.requires.${j}`, message: `unknown action "${r}"` })
    })
    if (a.eligible !== undefined) checkPredicateFacts(a.eligible, `actions.${i}.eligible`, facts, !!ctx.facts, issues)
    checkPredicateFacts(a.satisfied, `actions.${i}.satisfied`, facts, !!ctx.facts, issues)
  })

  const cycle = findRequiresCycle(def)
  if (cycle) issues.push({ path: 'actions', message: `requires cycle: ${cycle.join(' → ')}` })

  // Templates ------------------------------------------------------------
  def.actions.forEach((a, i) => {
    a.attempts.forEach((at, j) => {
      at.deliveries.forEach((d, k) => {
        checkTemplate(d.templateSlug, `actions.${i}.attempts.${j}.deliveries.${k}.templateSlug`, def.category, ctx, issues)
      })
    })
  })
  if (def.policy.sunset) {
    checkTemplate(def.policy.sunset.askTemplateSlug, 'policy.sunset.askTemplateSlug', def.category, ctx, issues)
  }

  return issues.length ? { ok: false, issues } : { ok: true, definition: def }
}

/**
 * Action id used on the sunset ask send's `program.actionId` and on its
 * decision's `chosen`. Cannot collide with a real action: action ids are
 * kebab slugs, which never contain `$`.
 */
export const SUNSET_ASK_ACTION_ID = '$sunset-ask'

function checkTemplate(
  slug: string,
  path: string,
  category: string,
  ctx: ProgramValidationContext,
  issues: ProgramValidationIssue[],
): void {
  const t = ctx.templates.get(slug)
  if (!t) {
    issues.push({ path, message: `template "${slug}" does not exist` })
    return
  }
  if (t.kind !== 'marketing') {
    issues.push({ path, message: `template "${slug}" is ${t.kind}; program templates must be marketing` })
    return
  }
  if ((t.category ?? null) !== category) {
    issues.push({
      path,
      message: `template "${slug}" has category ${t.category ? `"${t.category}"` : 'none'}; program sends require "${category}" so its unsubscribe link stops this program`,
    })
  }
}

function checkPredicateFacts(
  pred: unknown,
  path: string,
  facts: Record<string, FactDecl>,
  haveAdapter: boolean,
  issues: ProgramValidationIssue[],
): void {
  const p = pred as Record<string, any>
  if ('all' in p) return p.all.forEach((x: unknown, i: number) => checkPredicateFacts(x, `${path}.all.${i}`, facts, haveAdapter, issues))
  if ('any' in p) return p.any.forEach((x: unknown, i: number) => checkPredicateFacts(x, `${path}.any.${i}`, facts, haveAdapter, issues))
  if ('not' in p) return checkPredicateFacts(p.not, `${path}.not`, facts, haveAdapter, issues)
  if (!('fact' in p)) return
  if (!haveAdapter) return // already reported once at program level
  const decl = facts[p.fact]
  if (!decl) {
    issues.push({ path: `${path}.fact`, message: `fact "${p.fact}" is not declared by the facts adapter` })
    return
  }
  for (const op of ['minAgeDays', 'maxAgeDays'] as const) {
    if (p[op] !== undefined && decl.type !== 'date') {
      issues.push({ path: `${path}.${op}`, message: `${op} needs a date fact; "${p.fact}" is ${decl.type}` })
    }
  }
  const values: unknown[] = []
  if ('equals' in p) values.push(p.equals)
  if (Array.isArray(p.in)) values.push(...p.in)
  for (const v of values) {
    if (v === null) continue
    const bad =
      (decl.type === 'boolean' && typeof v !== 'boolean') ||
      (decl.type === 'number' && typeof v !== 'number') ||
      ((decl.type === 'string' || decl.type === 'enum' || decl.type === 'date') && typeof v !== 'string') ||
      (decl.type === 'enum' && !(decl.values ?? []).includes(v as string))
    if (bad) {
      issues.push({
        path,
        message:
          decl.type === 'enum'
            ? `fact "${p.fact}" is an enum of ${JSON.stringify(decl.values ?? [])}; ${JSON.stringify(v)} is not one of them`
            : `fact "${p.fact}" is ${decl.type}; ${JSON.stringify(v)} does not match`,
      })
    }
  }
  for (const op of ['gte', 'lte'] as const) {
    if (!(op in p)) continue
    if (decl.type !== 'number' && decl.type !== 'date') {
      issues.push({ path: `${path}.${op}`, message: `${op} needs a number or date fact; "${p.fact}" is ${decl.type}` })
    } else if (decl.type === 'number' && typeof p[op] !== 'number') {
      issues.push({ path: `${path}.${op}`, message: `${op} on number fact "${p.fact}" must be a number` })
    } else if (decl.type === 'date' && Number.isNaN(new Date(p[op]).getTime())) {
      issues.push({ path: `${path}.${op}`, message: `${op} on date fact "${p.fact}" must be an ISO date or epoch ms` })
    }
  }
}

/** First cycle in the `requires` graph, as a path of ids ending where it started; null if acyclic. */
export function findRequiresCycle(def: Pick<ProgramDefinition, 'actions'>): string[] | null {
  const edges = new Map(def.actions.map((a) => [a.id, (a.requires ?? []).filter((r) => r !== a.id)]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 'visiting')
    stack.push(id)
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue
      const c = visit(next)
      if (c) return c
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }
  for (const a of def.actions) {
    const c = visit(a.id)
    if (c) return c
  }
  return null
}
