/**
 * `wait_until` (plans/19): the pure parts of a flow wait anchored to a host
 * date. The runner (`step.ts`), the simulator (`simulate.ts`) and flow publish
 * (`api/admin.ts`) all go through these, so the three agree on what a step
 * means and on when it is misconfigured.
 *
 * Contract (0.22, plans/19a). The bodies are filled in by PR2.
 *
 * Runner semantics, for reference — the step parks on ITSELF and re-enters at
 * every wake:
 *
 *   1. `waitUntilMisconfiguration(step, declare)` non-null →
 *      `failFlowRun(run, 'wait_until_misconfigured: <code>')`. Never throws,
 *      never advances. Hosts seed flows straight into Mongo, so publish
 *      validation is not a guarantee.
 *   2. `waitUntilSubject(run, step)` null → `ifMissing` (reason `subject_missing`).
 *   3. `facts = await factsAdapter.resolve(subjectId)`; a throw propagates
 *      (nothing written, the run stays due, the sweep retries).
 *   4. `waitUntilTarget(step, facts)` null → `ifMissing` (reason `fact_missing`).
 *   5. `target <= now + DUE_SKEW_MS` → advance, history `wait_until_reached`.
 *   6. Otherwise park on the same step: `nextActionAt = waitUntilWakeAt(...)`.
 *
 * `ifMissing: 'exit'` (the default) → `exitFlowRun(run, 'wait_until_missing')`.
 * `ifMissing: 'continue'` → advance, history `wait_until_skipped`.
 */

import type { FactDecl, Facts, FlowStep } from '../../shared/types.js'
import type { FlowRunDoc } from '../models/index.js'
import { flowStepSchema } from '../../shared/schemas.js'
import { toEpochMs } from './programs/predicate.js'

export type WaitUntilStep = Extract<FlowStep, { type: 'wait_until' }>

export const DAY_MS = 24 * 60 * 60 * 1000
export const HOUR_MS = 60 * 60 * 1000

/**
 * `factsAdapter.declare` when the adapter is usable, else undefined (which
 * `waitUntilMisconfiguration` reports as `no_facts_adapter`).
 */
export function waitUntilDeclare(
  adapter: { declare?: Record<string, FactDecl>; resolve?: unknown } | undefined | null,
): Record<string, FactDecl> | undefined {
  if (!adapter || typeof adapter.resolve !== 'function') return undefined
  return adapter.declare
}

/** Largest |offsetDays| accepted (100 years), so the target is always a valid Date. */
export const MAX_OFFSET_DAYS = 36500

/** Exit reason for a missing subject id or date with `ifMissing: 'exit'`. */
export const WAIT_UNTIL_MISSING = 'wait_until_missing'

/** Prefix of the fail reason for a step the runner cannot evaluate: `wait_until_misconfigured: <code>`. */
export const WAIT_UNTIL_MISCONFIGURED = 'wait_until_misconfigured'

/**
 * Why a step cannot be evaluated at all. Checked in this order; the first that
 * applies is returned.
 *
 *   - `invalid_fact`           `fact` is not a non-empty string
 *   - `invalid_subject_from`   `subjectFrom` is not a non-empty string
 *   - `invalid_offset_days`    `offsetDays` is present and not a finite number
 *   - `invalid_if_missing`     `ifMissing` is present and not `'exit'` / `'continue'`
 *   - `no_facts_adapter`       no `factsAdapter` configured (`declare` undefined)
 *   - `fact_not_declared`      `fact` is not a key of `declare`
 *   - `fact_not_date`          `declare[fact].type !== 'date'`
 */
export type WaitUntilMisconfiguration =
  | 'invalid_fact'
  | 'invalid_subject_from'
  | 'invalid_offset_days'
  | 'invalid_if_missing'
  | 'no_facts_adapter'
  | 'fact_not_declared'
  | 'fact_not_date'

/** Why `ifMissing` applied. Recorded in `wait_until_skipped` details. */
export type WaitUntilMissingReason = 'subject_missing' | 'fact_missing'

/**
 * Pure. `declare` is `factsAdapter.declare`, or `undefined` when no facts
 * adapter is configured. `step` is typed loosely because a step seeded by
 * script may not match its type.
 */
export function waitUntilMisconfiguration(
  step: unknown,
  declare: Record<string, FactDecl> | undefined,
): WaitUntilMisconfiguration | null {
  const s = (step ?? {}) as Record<string, unknown>
  const nonEmpty = (v: unknown) => typeof v === 'string' && v.length > 0
  if (!nonEmpty(s.fact)) return 'invalid_fact'
  if (!nonEmpty(s.subjectFrom)) return 'invalid_subject_from'
  if (
    s.offsetDays !== undefined &&
    !(typeof s.offsetDays === 'number' && Number.isFinite(s.offsetDays) && Math.abs(s.offsetDays) <= MAX_OFFSET_DAYS)
  ) {
    return 'invalid_offset_days'
  }
  if (s.ifMissing !== undefined && s.ifMissing !== 'exit' && s.ifMissing !== 'continue') return 'invalid_if_missing'
  if (!declare || typeof declare !== 'object') return 'no_facts_adapter'
  const fact = s.fact as string
  if (!Object.hasOwn(declare, fact)) return 'fact_not_declared'
  // A declare entry may be null or malformed (nothing validates it at init).
  if ((declare[fact] as FactDecl | null | undefined)?.type !== 'date') return 'fact_not_date'
  return null
}

/**
 * The run's subject id: `run.triggerEvent?.properties?.[step.subjectFrom]`
 * when it is a non-empty string (after trim), else null. A property NAME,
 * never a template — nothing is rendered. Numbers are not coerced.
 */
export function waitUntilSubject(
  run: Pick<FlowRunDoc, 'triggerEvent'>,
  step: Pick<WaitUntilStep, 'subjectFrom'>,
): string | null {
  const v = run.triggerEvent?.properties?.[step.subjectFrom]
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The instant the step waits for: `toEpochMs(facts[step.fact]) +
 * (step.offsetDays ?? 0) * DAY_MS`, or null when that is not finite (fact
 * unset, null, or not a Date / number / ISO-like string). Reuse `toEpochMs`
 * from `./programs/predicate.js`.
 */
export function waitUntilTarget(step: Pick<WaitUntilStep, 'fact' | 'offsetDays'>, facts: Facts | null | undefined): Date | null {
  // A host may answer an unknown subject with null; that is a missing fact, not a crash.
  const value = facts && typeof facts === 'object' ? facts[step.fact] : undefined
  const ms = toEpochMs(value) + (step.offsetDays ?? 0) * DAY_MS
  if (!Number.isFinite(ms)) return null
  // Finite but outside the Date range (±8.64e15 ms) is an Invalid Date.
  const at = new Date(ms)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * When a parked run wakes next: `min(target, now + recheckHours * HOUR_MS)`.
 * Callers only call it with `target > now`.
 */
export function waitUntilWakeAt(target: Date, now: Date, recheckHours: number): Date {
  return new Date(Math.min(target.getTime(), now.getTime() + recheckHours * HOUR_MS))
}

/** One publish-blocking problem with a `wait_until` step. Same shape as `ProgramValidationIssue`. */
export interface FlowValidationIssue {
  /** Dotted path into the step list: `steps.3`, `steps.3.fact`, `steps.1.ifTrueSteps.0.fact`. */
  path: string
  message: string
}

/**
 * Publish validation for `wait_until` steps ONLY (19a trap 2: existing flows
 * were never validated; do not zod-parse the whole array). Walks `branch`
 * sub-lists (`ifTrueSteps` / `ifFalseSteps`). Every other step type is ignored.
 *
 * For each `wait_until` step at `<p>` (e.g. `steps.3`):
 *   - fails `flowStepSchema` → one issue per zod issue, path `<p>.<zod path>`
 *   - no facts adapter (`declare` null) → `{ path: <p>, message }` mentioning `factsAdapter`
 *   - `fact` not declared → `{ path: <p>.fact, message }` containing `not declared`
 *   - declared but not a date → `{ path: <p>.fact, message }` containing `needs a date fact`
 *
 * Returns `[]` when every `wait_until` step is valid (or there are none).
 */
export function validateFlowWaitUntilSteps(
  steps: unknown,
  declare: Record<string, FactDecl> | null,
): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = []
  const walk = (list: unknown, prefix: string): void => {
    if (!Array.isArray(list)) return
    list.forEach((raw, i) => {
      const p = `${prefix}.${i}`
      const step = raw as Record<string, unknown> | null
      if (!step || typeof step !== 'object') return
      if (step.type === 'branch') {
        walk(step.ifTrueSteps, `${p}.ifTrueSteps`)
        walk(step.ifFalseSteps, `${p}.ifFalseSteps`)
        return
      }
      if (step.type !== 'wait_until') return
      const parsed = flowStepSchema.safeParse(step)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const sub = issue.path.map(String).join('.')
          issues.push({ path: sub ? `${p}.${sub}` : p, message: issue.message })
        }
        return
      }
      if (!declare) {
        issues.push({ path: p, message: 'wait_until needs a factsAdapter, and none is configured' })
        return
      }
      const fact = step.fact as string
      if (!Object.hasOwn(declare, fact)) {
        issues.push({ path: `${p}.fact`, message: `fact "${fact}" is not declared by the factsAdapter` })
      } else if ((declare[fact] as FactDecl | null | undefined)?.type !== 'date') {
        const type = (declare[fact] as FactDecl | null | undefined)?.type ?? 'not a valid declaration'
        issues.push({ path: `${p}.fact`, message: `wait_until needs a date fact; "${fact}" is ${type}` })
      }
    })
  }
  walk(steps, 'steps')
  return issues
}
