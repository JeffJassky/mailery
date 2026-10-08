/**
 * Program board (0.21.x) — shared contract for the admin board, the lens and
 * the facts simulator. plans/16-program-board.md.
 *
 * Pure helpers here (`describePredicate`, `diffProgramDefinitions`) run in
 * both the server and the admin SPA. The simulation and lint types are the
 * JSON shapes of `POST /programs/:slug/simulate` and `GET /programs/:slug/lint`;
 * `D` is `Date` on the server and `string` (ISO) once serialized.
 */

import type { Facts, Predicate, ProgramDefinition } from './types.js'

export type ProgramSource = 'published' | 'draft'

// ---------------------------------------------------------------------------
// Simulation (dry-run tick + projected sequence). Read-only by contract.
// ---------------------------------------------------------------------------

export interface ProgramSimulationInput {
  /** Default: 'draft' when a draft exists, else 'published'. */
  source?: ProgramSource
  /**
   * A real subject. Its run state (or a fresh run when it has none) and its
   * resolved facts are used; nothing is written. Omit to simulate a brand-new
   * subject from `facts` alone (event predicates then evaluate to "not fired").
   */
  subjectId?: string
  /** Merged over the resolved facts (subject mode) or used as-is. Dates as ISO strings. */
  facts?: Facts
  /** Default: now. */
  now?: Date | string
  /** Sequence projection horizon in days. Default 60, max 365. */
  horizonDays?: number
}

/** Why the next tick would (not) send. Same vocabulary as decision reasons, plus `send`. */
export type ProgramNextReason =
  | 'send'
  | 'holdout'
  | 'exited'
  | 'completed'
  | 'sunset'
  | 'none-eligible'
  | 'in-flight'
  | 'session-suppressed'
  | 'min-gap'
  | 'delivery-window'
  | 'no-recipients'

export interface ProgramSimulationCandidate<D = Date> {
  actionId: string
  title: string
  priority: number
  eligible: boolean
  satisfied: boolean
  /** Same values as a decision row's `blockedBy` (`requires:<id>` included). */
  blockedBy: string | null
  /** 1-based among unblocked candidates. */
  rank?: number
  status: 'pending' | 'satisfied' | 'exhausted' | 'cooldown'
  /** Attempts already sent in the current ladder (before the simulated tick). */
  attempts: number
  ladder: number
  cooldownUntil: D | null
}

export interface ProgramSimulationStep<D = Date> {
  at: D
  /** A real action id, or `$sunset-ask`. */
  actionId: string
  /** 1-based attempt within the action's ladder. */
  attempt: number
  templateSlug: string
  sunsetStage: 0 | 1 | 2
}

export interface ProgramSimulation<D = Date> {
  source: ProgramSource
  /** Published version simulated, or null for a draft. */
  version: number | null
  now: D
  subjectId: string | null
  /** The facts the simulation evaluated (resolved ∪ overrides). */
  facts: Facts
  /** The subject's real run, or null (fresh run simulated). */
  run: {
    status: 'active' | 'completed' | 'exited' | 'sunset'
    arm: 'treatment' | 'holdout'
    unansweredAttempts: number
    sunsetStage: 0 | 1 | 2
    lastSentAt: D | null
    enteredAt: D
  } | null
  /** Run arm, or the deterministic holdout arm for (slug, subjectId); 'treatment' without a subject. */
  arm: 'treatment' | 'holdout'
  /** Every action, in evaluation order (priority desc, ties by definition order). */
  candidates: ProgramSimulationCandidate<D>[]
  /** What one tick at `now` would do. */
  next: {
    reason: ProgramNextReason
    actionId: string | null
    attempt: number | null
    templateSlug: string | null
    /** `send`/`holdout`: `now`. Waits: the projected send instant. Otherwise null (or the earliest cooldown end for `none-eligible`). */
    at: D | null
    /** Human detail for odd cases, e.g. a template that is missing. */
    detail?: string
  }
  /**
   * Projected sends if facts stay as they are and the subject never engages:
   * every send accepted, no clicks, no sessions after `now`.
   */
  sequence: ProgramSimulationStep<D>[]
  sequenceEnd: 'completed' | 'sunset' | 'exited' | 'none-eligible' | 'horizon' | 'max-steps'
}

/** Projection stops after this many steps. */
export const SIMULATION_MAX_STEPS = 50
export const SIMULATION_DEFAULT_HORIZON_DAYS = 60
export const SIMULATION_MAX_HORIZON_DAYS = 365

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

export type ProgramLintCode =
  /** Any publish-validation issue (errors block publish). */
  | 'invalid'
  /** Warnings — publish still allowed. */
  | 'template-unpublished'
  | 'template-reused'
  | 'priority-tie'
  | 'sunset-early'
  | 'no-cta'

export interface ProgramLintIssue {
  severity: 'error' | 'warning'
  code: ProgramLintCode
  /** Dotted path into the definition, as publish validation reports it. */
  path: string
  message: string
  /** The action the path points into; `$sunset-ask` for `policy.sunset.askTemplateSlug`. */
  actionId?: string
  /** 1-based attempt when the path points into `attempts.N`. */
  attempt?: number
}

// ---------------------------------------------------------------------------
// Draft vs published
// ---------------------------------------------------------------------------

export interface ProgramActionDiff {
  kind: 'added' | 'removed' | 'changed'
  /**
   * Changed fields of the action. Top-level keys (`priority`, `title`,
   * `eligible`, ...), except attempts, reported per index as `attempts.<i>`
   * (0-based) for every index that differs or exists on one side only.
   * Empty for added/removed.
   */
  fields: string[]
}

export interface ProgramDiff {
  changed: boolean
  /**
   * Non-action differences. Top-level keys (`name`, `holdoutPct`, ...), except
   * `policy`, `entry` and `exit`, reported one level down
   * (`policy.minGapDays`, `policy.sunset`, `exit.eventNames`).
   */
  fields: string[]
  /** Only actions that differ. */
  actions: Record<string, ProgramActionDiff>
}

/** Key-order-independent JSON (this module also runs in the browser, so no server import). */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  )
}

type Bag = Record<string, unknown>
const NESTED_KEYS = new Set(['policy', 'entry', 'exit'])

/** Keys of `a` and `b` whose values differ, optionally skipping some. */
function differingKeys(a: Bag, b: Bag, skip: ReadonlySet<string> = new Set()): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => !skip.has(k) && stable(a[k]) !== stable(b[k]))
}

function diffAction(a: Bag, b: Bag): string[] {
  const fields = differingKeys(a, b, new Set(['attempts']))
  const x = (a.attempts as unknown[] | undefined) ?? []
  const y = (b.attempts as unknown[] | undefined) ?? []
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (i >= x.length || i >= y.length || stable(x[i]) !== stable(y[i])) fields.push(`attempts.${i}`)
  }
  return fields.sort()
}

/** Compare two definitions (null = absent). Key order never counts as a change. */
export function diffProgramDefinitions(base: ProgramDefinition | null, next: ProgramDefinition | null): ProgramDiff {
  const a = (base ?? {}) as unknown as Bag
  const b = (next ?? {}) as unknown as Bag

  const fields: string[] = []
  for (const k of differingKeys(a, b, new Set(['actions']))) {
    if (!NESTED_KEYS.has(k)) {
      fields.push(k)
      continue
    }
    const x = (a[k] as Bag | undefined) ?? {}
    const y = (b[k] as Bag | undefined) ?? {}
    for (const sub of differingKeys(x, y)) fields.push(`${k}.${sub}`)
  }

  const byId = (d: Bag): Map<string, Bag> =>
    new Map(((d.actions as Bag[] | undefined) ?? []).map((act) => [String(act.id), act]))
  const before = byId(a)
  const after = byId(b)
  const actions: Record<string, ProgramActionDiff> = {}
  for (const [id, act] of before) {
    const other = after.get(id)
    if (!other) actions[id] = { kind: 'removed', fields: [] }
    else {
      const changed = diffAction(act, other)
      if (changed.length) actions[id] = { kind: 'changed', fields: changed }
    }
  }
  for (const id of after.keys()) if (!before.has(id)) actions[id] = { kind: 'added', fields: [] }

  fields.sort()
  return { changed: fields.length > 0 || Object.keys(actions).length > 0, fields, actions }
}

// ---------------------------------------------------------------------------
// Predicate → English (display only)
// ---------------------------------------------------------------------------

type Pred = Record<string, any>

/**
 * One-line English for a program predicate. Fact names stay verbatim.
 * The exact strings are pinned by test/board/predicate-text.test.ts.
 */
export function describePredicate(p: Predicate): string {
  return describe(unwrap(p as Pred))
}

/** A group of one is its only child. */
function unwrap(p: Pred): Pred {
  for (;;) {
    const kids = (p && (p.all ?? p.any)) as Pred[] | undefined
    if (Array.isArray(kids) && kids.length === 1) p = kids[0]!
    else return p
  }
}

const isGroup = (p: Pred, kind: 'all' | 'any') => Array.isArray(p?.[kind])

function describe(p: Pred): string {
  if (p && typeof p === 'object') {
    if ('fact' in p) return factText(p)
    if ('hasFiredEvent' in p) return eventText(p.hasFiredEvent, p.withinDays, true)
    if ('notHasFiredEvent' in p) return eventText(p.notHasFiredEvent, p.withinDays, false)
    if ('all' in p) return groupText(p.all, 'all')
    if ('any' in p) return groupText(p.any, 'any')
    if ('not' in p) return negate(unwrap(p.not))
  }
  return JSON.stringify(p)
}

function groupText(kids: Pred[], kind: 'all' | 'any'): string {
  if (kids.length === 0) return kind === 'all' ? 'always' : 'never'
  const other = kind === 'all' ? 'any' : 'all'
  const parts: string[] = []
  const collect = (list: Pred[]) => {
    for (const raw of list) {
      const k = unwrap(raw)
      if (isGroup(k, kind)) collect(k[kind])
      else if (isGroup(k, other) && k[other].length >= 2) parts.push(`(${describe(k)})`)
      else if (kind === 'any' && 'fact' in (k ?? {}) && factParts(k).length > 1) parts.push(`(${describe(k)})`)
      else parts.push(describe(k))
    }
  }
  collect(kids)
  return parts.join(kind === 'all' ? ' and ' : ' or ')
}

function eventText(name: string, withinDays: number | undefined, happened: boolean): string {
  const when = withinDays && withinDays > 0 ? ` in the last ${withinDays === 1 ? 'day' : `${withinDays} days`}` : ''
  return `${name} ${happened ? 'happened' : "hasn't happened"}${when}`
}

const word = (v: unknown) => (v === null ? 'empty' : String(v))

/** Operators on one fact leaf, in the order: equals, in, range, exists. */
function factParts(p: Pred): string[] {
  const f = p.fact as string
  const parts: string[] = []
  if ('equals' in p && p.equals !== undefined) {
    if (p.equals === true) parts.push(f)
    else if (p.equals === false) parts.push(`not ${f}`)
    else if (p.equals === null) parts.push(`${f} is empty`)
    else parts.push(`${f} = ${p.equals}`)
  }
  if (Array.isArray(p.in)) {
    const v = p.in.map(word)
    if (v.length === 1) parts.push(`${f} = ${v[0]}`)
    else if (v.length === 0) parts.push(`${f} is never`)
    else parts.push(`${f} is ${v.length === 2 ? v.join(' or ') : `${v.slice(0, -1).join(', ')} or ${v.at(-1)}`}`)
  }
  if (p.gte !== undefined && p.lte !== undefined) parts.push(`${p.gte} ≤ ${f} ≤ ${p.lte}`)
  else if (p.gte !== undefined) parts.push(`${f} ≥ ${p.gte}`)
  else if (p.lte !== undefined) parts.push(`${f} ≤ ${p.lte}`)
  if (p.exists !== undefined) parts.push(`${f} is ${p.exists ? '' : 'not '}set`)
  return parts.length ? parts : [f]
}

function factText(p: Pred): string {
  return factParts(p).join(' and ')
}

/** "not X", folding the cases that have a natural opposite. */
function negate(p: Pred): string {
  if (p && typeof p === 'object') {
    if ('not' in p) return describe(unwrap(p.not))
    if ('hasFiredEvent' in p) return eventText(p.hasFiredEvent, p.withinDays, false)
    if ('notHasFiredEvent' in p) return eventText(p.notHasFiredEvent, p.withinDays, true)
    if ('fact' in p) {
      const f = p.fact as string
      const keys = Object.keys(p).filter((k) => k !== 'fact' && p[k] !== undefined)
      if (keys.length === 0 || (keys.length === 1 && p.equals === true)) return `not ${f}`
      if (keys.length === 1 && p.equals === false) return f
      if (keys.length === 1 && p.exists !== undefined) return `${f} is ${p.exists ? 'not ' : ''}set`
    }
  }
  return `not (${describe(p)})`
}

// ---------------------------------------------------------------------------
// Predicate → readable outline (board tooltips)
// ---------------------------------------------------------------------------

/**
 * A predicate as an outline a person can scan: one line per condition, groups
 * for "all of" / "one of" / "none of". Fact names are humanised
 * (`sells_products_online` → "sells products online"); booleans read
 * "…: yes" / "…: no"; negations are folded into the condition where possible.
 */
export type PredicateOutline =
  | { kind: 'line'; text: string }
  | { kind: 'group'; mode: 'all' | 'any' | 'none' | 'not-all'; items: PredicateOutline[] }

const humanize = (name: string): string => name.replace(/[_-]+/g, ' ').trim()
const isDateLike = (v: unknown): boolean => typeof v === 'string' && Number.isNaN(Number(v)) && !Number.isNaN(Date.parse(v))
const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))
const orList = (vs: unknown[]): string =>
  vs.length <= 1 ? vs.map(show).join('') : `${vs.slice(0, -1).map(show).join(', ')} or ${show(vs[vs.length - 1])}`
const line = (text: string): PredicateOutline => ({ kind: 'line', text })

function factLine(leaf: Record<string, any>, negate: boolean): PredicateOutline | null {
  const h = humanize(String(leaf.fact))
  const ops = ['equals', 'in', 'gte', 'lte', 'exists'].filter((k) => k in leaf)
  if (ops.length === 0 || (ops.length === 1 && leaf.equals === true)) return line(`${h}: ${negate ? 'no' : 'yes'}`)
  if (ops.length === 1 && leaf.equals === false) return line(`${h}: ${negate ? 'yes' : 'no'}`)
  if (ops.length === 1 && 'exists' in leaf) return line(`${h} is ${(leaf.exists === true) !== negate ? 'set' : 'not set'}`)
  if (ops.length === 1 && 'equals' in leaf) {
    if (leaf.equals === null) return line(`${h} is ${negate ? 'not empty' : 'empty'}`)
    return line(`${h} is ${negate ? 'not ' : ''}${show(leaf.equals)}`)
  }
  if (ops.length === 1 && 'in' in leaf) return line(`${h} is ${negate ? 'not ' : ''}${orList(leaf.in)}`)
  const dated = isDateLike(leaf.gte) || isDateLike(leaf.lte)
  if (ops.length === 2 && 'gte' in leaf && 'lte' in leaf && !negate) {
    return line(`${h} is between ${show(leaf.gte)} and ${show(leaf.lte)}`)
  }
  if (ops.length === 1 && 'gte' in leaf) {
    if (negate) return line(`${h} is ${dated ? 'before' : 'below'} ${show(leaf.gte)}`)
    return line(`${h} is ${dated ? 'on or after' : 'at least'} ${show(leaf.gte)}`)
  }
  if (ops.length === 1 && 'lte' in leaf) {
    if (negate) return line(`${h} is ${dated ? 'after' : 'above'} ${show(leaf.lte)}`)
    return line(`${h} is ${dated ? 'on or before' : 'at most'} ${show(leaf.lte)}`)
  }
  return null // several operators: handled by the caller as a group
}

function eventLine(name: string, happened: boolean, withinDays: unknown): PredicateOutline {
  const n = typeof withinDays === 'number' && withinDays > 0 ? withinDays : 0
  const when = n === 0 ? '' : n === 1 ? ' in the last day' : ` in the last ${n} days`
  return line(`"${name}" ${happened ? 'happened' : "hasn't happened"}${when}`)
}

function outline(p: any, negate: boolean): PredicateOutline {
  if (p && typeof p === 'object') {
    if ('fact' in p) {
      const one = factLine(p, negate)
      if (one) return one
      // Several operators on one fact: each is its own condition.
      const parts = (['equals', 'in', 'gte', 'lte', 'exists'] as const)
        .filter((k) => k in p)
        .map((k) => factLine({ fact: p.fact, [k]: p[k] }, false)!)
      return negate ? { kind: 'group', mode: 'not-all', items: parts } : { kind: 'group', mode: 'all', items: parts }
    }
    if ('hasFiredEvent' in p) return eventLine(p.hasFiredEvent, !negate, p.withinDays)
    if ('notHasFiredEvent' in p) return eventLine(p.notHasFiredEvent, negate, p.withinDays)
    if ('not' in p) return outline(p.not, !negate)
    if ('all' in p || 'any' in p) {
      const isAll = 'all' in p
      const kids: any[] = isAll ? p.all : p.any
      if (kids.length === 0) return line(isAll !== negate ? 'always' : 'never')
      if (kids.length === 1) return outline(kids[0], negate)
      if (negate) {
        // not(any) = none of; not(all) = not all of. Children stay positive.
        return { kind: 'group', mode: isAll ? 'not-all' : 'none', items: flatten(kids, isAll ? 'all' : 'any') }
      }
      return { kind: 'group', mode: isAll ? 'all' : 'any', items: flatten(kids, isAll ? 'all' : 'any') }
    }
  }
  return line(JSON.stringify(p))
}

/** Children of a group; a nested group of the same kind is merged into it. */
function flatten(kids: any[], mode: 'all' | 'any'): PredicateOutline[] {
  const out: PredicateOutline[] = []
  for (const k of kids) {
    const o = outline(k, false)
    if (o.kind === 'group' && o.mode === mode) out.push(...o.items)
    else out.push(o)
  }
  return out
}

export function outlinePredicate(p: Predicate): PredicateOutline {
  return outline(p, false)
}

const GROUP_WORDS: Record<'all' | 'any' | 'none' | 'not-all', string> = {
  all: 'all of',
  any: 'one of',
  none: 'none of',
  'not-all': 'not all of',
}

/** The outline as plain text (screen readers, copy): "Title all of:\n• a\n• one of:\n  – b". */
export function outlineText(title: string, o: PredicateOutline): string {
  if (o.kind === 'line') return `${title}: ${o.text}`
  const lines = [`${title} ${GROUP_WORDS[o.mode]}:`]
  const walk = (items: PredicateOutline[], depth: number) => {
    for (const it of items) {
      const pad = '  '.repeat(depth)
      const mark = depth === 0 ? '•' : '–'
      if (it.kind === 'line') lines.push(`${pad}${mark} ${it.text}`)
      else {
        lines.push(`${pad}${mark} ${GROUP_WORDS[it.mode]}:`)
        walk(it.items, depth + 1)
      }
    }
  }
  walk(o.items, 0)
  return lines.join('\n')
}

export const OUTLINE_GROUP_WORDS = GROUP_WORDS
