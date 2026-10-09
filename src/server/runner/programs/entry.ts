/**
 * Entering, aborting and reading a Program run: `enterProgram`,
 * `abortProgramRun`, `getProgramChecklist`.
 */

import type { ObjectId } from 'mongodb'

import type { ProgramChecklistItem } from '../../../shared/types.js'
import type { ProgramRunDoc } from '../../models/index.js'
import type { RunnerContext } from '../index.js'
import { holdoutArm } from './common.js'
import { cancelRunSends } from './tick.js'

/**
 * Create a run for (slug, subjectId) if none exists. Arm assigned here and
 * never changed. `nextTickAt = now`. Re-entry after completed/exited is not
 * supported in 0.21: returns `{ created: false }` with the existing run.
 */
export async function enterProgram(
  ctx: RunnerContext,
  slug: string,
  subjectId: string,
  opts: { now?: Date; entryEventAt?: Date } = {},
): Promise<{ runId: ObjectId; created: boolean }> {
  const C = ctx.collections
  const now = opts.now ?? new Date()
  const existing = await C.programRuns.findOne({ programSlug: slug, subjectId }, { projection: { _id: 1 } })
  if (existing) return { runId: existing._id as ObjectId, created: false }

  const program = await C.programs.findOne({ slug })
  if (!program) throw new Error(`enterProgram: unknown program "${slug}"`)
  if (!program.definition || program.version < 1) throw new Error(`enterProgram: program "${slug}" is not published`)

  const run: ProgramRunDoc = {
    programSlug: slug,
    programVersion: program.version,
    subjectId,
    status: 'active',
    arm: holdoutArm(slug, subjectId, program.definition.holdoutPct),
    actions: {},
    unansweredAttempts: 0,
    lastEngagementAt: null,
    sunsetStage: 0,
    sunsetAskSent: false,
    lastSentAt: null,
    inFlight: null,
    lastCountedDecisionId: null,
    nextTickAt: now,
    lease: null,
    enteredAt: now,
    entryEventAt: opts.entryEventAt ?? now,
    completedAt: null,
    exitedAt: null,
    exitReason: null,
    createdAt: now,
    updatedAt: now,
  }
  try {
    const res = await C.programRuns.insertOne(run)
    return { runId: res.insertedId, created: true }
  } catch (err: any) {
    if (err?.code !== 11000) throw err
    const winner = await C.programRuns.findOne({ programSlug: slug, subjectId }, { projection: { _id: 1 } })
    if (!winner) throw err
    return { runId: winner._id as ObjectId, created: false }
  }
}

/**
 * `mailer.abortProgram` semantics — same as `abortFlow`: immediate; the run
 * becomes `exited` with `exitReason: 'aborted_by_host: <reason>'`; queued,
 * deferred and held sends of the run become `cancelled` (`run_inactive`).
 * No-op (`aborted: false`) when no active/sunset run exists.
 */
export async function abortProgramRun(
  ctx: RunnerContext,
  slug: string,
  subjectId: string,
  reason: string,
): Promise<{ aborted: boolean; cancelledSends: number }> {
  const now = new Date()
  const run = await ctx.collections.programRuns.findOneAndUpdate(
    { programSlug: slug, subjectId, status: { $in: ['active', 'sunset'] } },
    {
      $set: {
        status: 'exited',
        exitedAt: now,
        exitReason: reason ? `aborted_by_host: ${reason}` : 'aborted_by_host',
        inFlight: null,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  )
  if (!run) return { aborted: false, cancelledSends: 0 }
  const cancelledSends = await cancelRunSends(ctx, run._id as ObjectId, now)
  return { aborted: true, cancelledSends }
}

/**
 * `mailer.getProgramState`. Actions in priority order (ties: definition
 * order). Status is read from the run (`completedAt` → 'satisfied'), never
 * recomputed from facts. `isNext` is true for the latest decision's `chosen`
 * when that action is not satisfied. Null when the subject has no run.
 */
export async function getProgramChecklist(
  ctx: RunnerContext,
  slug: string,
  subjectId: string,
): Promise<ProgramChecklistItem[] | null> {
  const C = ctx.collections
  const run = await C.programRuns.findOne({ programSlug: slug, subjectId })
  if (!run) return null
  const program = await C.programs.findOne({ slug })
  const def = program?.definition
  if (!def) return null

  const last = await C.programDecisions
    .find({ runId: run._id as ObjectId }, { projection: { chosen: 1 } })
    .sort({ at: -1, _id: -1 })
    .limit(1)
    .next()

  return def.actions
    .map((action, index) => ({ action, index }))
    .sort((x, y) => y.action.priority - x.action.priority || x.index - y.index)
    .map(({ action }) => {
      const st = run.actions?.[action.id]
      const completedAt = st?.completedAt ?? null
      const status = completedAt ? 'satisfied' : (st?.status ?? 'pending')
      return {
        actionId: action.id,
        title: action.title,
        cta: action.cta ?? null,
        status: status === 'satisfied' && !completedAt ? 'pending' : status,
        isNext: status !== 'satisfied' && last?.chosen === action.id,
        attempts: st?.attempts ?? 0,
        completedAt,
      }
    })
}
