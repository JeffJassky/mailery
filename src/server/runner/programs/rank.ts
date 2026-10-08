/**
 * Step 4–5 of the tick (§5.4), shared by the tick and the simulator so the
 * board can never disagree with what the engine does. Board WP-A extracts
 * this from tick.ts verbatim; tick.ts then calls it.
 */

import type { Facts, ProgramAction, ProgramDefinition } from '../../../shared/types.js'
import type { Collections, ProgramBlockedBy, ProgramDecisionCandidate, ProgramRunActionState } from '../../models/index.js'
import { DAY_MS } from './common.js'
import { evaluateProgramPredicate } from './predicate.js'

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
  const { now } = predCtx
  const nowMs = now.getTime()
  const ordered = def.actions
    .map((action, index) => ({ action, index }))
    .sort((x, y) => y.action.priority - x.action.priority || x.index - y.index)
    .map((x) => x.action)

  const newlySatisfied: string[] = []
  const works: CandidateWork[] = []
  for (const action of ordered) {
    const initial = runActions?.[action.id] ?? null
    const st: ProgramRunActionState = initial ? { ...initial } : freshActionState(action)
    st.version = action.version
    let satisfied = st.completedAt != null
    if (!satisfied && (await evaluateProgramPredicate(action.satisfied, predCtx))) {
      // Monotonic (INVARIANT 21): written once, never cleared.
      satisfied = true
      st.completedAt = now
      newlySatisfied.push(action.id)
    }
    if (satisfied) st.status = 'satisfied'
    const eligible = action.eligible ? await evaluateProgramPredicate(action.eligible, predCtx) : true
    works.push({ action, initial, st, eligible, satisfied, blockedBy: null })
  }

  const satisfiedIds = new Set(works.filter((w) => w.satisfied).map((w) => w.action.id))
  let holdArmed = false
  let rank = 0
  for (const w of works) {
    const { action, st } = w
    if (w.satisfied) {
      w.blockedBy = 'satisfied'
      continue
    }
    if (holdArmed) {
      w.blockedBy = 'hold'
      continue
    }
    const unmet = (action.requires ?? []).find((id) => !satisfiedIds.has(id))
    if (unmet !== undefined) {
      w.blockedBy = `requires:${unmet}`
      continue
    }
    if (!w.eligible) {
      w.blockedBy = 'ineligible'
      continue
    }
    if (st.status === 'cooldown') {
      if (st.cooldownUntil && st.cooldownUntil.getTime() > nowMs) {
        w.blockedBy = 'cooldown'
        if (action.onExhaust === 'hold') holdArmed = true
        continue
      }
      // Cooldown over: a fresh ladder.
      st.attempts = 0
      st.ladder += 1
      st.status = 'pending'
      st.exhaustedAt = null
      st.cooldownUntil = null
    }
    if (st.attempts >= action.attempts.length) {
      st.exhaustedAt = st.exhaustedAt ?? now
      if (action.cooldownDays) {
        st.status = 'cooldown'
        st.cooldownUntil = new Date(nowMs + action.cooldownDays * DAY_MS)
        w.blockedBy = 'cooldown'
      } else {
        st.status = 'exhausted'
        w.blockedBy = 'exhausted'
      }
      if (action.onExhaust === 'hold') holdArmed = true
      continue
    }
    st.status = 'pending'
    st.exhaustedAt = null
    w.rank = ++rank
  }

  const candidates: ProgramDecisionCandidate[] = works.map((w) => ({
    actionId: w.action.id,
    actionVersion: w.action.version,
    priority: w.action.priority,
    eligible: w.eligible,
    satisfied: w.satisfied,
    blockedBy: w.blockedBy,
    ...(w.rank !== undefined ? { rank: w.rank } : {}),
  }))
  const ranked = works.filter((w) => w.rank !== undefined)

  // 5. completion.
  const done = works.every(
    (w) => w.satisfied || (w.blockedBy === 'exhausted' && w.action.onExhaust === 'skip' && !w.action.cooldownDays),
  )
  return { works, newlySatisfied, candidates, ranked, done }
}

export function freshActionState(action: ProgramAction): ProgramRunActionState {
  return {
    status: 'pending',
    attempts: 0,
    ladder: 1,
    lastSentAt: null,
    completedAt: null,
    exhaustedAt: null,
    cooldownUntil: null,
    version: action.version,
  }
}
