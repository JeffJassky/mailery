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

/** Compare two definitions (null = absent). Key order never counts as a change. */
export function diffProgramDefinitions(base: ProgramDefinition | null, next: ProgramDefinition | null): ProgramDiff {
  void base
  void next
  throw new Error('diffProgramDefinitions: not implemented (board WP-A)')
}

// ---------------------------------------------------------------------------
// Predicate → English (display only)
// ---------------------------------------------------------------------------

/**
 * One-line English for a program predicate. Fact names stay verbatim.
 * The exact strings are pinned by test/board/predicate-text.test.ts.
 */
export function describePredicate(p: Predicate): string {
  void p
  throw new Error('describePredicate: not implemented (board WP-A)')
}
