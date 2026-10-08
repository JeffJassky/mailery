/**
 * Step 4–5 of the tick (§5.4), shared by the tick and the simulator so the
 * board can never disagree with what the engine does. Board WP-A extracts
 * this from tick.ts verbatim; tick.ts then calls it.
 */

import type { Facts, ProgramAction, ProgramDefinition } from '../../../shared/types.js'
import type { Collections, ProgramBlockedBy, ProgramDecisionCandidate, ProgramRunActionState } from '../../models/index.js'

export interface CandidateWork {
  action: ProgramAction
  /** The run's stored state for the action, or null (never touched). */
  initial: ProgramRunActionState | null
  /** Working copy, mutated by evaluation (status, completedAt, cooldown, fresh ladder). */
  st: ProgramRunActionState
  eligible: boolean
  satisfied: boolean
  blockedBy: ProgramBlockedBy
  rank?: number
}

export interface CandidateEvaluation {
  /** In evaluation order: priority desc, ties by definition order. */
  works: CandidateWork[]
  /** Action ids whose `satisfied` predicate became true on this evaluation. */
  newlySatisfied: string[]
  candidates: ProgramDecisionCandidate[]
  /** `works` with a rank, in rank order. */
  ranked: CandidateWork[]
  /** Step 5: every action satisfied, or exhausted with `skip` and no cooldown. */
  done: boolean
}

/**
 * Evaluate every action against `facts` at `now`. Never writes. `runActions`
 * is the run's `actions` map (undefined/empty for a fresh run); it is not
 * mutated — working copies are.
 */
export async function evaluateCandidates(
  def: ProgramDefinition,
  runActions: Record<string, ProgramRunActionState> | undefined,
  predCtx: { facts: Facts; subjectId: string; collections: Collections; now: Date },
): Promise<CandidateEvaluation> {
  void def
  void runActions
  void predCtx
  throw new Error('evaluateCandidates: not implemented (board WP-A)')
}

export function freshActionState(action: ProgramAction): ProgramRunActionState {
  void action
  throw new Error('freshActionState: not implemented (board WP-A; move from tick.ts)')
}
