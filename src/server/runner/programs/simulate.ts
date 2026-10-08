/**
 * Dry-run of the Program tick plus a projected send sequence (board).
 * plans/16-program-board.md §3. READ-ONLY: no writes to any collection, no
 * queue jobs, no lease. The only host calls are `factsAdapter.resolve` (subject
 * mode) and `factsAdapter.recipients` (subject mode, when the gates reach
 * step 13).
 */

import {
  SIMULATION_DEFAULT_HORIZON_DAYS,
  SIMULATION_MAX_HORIZON_DAYS,
  SIMULATION_MAX_STEPS,
  type ProgramNextReason,
  type ProgramSimulation,
  type ProgramSimulationCandidate,
  type ProgramSimulationInput,
  type ProgramSimulationStep,
  type ProgramSource,
} from '../../../shared/program-board.js'
import type { Facts, ProgramDefinition } from '../../../shared/types.js'
import type { ProgramRunActionState, ProgramRunDoc } from '../../models/index.js'
import { SUNSET_ASK_ACTION_ID } from '../../programs/validate.js'
import { computeDeliveryTime } from '../delivery-window.js'
import { isSuppressed } from '../suppression.js'
import type { RunnerContext } from '../index.js'
import { DAY_MS, HOUR_MS, holdoutArm, sendIsInFlight, timezoneFact } from './common.js'
import { toEpochMs } from './predicate.js'
import { evaluateCandidates, nextActionFlipAt, type CandidateEvaluation, type CandidateWork } from './rank.js'
import { gapMs, sunsetStageFor } from './sunset.js'

export type ProgramSimulationErrorCode = 'not_found' | 'no_definition' | 'no_facts_adapter' | 'invalid_input'

export class ProgramSimulationError extends Error {
  constructor(readonly code: ProgramSimulationErrorCode, message: string) {
    super(message)
    this.name = 'ProgramSimulationError'
  }
}

const invalid = (message: string) => new ProgramSimulationError('invalid_input', message)

/** Hard stop for the projection loop; every pass ends, moves time forward or records a step, so this is a backstop. */
const MAX_PROJECTION_PASSES = 1000

interface ValidInput {
  source?: ProgramSource
  subjectId?: string
  facts?: Facts
  now: Date
  horizonDays: number
}

function parseInput(input: ProgramSimulationInput): ValidInput {
  const { source, subjectId, facts, horizonDays } = input
  if (source !== undefined && source !== 'published' && source !== 'draft') throw invalid('source must be "published" or "draft"')
  if (subjectId !== undefined && (typeof subjectId !== 'string' || subjectId.length < 1 || subjectId.length > 256)) {
    throw invalid('subjectId must be a string of 1-256 characters')
  }
  if (horizonDays !== undefined && (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > SIMULATION_MAX_HORIZON_DAYS)) {
    throw invalid(`horizonDays must be an integer from 1 to ${SIMULATION_MAX_HORIZON_DAYS}`)
  }
  if (facts !== undefined && (facts === null || typeof facts !== 'object' || Array.isArray(facts))) throw invalid('facts must be an object')
  let now = new Date()
  if (input.now !== undefined) {
    now = new Date(input.now)
    if (Number.isNaN(now.getTime())) throw invalid('now must be a valid date')
  }
  return { source, subjectId, facts, now, horizonDays: horizonDays ?? SIMULATION_DEFAULT_HORIZON_DAYS }
}

/** The slice of run state the projection advances. */
interface Book {
  actions: Record<string, ProgramRunActionState>
  lastSentAt: Date | null
  unanswered: number
  stage: 0 | 1 | 2
  askSent: boolean
  status: ProgramRunDoc['status']
}

type Evaluate = (at: Date, actions: Book['actions']) => Promise<CandidateEvaluation>

export async function simulateProgram(
  ctx: RunnerContext,
  slug: string,
  input: ProgramSimulationInput = {},
): Promise<ProgramSimulation> {
  const opts = parseInput(input ?? {})
  const C = ctx.collections
  const doc = await C.programs.findOne({ slug })
  if (!doc) throw new ProgramSimulationError('not_found', `unknown program "${slug}"`)
  const source: ProgramSource = opts.source ?? (doc.draft ? 'draft' : 'published')
  const def = source === 'draft' ? doc.draft?.definition : doc.definition
  if (!def) throw new ProgramSimulationError('no_definition', `program "${slug}" has no ${source} definition`)
  const adapter = ctx.config.factsAdapter
  if (!adapter) throw new ProgramSimulationError('no_facts_adapter', 'programs require MailerConfig.factsAdapter')

  const { subjectId, now } = opts
  const facts: Facts = subjectId ? { ...(await adapter.resolve(subjectId)), ...opts.facts } : { ...opts.facts }
  const run = subjectId ? await C.programRuns.findOne({ programSlug: slug, subjectId }) : null
  const arm = run ? run.arm : subjectId ? holdoutArm(slug, subjectId, def.holdoutPct) : 'treatment'

  const book: Book = {
    actions: run?.actions ?? {},
    lastSentAt: run?.lastSentAt ?? null,
    unanswered: run?.unansweredAttempts ?? 0,
    stage: run?.sunsetStage ?? 0,
    askSent: run?.sunsetAskSent ?? false,
    status: run?.status ?? 'active',
  }
  // Event predicates read this subject's events; a facts-only simulation has none.
  const enteredAt = run?.enteredAt ?? now
  const evaluate: Evaluate = (at, actions) =>
    evaluateCandidates(def, actions, { facts, subjectId: subjectId ?? '', collections: C, now: at, enteredAt })

  const exited = run ? await hasExitEvent(ctx, def, run) : false
  const evaluation = await evaluate(now, book.actions)
  const candidates = candidateRows(evaluation.works)
  const next = await decideNext(ctx, { def, facts, enteredAt, subjectId, run, arm, book, exited, now, evaluation, candidates })
  const { sequence, sequenceEnd } = await project(ctx, def, facts, evaluate, { enteredAt, book, exited, now, horizonDays: opts.horizonDays })

  return {
    source,
    version: source === 'draft' ? null : doc.version,
    now,
    subjectId: subjectId ?? null,
    facts,
    run: run
      ? {
          status: run.status,
          arm: run.arm,
          unansweredAttempts: run.unansweredAttempts,
          sunsetStage: run.sunsetStage,
          lastSentAt: run.lastSentAt,
          enteredAt: run.enteredAt,
        }
      : null,
    arm,
    candidates,
    next,
    sequence,
    sequenceEnd,
  }
}

function candidateRows(works: CandidateWork[]): ProgramSimulationCandidate[] {
  return works.map((w) => ({
    actionId: w.action.id,
    title: w.action.title,
    priority: w.action.priority,
    eligible: w.eligible,
    satisfied: w.satisfied,
    blockedBy: w.blockedBy,
    ...(w.rank !== undefined ? { rank: w.rank } : {}),
    status: w.st.status,
    attempts: w.st.attempts,
    ladder: w.st.ladder,
    cooldownUntil: w.st.cooldownUntil ?? null,
  }))
}

async function hasExitEvent(ctx: RunnerContext, def: ProgramDefinition, run: ProgramRunDoc): Promise<boolean> {
  if (!def.exit.eventNames?.length) return false
  const ev = await ctx.collections.events.findOne(
    { externalId: run.subjectId, name: { $in: def.exit.eventNames }, occurredAt: { $gt: run.entryEventAt } },
    { projection: { _id: 1 } },
  )
  return !!ev
}

/** The earliest cooldown end after `at`, or null. */
function earliestCooldown(works: CandidateWork[], at: Date): Date | null {
  const times = works
    .map((w) => w.st.cooldownUntil)
    .filter((d): d is Date => !!d && d.getTime() > at.getTime())
    .map((d) => d.getTime())
  return times.length ? new Date(Math.min(...times)) : null
}

function earlier(a: Date | null, b: Date | null): Date | null {
  return a && b ? (a.getTime() <= b.getTime() ? a : b) : (a ?? b)
}

/** Why a program cannot send this template, in the tick's words; null when it can. */
async function templateDrift(ctx: RunnerContext, def: ProgramDefinition, slug: string): Promise<string | null> {
  const t = await ctx.collections.templates.findOne({ slug }, { projection: { kind: 1, category: 1 } })
  if (!t) return `template "${slug}" is missing`
  if (t.kind !== 'marketing') return `template "${slug}" is ${t.kind}, not marketing`
  if ((t.category ?? null) !== def.category) return `template "${slug}" has category ${t.category ?? '(none)'}, not ${def.category}`
  return null
}

interface Choice {
  first: CandidateWork
  asking: boolean
  actionId: string
  attempt: number
  templateSlug: string
}

/** What the tick would send: the first ranked candidate, or the sunset ask once the run is at stage 2. */
function chooseNext(def: ProgramDefinition, ranked: CandidateWork[], book: Pick<Book, 'stage' | 'askSent'>): Choice | null {
  const first = ranked[0]
  if (!first) return null
  const sunset = def.policy.sunset
  if (sunset && book.stage === 2 && !book.askSent) {
    return { first, asking: true, actionId: SUNSET_ASK_ACTION_ID, attempt: 1, templateSlug: sunset.askTemplateSlug }
  }
  const attemptIndex = first.st.attempts
  return {
    first,
    asking: false,
    actionId: first.action.id,
    attempt: attemptIndex + 1,
    templateSlug: first.action.attempts[attemptIndex]!.deliveries[0]!.templateSlug,
  }
}

/** Earliest instant the choice may go out: after the session rule and the gap, inside the delivery window. */
function sendTimeFor(
  def: ProgramDefinition,
  facts: Facts,
  choice: Choice,
  book: Book,
  from: Date,
): { at: Date; gate: 'session-suppressed' | 'min-gap' | null } {
  let sessionUntil = 0
  const hours = def.policy.suppressIfSessionWithinHours
  if (hours !== undefined) {
    const lastSession = toEpochMs(facts.last_session_at)
    if (Number.isFinite(lastSession)) sessionUntil = lastSession + hours * HOUR_MS
  }
  const gap = gapMs(def, choice.asking ? undefined : choice.first.action, choice.asking ? 0 : choice.first.st.attempts, book.stage)
  const gapUntil = book.lastSentAt ? book.lastSentAt.getTime() + gap : 0
  const earliest = new Date(Math.max(from.getTime(), sessionUntil, gapUntil))
  const at = def.policy.delivery ? computeDeliveryTime(earliest, def.policy.delivery, timezoneFact(facts) ?? undefined) : earliest
  const gate = sessionUntil > from.getTime() ? 'session-suppressed' : gapUntil > from.getTime() ? 'min-gap' : null
  return { at, gate }
}

interface NextArgs {
  def: ProgramDefinition
  facts: Facts
  enteredAt: Date
  subjectId: string | undefined
  run: ProgramRunDoc | null
  arm: 'treatment' | 'holdout'
  book: Book
  exited: boolean
  now: Date
  evaluation: CandidateEvaluation
  /** Mutated: a template drift marks the chosen row ineligible, as the tick does. */
  candidates: ProgramSimulationCandidate[]
}

/** One tick at `now`, in the tick's order (§5.4 steps 3–14). */
async function decideNext(ctx: RunnerContext, a: NextArgs): Promise<ProgramSimulation['next']> {
  const { def, run, book, now, evaluation } = a
  const silent = (reason: ProgramNextReason): ProgramSimulation['next'] => ({
    reason,
    actionId: null,
    attempt: null,
    templateSlug: null,
    at: null,
  })

  if (run && (run.status === 'completed' || run.status === 'exited')) return silent(run.status)
  if (run?.status === 'sunset') return silent('sunset')
  if (a.exited) return silent('exited')
  if (evaluation.done) return silent('completed')

  const choice = chooseNext(def, evaluation.ranked, book)
  const chosen = (reason: ProgramNextReason, at: Date | null, detail?: string): ProgramSimulation['next'] => ({
    reason,
    actionId: choice?.actionId ?? null,
    attempt: choice?.attempt ?? null,
    templateSlug: choice?.templateSlug ?? null,
    at,
    ...(detail ? { detail } : {}),
  })
  if (!choice) return chosen('none-eligible', earlier(earliestCooldown(evaluation.works, now), nextActionFlipAt(evaluation.works, a.facts, a.enteredAt, now)))

  if (run?.inFlight) {
    const rows = await ctx.collections.sends.find({ _id: { $in: run.inFlight.sendIds } }).toArray()
    if (rows.some((s) => sendIsInFlight(s, now))) return chosen('in-flight', null)
  }

  const timing = sendTimeFor(def, a.facts, choice, book, now)
  if (timing.at.getTime() > now.getTime()) return chosen(timing.gate ?? 'delivery-window', timing.at)

  if (a.subjectId && !(await hasRecipient(ctx, def, a.subjectId))) return chosen('no-recipients', null)

  const drift = await templateDrift(ctx, def, choice.templateSlug)
  if (drift) {
    // Like the tick: the candidate is treated as ineligible, its rank kept.
    if (!choice.asking) {
      const row = a.candidates.find((c) => c.actionId === choice.first.action.id)
      if (row) row.blockedBy = 'ineligible'
    }
    return chosen('none-eligible', null, drift)
  }
  return chosen(a.arm === 'holdout' ? 'holdout' : 'send', now)
}

/** Step 13: at least one distinct contact with an email who is not suppressed. */
async function hasRecipient(ctx: RunnerContext, def: ProgramDefinition, subjectId: string): Promise<boolean> {
  const contacts = await ctx.config.factsAdapter!.recipients(subjectId, def.recipients)
  const seen = new Set<string>()
  for (const c of contacts ?? []) {
    if (!c || !c.email || !c.email.trim() || seen.has(c.externalId)) continue
    seen.add(c.externalId)
    if (!(await isSuppressed(ctx.collections, c.email, 'marketing', def.category)).suppressed) return true
  }
  return false
}

/**
 * The sends that follow if facts stay fixed and the subject never engages:
 * every send is accepted.
 */
async function project(
  ctx: RunnerContext,
  def: ProgramDefinition,
  facts: Facts,
  evaluate: Evaluate,
  o: { enteredAt: Date; book: Book; exited: boolean; now: Date; horizonDays: number },
): Promise<{ sequence: ProgramSimulationStep[]; sequenceEnd: ProgramSimulation['sequenceEnd'] }> {
  const sequence: ProgramSimulationStep[] = []
  const end = (sequenceEnd: ProgramSimulation['sequenceEnd']) => ({ sequence, sequenceEnd })
  const horizon = o.now.getTime() + o.horizonDays * DAY_MS
  const book: Book = { ...o.book, actions: { ...o.book.actions } }
  let t = o.now

  // A finished run never sends again, whatever the facts say now. Exit is checked before completion, as in the tick.
  if (book.status === 'completed' || book.status === 'exited') return end(book.status)
  if (o.exited) return end('exited')

  for (let pass = 0; pass < MAX_PROJECTION_PASSES; pass++) {
    if (book.status === 'sunset') return end('sunset')
    const ev = await evaluate(t, book.actions)
    // The tick persists what evaluation changed (cooldowns, reopened ladders, completions).
    for (const w of ev.works) book.actions[w.action.id] = w.st

    if (ev.done) return end('completed')

    const choice = chooseNext(def, ev.ranked, book)
    if (!choice) {
      const wake = earlier(earliestCooldown(ev.works, t), nextActionFlipAt(ev.works, facts, o.enteredAt, t))
      if (!wake) return end('none-eligible')
      t = wake
      continue
    }

    const { at } = sendTimeFor(def, facts, choice, book, t)
    if (at.getTime() > horizon) return end('horizon')
    if (at.getTime() > t.getTime()) {
      t = at
      continue
    }
    if (await templateDrift(ctx, def, choice.templateSlug)) return end('none-eligible')

    sequence.push({ at: t, actionId: choice.actionId, attempt: choice.attempt, templateSlug: choice.templateSlug, sunsetStage: book.stage })
    // Acceptance, as countAcceptedSend applies it.
    book.unanswered += 1
    book.lastSentAt = t
    if (choice.asking) {
      book.stage = 2
      book.askSent = true
      book.status = 'sunset'
    } else {
      const st = choice.first.st
      book.actions[choice.first.action.id] = { ...st, attempts: st.attempts + 1, lastSentAt: t }
      book.stage = sunsetStageFor(def, book.unanswered)
    }
    if (sequence.length >= SIMULATION_MAX_STEPS) return end('max-steps')
  }
  return end('max-steps')
}
