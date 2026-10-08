/**
 * Programs engine (0.21) — plans/15-programs.md §5. Public surface of
 * `src/server/runner/programs/`: the Mailer facade, the scheduler, dispatch and
 * the tests call these.
 *
 *   tick.ts       the tick (§5.4 steps 0–15)
 *   scheduler.ts  entry scan, Facts Changed scan, due runs
 *   entry.ts      enterProgram, abortProgramRun, getProgramChecklist
 *   hooks.ts      dispatch guard + outcome hooks, template vars
 *   predicate.ts  program predicates
 *   lease.ts      per-run tick lease
 *   sunset.ts     sunset stage and gap arithmetic
 *   common.ts     constants, holdout assignment, facts hash
 *
 * Holdout assignment and the facts hash are persisted (arm on the run, hash on
 * every decision), so changing either later would silently reshuffle arms or
 * break hash comparisons.
 */

import type { ObjectId } from 'mongodb'

import type { ProgramDecisionReason } from '../../../shared/enums.js'
import type { ProgramDecisionDoc } from '../../models/index.js'
import type { RunnerContext } from '../index.js'
import { runProgramSchedulerPass } from './scheduler.js'

export {
  FACTS_CHANGED_EVENT,
  INLINE_FACTS_MAX_BYTES,
  IN_FLIGHT_RECHECK_MS,
  holdoutArm,
  stableJson,
  factsHash,
} from './common.js'
export { tickProgramRun } from './tick.js'
export { enterProgram, abortProgramRun, getProgramChecklist } from './entry.js'
export { evaluateFactPredicate, evaluateProgramPredicate } from './predicate.js'
export { programSendHooks, programRenderVars } from './hooks.js'

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
