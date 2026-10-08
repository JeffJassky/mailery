/**
 * Programs engine (0.21) — plans/15-programs.md §5. Public surface of
 * `src/server/runner/programs/`. PR 4 implements; the contract below is what
 * the Mailer facade, the scheduler, dispatch and the tests call.
 *
 * Holdout assignment and the facts hash are implemented here, not stubbed:
 * both are persisted (arm on the run, hash on every decision), so changing
 * either later would silently reshuffle arms or break hash comparisons.
 */

import crypto from 'node:crypto'
import type { ObjectId } from 'mongodb'

import type { FactPredicate, Facts, Predicate, ProgramChecklistItem } from '../../../shared/types.js'
import type { ProgramArm, ProgramDecisionReason } from '../../../shared/enums.js'
import type { Collections, ProgramDecisionDoc } from '../../models/index.js'
import { notImplemented } from '../../not-implemented.js'
import type { RunnerContext } from '../index.js'
import type { SendOriginHooks } from '../send-hooks.js'

/** Event name hosts fire (externalId = subjectId) when facts change. Registered `every-time` when a factsAdapter is set. */
export const FACTS_CHANGED_EVENT = 'Facts Changed'

/** Facts inline on the decision row when their stable JSON is under this many bytes. */
export const INLINE_FACTS_MAX_BYTES = 4096

/** How long a silent `in-flight` tick waits before checking again. */
export const IN_FLIGHT_RECHECK_MS = 60 * 60 * 1000

export type ProgramTickTrigger = ProgramDecisionDoc['trigger']

export interface ProgramTickOptions {
  now?: Date
  trigger?: ProgramTickTrigger
  /** Lease owner id. Default: a per-process random id. */
  worker?: string
}

export type ProgramTickResult =
  | { status: 'skipped'; skipped: 'not_found' | 'disabled' | 'inactive' | 'leased' }
  | {
      status: 'ticked'
      decisionId: ObjectId
      reason: ProgramDecisionReason
      chosen: string | null
      attempt: number | null
      sendIds: ObjectId[]
    }

/** Run one tick for one run. The full algorithm is §5.4 of the spec. */
export async function tickProgramRun(
  _ctx: RunnerContext,
  _runId: ObjectId,
  _opts: ProgramTickOptions = {},
): Promise<ProgramTickResult> {
  return notImplemented('tickProgramRun', 'PR4')
}

export interface ProgramSchedulerResult {
  entered: number
  woken: number
  ticked: number
}

/**
 * One scheduler pass: entry scan (events named `entry.eventName` since the
 * program's watermark), Facts Changed scan (wakes matching runs: nextTickAt =
 * now), then ticks due runs (`status ∈ {active, sunset}`, `nextTickAt ≤ now`),
 * up to `programs.batchSize`. Called from the mailer tick and from `drain`.
 *
 * Must return `{0,0,0}` without touching runs when no program is enabled, so
 * hosts that never use Programs pay one indexed read per tick.
 */
export async function runProgramScheduler(ctx: RunnerContext, now: Date = new Date()): Promise<ProgramSchedulerResult> {
  const any = await ctx.collections.programs.findOne({ enabled: true, version: { $gt: 0 } }, { projection: { _id: 1 } })
  if (!any) return { entered: 0, woken: 0, ticked: 0 }
  return runProgramSchedulerPass(ctx, now)
}

async function runProgramSchedulerPass(_ctx: RunnerContext, _now: Date): Promise<ProgramSchedulerResult> {
  return notImplemented('runProgramScheduler', 'PR4')
}

/**
 * Create a run for (slug, subjectId) if none exists. Arm assigned here and
 * never changed. `nextTickAt = now`. Re-entry after completed/exited is not
 * supported in 0.21: returns `{ created: false }` with the existing run.
 */
export async function enterProgram(
  _ctx: RunnerContext,
  _slug: string,
  _subjectId: string,
  _opts: { now?: Date; entryEventAt?: Date } = {},
): Promise<{ runId: ObjectId; created: boolean }> {
  return notImplemented('enterProgram', 'PR4')
}

/**
 * `mailer.abortProgram` semantics — same as `abortFlow`: immediate; the run
 * becomes `exited` with `exitReason: 'aborted_by_host: <reason>'`; queued,
 * deferred and held sends of the run become `cancelled` (`run_inactive`).
 * No-op (`aborted: false`) when no active/sunset run exists.
 */
export async function abortProgramRun(
  _ctx: RunnerContext,
  _slug: string,
  _subjectId: string,
  _reason: string,
): Promise<{ aborted: boolean; cancelledSends: number }> {
  return notImplemented('abortProgramRun', 'PR4')
}

/**
 * `mailer.getProgramState`. Actions in priority order (ties: definition
 * order). Status is read from the run (`completedAt` → 'satisfied'), never
 * recomputed from facts. `isNext` is true for the latest decision's `chosen`
 * when that action is not satisfied. Null when the subject has no run.
 */
export async function getProgramChecklist(
  _ctx: RunnerContext,
  _slug: string,
  _subjectId: string,
): Promise<ProgramChecklistItem[] | null> {
  return notImplemented('getProgramChecklist', 'PR4')
}

/** Pure fact-leaf evaluation. See `FactPredicate` for operator semantics. */
export function evaluateFactPredicate(_leaf: FactPredicate, _facts: Facts): boolean {
  return notImplemented('evaluateFactPredicate', 'PR4')
}

/**
 * Evaluate a program predicate: `fact` leaves against `facts`;
 * `hasFiredEvent` / `notHasFiredEvent` against `mailer_events` with
 * `externalId = subjectId`; `all` / `any` / `not` recursively. Any other leaf
 * throws (publish validation keeps them out).
 */
export async function evaluateProgramPredicate(
  _pred: Predicate,
  _ctx: { facts: Facts; subjectId: string; collections: Collections; now: Date },
): Promise<boolean> {
  return notImplemented('evaluateProgramPredicate', 'PR4')
}

/** Dispatch hooks registered as `sendHooks.program` (guard = INVARIANT 19; onOutcome = INVARIANT 18). */
export const programSendHooks: SendOriginHooks = {
  async guard() {
    return notImplemented('programSendHooks.guard', 'PR4')
  },
  async onOutcome() {
    return notImplemented('programSendHooks.onOutcome', 'PR4')
  },
}

// ---------------------------------------------------------------------------
// Implemented in the contract (persisted semantics)
// ---------------------------------------------------------------------------

/**
 * Deterministic arm: first 8 hex chars of sha256(`${slug}:${subjectId}`) as
 * an integer, mod 100, compared to `pct`. Stable across processes and
 * releases; changing it would move live subjects between arms.
 */
export function holdoutArm(slug: string, subjectId: string, pct: number | undefined): ProgramArm {
  if (!pct || pct <= 0) return 'treatment'
  if (pct >= 100) return 'holdout'
  const n = parseInt(crypto.createHash('sha256').update(`${slug}:${subjectId}`).digest('hex').slice(0, 8), 16) % 100
  return n < pct ? 'holdout' : 'treatment'
}

/** JSON with object keys sorted at every depth; Dates as ISO strings; undefined dropped. */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = normalize(x)
    }
    return out
  }
  return v
}

export function factsHash(facts: Facts): string {
  return crypto.createHash('sha256').update(stableJson(facts)).digest('hex')
}
