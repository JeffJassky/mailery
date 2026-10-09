/**
 * Edit mode (plans/16 §2.7): small, pure, immutable edits of a program
 * definition. Every function returns a new definition and never mutates its
 * input. An invalid input returns the definition unchanged.
 */
import type { Predicate, ProgramAction, ProgramDefinition } from '../../../shared/types'
import { orderedActions } from './model'
import type { ChipKey } from './policy-format'

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** JSON with sorted keys: key order is never a change. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return (
      '{' +
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(o[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(v) ?? 'null'
}

export const sameDef = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b)

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

export interface MoveResult {
  def: ProgramDefinition
  /** True when no integer fit and every action was renumbered 100, 90, 80 … */
  renumbered: boolean
}

/**
 * Move an action to `newIndex` in evaluation order (index into the list
 * without the moved action). It gets a priority strictly between its new
 * neighbours (integer midpoint). With no integer between them, or a tie,
 * every action is renumbered 100, 90, 80 … in the new order.
 */
export function moveAction(def: ProgramDefinition, actionId: string, newIndex: number): MoveResult {
  const order = orderedActions(def)
  const from = order.findIndex((a) => a.id === actionId)
  if (from < 0) return { def, renumbered: false }
  const rest = order.filter((a) => a.id !== actionId)
  const at = Math.max(0, Math.min(newIndex, rest.length))
  if (at === from) return { def, renumbered: false }
  const above = rest[at - 1] // evaluated earlier = higher priority
  const below = rest[at]
  let p: number | null
  if (above && below) {
    p = above.priority - below.priority >= 2 ? Math.floor((above.priority + below.priority) / 2) : null
  } else if (below) {
    p = Math.floor(below.priority) + 10
  } else if (above) {
    p = Math.ceil(above.priority) - 10
    if (p < 0) p = null
  } else {
    p = def.actions.find((a) => a.id === actionId)!.priority
  }
  const next = clone(def)
  if (p != null) {
    next.actions.find((a) => a.id === actionId)!.priority = p
    return { def: next, renumbered: false }
  }
  const finalOrder = [...rest.slice(0, at), order[from]!, ...rest.slice(at)]
  finalOrder.forEach((a, i) => {
    next.actions.find((x) => x.id === a.id)!.priority = 100 - i * 10
  })
  return { def: next, renumbered: true }
}

// ---------------------------------------------------------------------------
// Row edits
// ---------------------------------------------------------------------------

export function updateAction(def: ProgramDefinition, id: string, fn: (a: ProgramAction) => void): ProgramDefinition {
  const next = clone(def)
  const a = next.actions.find((x) => x.id === id)
  if (a) fn(a)
  return next
}

export const setHold = (def: ProgramDefinition, id: string, hold: boolean) =>
  updateAction(def, id, (a) => {
    a.onExhaust = hold ? 'hold' : 'skip'
  })

/** `null` / '' removes. Non-positive or non-numeric input leaves the action unchanged. */
export function setCooldown(def: ProgramDefinition, id: string, raw: string | number | null): ProgramDefinition {
  if (raw === null || raw === '') return updateAction(def, id, (a) => void delete a.cooldownDays)
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return def
  return updateAction(def, id, (a) => {
    a.cooldownDays = n
  })
}

export const setTitle = (def: ProgramDefinition, id: string, title: string) =>
  updateAction(def, id, (a) => {
    a.title = title
  })

/** Both empty removes the CTA. */
export const setCta = (def: ProgramDefinition, id: string, label: string, url: string) =>
  updateAction(def, id, (a) => {
    if (!label && !url) delete a.cta
    else a.cta = { label, url }
  })

export const setPredicate = (def: ProgramDefinition, id: string, which: 'eligible' | 'satisfied', value: Predicate | undefined) =>
  updateAction(def, id, (a) => {
    if (value === undefined) {
      if (which === 'eligible') delete a.eligible
    } else a[which] = value
  })

export type PredicateParse = { ok: true; value: Predicate | undefined } | { ok: false; error: string }

/** Text of the JSON textarea → predicate. Empty means "none" for `eligible`, an error for `satisfied`. */
export function parsePredicateText(text: string, required: boolean): PredicateParse {
  const t = text.trim()
  if (!t) return required ? { ok: false, error: 'Required' } : { ok: true, value: undefined }
  try {
    const v = JSON.parse(t)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'Must be a JSON object' }
    return { ok: true, value: v as Predicate }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).replace(/^JSON\.parse: /, '') }
  }
}

export const predicateText = (p: Predicate | undefined): string => (p === undefined ? '' : JSON.stringify(p, null, 2))

// ---------------------------------------------------------------------------
// Cell edits
// ---------------------------------------------------------------------------

export const setAttemptTemplate = (def: ProgramDefinition, id: string, idx: number, slug: string) =>
  updateAction(def, id, (a) => {
    const at = a.attempts[idx]
    if (at) at.deliveries = [{ ...(at.deliveries[0] ?? { channel: 'email' as const }), channel: 'email', templateSlug: slug }]
  })

/** '' / null removes the override. Negative or non-numeric input is ignored. */
export function setAttemptGap(def: ProgramDefinition, id: string, idx: number, raw: string | number | null): ProgramDefinition {
  if (raw === null || raw === '') {
    return updateAction(def, id, (a) => {
      if (a.attempts[idx]) delete a.attempts[idx]!.minGapDays
    })
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return def
  return updateAction(def, id, (a) => {
    if (a.attempts[idx]) a.attempts[idx]!.minGapDays = n
  })
}

/** A ladder always keeps at least one attempt. */
export function canRemoveAttempt(a: ProgramAction): boolean {
  return a.attempts.length > 1
}

export function removeAttempt(def: ProgramDefinition, id: string, idx: number): ProgramDefinition {
  const cur = def.actions.find((a) => a.id === id)
  if (!cur || !canRemoveAttempt(cur) || !cur.attempts[idx]) return def
  return updateAction(def, id, (a) => {
    a.attempts.splice(idx, 1)
  })
}

export const addAttempt = (def: ProgramDefinition, id: string, slug: string) =>
  updateAction(def, id, (a) => {
    a.attempts.push({ deliveries: [{ channel: 'email', templateSlug: slug }] })
  })

export function setSunsetTemplate(def: ProgramDefinition, slug: string): ProgramDefinition {
  if (!def.policy.sunset) return def
  const next = clone(def)
  next.policy.sunset!.askTemplateSlug = slug
  return next
}

// ---------------------------------------------------------------------------
// Policy chip popovers
// ---------------------------------------------------------------------------

export interface ChipField {
  name: string
  kind: 'number' | 'time' | 'bool'
  value: string
  /** Accessible name / tooltip (the popover shows icons, not words). */
  label: string
}

export const EDITABLE_CHIPS: ReadonlySet<ChipKey> = new Set(['gap', 'progress', 'window', 'quiet', 'sunset', 'holdout'])

export function chipFields(key: ChipKey, def: ProgramDefinition): ChipField[] {
  const p = def.policy
  const s = (v: unknown) => (v === undefined || v === null ? '' : String(v))
  switch (key) {
    case 'gap':
      return [{ name: 'days', kind: 'number', value: s(p.minGapDays), label: 'Min gap between emails (days)' }]
    case 'progress':
      return [{ name: 'days', kind: 'number', value: s(p.progressGapDays), label: 'Gap after progress (days)' }]
    case 'window':
      return [
        { name: 'weekdays', kind: 'bool', value: p.delivery?.weekdaysOnly ? '1' : '', label: 'Weekdays only' },
        { name: 'time', kind: 'time', value: s(p.delivery?.timeOfDay), label: 'Time of day (HH:MM)' },
        { name: 'useSessionHour', kind: 'bool', value: p.delivery?.useSessionHour ? '1' : '', label: "At the subject's usual hour" },
        {
          name: 'sessionHourOffsetMinutes',
          kind: 'number',
          value: s(p.delivery?.sessionHourOffsetMinutes),
          label: 'Offset from usual hour (minutes)',
        },
      ]
    case 'quiet':
      return [{ name: 'hours', kind: 'number', value: s(p.suppressIfSessionWithinHours), label: 'Quiet after a session (hours)' }]
    case 'sunset':
      return [
        { name: 'slowAfter', kind: 'number', value: s(p.sunset?.slowAfter), label: 'Slow down after this many unanswered' },
        { name: 'slowFactor', kind: 'number', value: s(p.sunset?.slowFactor), label: 'Gap multiplier when slowed' },
        { name: 'askAfter', kind: 'number', value: s(p.sunset?.askAfter), label: 'Ask after this many unanswered' },
      ]
    case 'holdout':
      return [{ name: 'pct', kind: 'number', value: s(def.holdoutPct), label: 'Holdout (% get nothing)' }]
    default:
      return []
  }
}

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/

/** Apply the popover's current field values. Invalid input returns `def` unchanged. */
export function applyChipEdit(def: ProgramDefinition, key: ChipKey, v: Record<string, string>): ProgramDefinition {
  const num = (raw: string | undefined): number | null | undefined => {
    if (raw === undefined) return undefined
    if (raw.trim() === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  const next = clone(def)
  switch (key) {
    case 'gap': {
      const n = num(v.days)
      if (n == null || n < 0) return def
      next.policy.minGapDays = n
      return next
    }
    case 'progress': {
      const n = num(v.days)
      if (n === undefined || (n !== null && n < 0)) return def
      if (n === null || n === 0) delete next.policy.progressGapDays
      else next.policy.progressGapDays = n
      return next
    }
    case 'quiet': {
      const n = num(v.hours)
      if (n === undefined || (n !== null && n < 0)) return def
      if (n === null || n === 0) delete next.policy.suppressIfSessionWithinHours
      else next.policy.suppressIfSessionWithinHours = n
      return next
    }
    case 'holdout': {
      const n = num(v.pct)
      if (n === undefined || (n !== null && (n < 0 || n > 100))) return def
      if (n === null || n === 0) delete next.holdoutPct
      else next.holdoutPct = n
      return next
    }
    case 'window': {
      const time = (v.time ?? '').trim()
      if (time && !TIME.test(time)) return def
      const d = { ...(next.policy.delivery ?? {}) }
      if (v.weekdays) d.weekdaysOnly = true
      else delete d.weekdaysOnly
      if (time) d.timeOfDay = time
      else delete d.timeOfDay
      if (v.useSessionHour !== undefined) {
        if (v.useSessionHour) d.useSessionHour = true
        else delete d.useSessionHour
      }
      if (v.sessionHourOffsetMinutes !== undefined) {
        const off = num(v.sessionHourOffsetMinutes)
        if (off === undefined || (off !== null && (!Number.isInteger(off) || Math.abs(off) > 720))) return def
        if (off === null || off === 0) delete d.sessionHourOffsetMinutes
        else d.sessionHourOffsetMinutes = off
      }
      if (Object.keys(d).length === 0) delete next.policy.delivery
      else next.policy.delivery = d
      return next
    }
    case 'sunset': {
      const s = next.policy.sunset
      if (!s) return def
      const a = num(v.slowAfter)
      const f = num(v.slowFactor)
      const k = num(v.askAfter)
      if (a == null || f == null || k == null || a < 0 || f <= 0 || k < 0) return def
      s.slowAfter = a
      s.slowFactor = f
      s.askAfter = k
      return next
    }
    default:
      return def
  }
}

// ---------------------------------------------------------------------------
// Template picker
// ---------------------------------------------------------------------------

export interface TemplateChoice {
  slug: string
  name: string
  subject: string
  published: boolean
}

/** Marketing templates in the program's category (the only ones a program may send). */
export function templateChoices(list: any[], category: string): TemplateChoice[] {
  return (list ?? [])
    .filter((t) => t && t.kind === 'marketing' && t.category === category)
    .map((t) => ({ slug: String(t.slug), name: String(t.name ?? t.slug), subject: String(t.subject ?? ''), published: !!t.body?.html }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}
