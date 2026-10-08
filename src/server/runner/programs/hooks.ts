/**
 * Dispatch hooks for the `program` origin (`sendHooks.program`).
 *
 *   guard      — INVARIANT 19: re-verify against fresh facts immediately
 *                before the provider call, after any deferral.
 *   onOutcome  — INVARIANT 18: the attempt is consumed only here, on an
 *                accepted send, once per decision.
 *
 * Also the render-time vars for program sends (§5.12).
 */

import type { ObjectId } from 'mongodb'

import type { Facts, ProgramDefinition } from '../../../shared/types.js'
import type { ProgramDecisionDoc, SendDoc } from '../../models/index.js'
import { SUNSET_ASK_ACTION_ID } from '../../programs/validate.js'
import type { RunnerContext } from '../index.js'
import type { SendOriginHooks } from '../send-hooks.js'
import { DAY_MS, sendIsInFlight } from './common.js'
import { evaluateProgramPredicate } from './predicate.js'
import { gapMs, sunsetStageFor } from './sunset.js'

const ACTIVE: Array<'active' | 'sunset'> = ['active', 'sunset']

/**
 * Facts the guard resolved for a send, kept for the render a moment later so a
 * dispatch costs one `resolve`, not two. Keyed by the claimed send object that
 * `dispatchSend` hands to both the guard and the renderer.
 */
const guardFacts = new WeakMap<object, Facts>()

export const programSendHooks: SendOriginHooks = {
  async guard(send, ctx) {
    const info = send.program
    if (!info) return { verdict: 'send' }
    const C = ctx.collections

    const run = await C.programRuns.findOne({ _id: info.runId })
    if (!run || !(ACTIVE as string[]).includes(run.status)) {
      return { verdict: 'cancel', exitReason: 'run_inactive', message: 'program run is no longer active' }
    }
    const program = await C.programs.findOne({ slug: info.slug })
    const def = program?.definition
    if (!program || !program.enabled || !def) {
      return { verdict: 'cancel', exitReason: 'run_inactive', message: 'program is disabled or unpublished' }
    }

    // The sunset ask is not an action: nothing to re-verify beyond the run itself.
    if (info.actionId === SUNSET_ASK_ACTION_ID) return { verdict: 'send' }

    const action = def.actions.find((a) => a.id === info.actionId)
    if (!action) {
      return { verdict: 'cancel', exitReason: 'ineligible_before_send', message: `action ${info.actionId} was removed from the program` }
    }

    const adapter = ctx.config.factsAdapter
    if (!adapter) throw new Error('Programs require MailerConfig.factsAdapter')
    const facts = await adapter.resolve(info.subjectId) // a throw fails the send closed
    guardFacts.set(send, facts)
    const now = new Date()
    const predCtx = { facts, subjectId: info.subjectId, collections: C, now }

    const done = run.actions?.[action.id]?.completedAt != null || (await evaluateProgramPredicate(action.satisfied, predCtx))
    if (done) {
      // Monotonic (INVARIANT 21): set once, never cleared.
      await C.programRuns.updateOne(
        { _id: run._id, $or: [{ [`actions.${action.id}.completedAt`]: null }, { [`actions.${action.id}`]: { $exists: false } }] },
        { $set: { [`actions.${action.id}.completedAt`]: now, [`actions.${action.id}.status`]: 'satisfied' } },
      )
      return { verdict: 'cancel', exitReason: 'satisfied_before_send', message: `action ${action.id} is already satisfied` }
    }
    if (action.eligible && !(await evaluateProgramPredicate(action.eligible, predCtx))) {
      return { verdict: 'cancel', exitReason: 'ineligible_before_send', message: `action ${action.id} is no longer eligible` }
    }
    return { verdict: 'send' }
  },

  async onOutcome(send, outcome, ctx) {
    const info = send.program
    if (!info) return
    switch (outcome.status) {
      case 'sent':
        await countAcceptedSend(send, outcome.at, ctx)
        await setOutcome(ctx, info.decisionId, { status: 'sent', at: outcome.at }, true)
        break
      case 'deferred':
        await setOutcome(ctx, info.decisionId, { status: 'deferred', at: new Date(), notBefore: outcome.notBefore })
        await markPolicySilence(ctx, info.decisionId)
        await ctx.collections.programRuns.updateOne(
          { _id: info.runId, status: { $in: ACTIVE } },
          { $set: { nextTickAt: outcome.notBefore } },
        )
        return
      case 'cancelled':
        await setOutcome(ctx, info.decisionId, { status: 'cancelled', at: new Date(), exitReason: outcome.exitReason })
        if (outcome.exitReason === 'policy_expired') await markPolicySilence(ctx, info.decisionId)
        break
      case 'suppressed':
        await setOutcome(ctx, info.decisionId, { status: 'suppressed', at: new Date() })
        break
      case 'failed':
        // Not terminal: the queue retries. The tick treats it as in flight for IN_FLIGHT_RECHECK_MS.
        await setOutcome(ctx, info.decisionId, { status: 'failed', at: new Date() })
        return
    }
    await clearInFlightIfSettled(ctx, info.runId, info.decisionId)
  },
}

// ---------------------------------------------------------------------------

type OutcomeDoc = NonNullable<ProgramDecisionDoc['outcome']>

/** `sent` always wins; any other status never overwrites a recorded `sent`. */
async function setOutcome(ctx: RunnerContext, decisionId: ObjectId, outcome: OutcomeDoc, force = false): Promise<void> {
  const filter = force ? { _id: decisionId } : { _id: decisionId, 'outcome.status': { $ne: 'sent' } }
  await ctx.collections.programDecisions.updateOne(filter, { $set: { outcome } })
}

/** The contact policy held this decision's send back; the tick had nothing to do with it. */
async function markPolicySilence(ctx: RunnerContext, decisionId: ObjectId): Promise<void> {
  await ctx.collections.programDecisions.updateOne(
    { _id: decisionId, 'outcome.status': { $ne: 'sent' } },
    { $set: { reason: 'policy-silence' } },
  )
}

async function clearInFlightIfSettled(ctx: RunnerContext, runId: ObjectId, decisionId: ObjectId): Promise<void> {
  const run = await ctx.collections.programRuns.findOne({ _id: runId }, { projection: { inFlight: 1 } })
  if (!run?.inFlight || String(run.inFlight.decisionId) !== String(decisionId)) return
  const rows = await ctx.collections.sends
    .find({ _id: { $in: run.inFlight.sendIds } }, { projection: { status: 1, queuedAt: 1 } })
    .toArray()
  const now = new Date()
  if (rows.some((s) => sendIsInFlight(s, now))) return
  await ctx.collections.programRuns.updateOne({ _id: runId, 'inFlight.decisionId': decisionId }, { $set: { inFlight: null } })
}

/**
 * An accepted send consumes the attempt — once per decision (INVARIANT 18),
 * however many recipients it fanned out to and however often dispatch re-runs.
 */
async function countAcceptedSend(send: SendDoc, at: Date, ctx: RunnerContext): Promise<void> {
  const info = send.program!
  const C = ctx.collections
  if (info.counted) return

  const before = await C.programRuns.findOneAndUpdate(
    { _id: info.runId, lastCountedDecisionId: { $ne: info.decisionId } },
    { $set: { lastCountedDecisionId: info.decisionId } },
    { returnDocument: 'before' },
  )
  await C.sends.updateOne({ _id: send._id }, { $set: { 'program.counted': true } })
  if (!before) return // another recipient's send already counted this decision

  const program = await C.programs.findOne({ slug: info.slug })
  const def = program?.definition ?? null
  const isAsk = info.actionId === SUNSET_ASK_ACTION_ID
  const action = def?.actions.find((a) => a.id === info.actionId)
  const unanswered = before.unansweredAttempts + 1
  const stage = isAsk ? 2 : def ? sunsetStageFor(def, unanswered) : before.sunsetStage
  const attemptsAfter = (before.actions?.[info.actionId]?.attempts ?? 0) + 1

  const set: Record<string, unknown> = { sunsetStage: stage }
  if (!before.lastSentAt || before.lastSentAt.getTime() < at.getTime()) set.lastSentAt = at
  const inc: Record<string, number> = { unansweredAttempts: 1 }
  if (!isAsk) {
    inc[`actions.${info.actionId}.attempts`] = 1
    set[`actions.${info.actionId}.lastSentAt`] = at
  }
  const live = (ACTIVE as string[]).includes(before.status)
  if (isAsk) {
    set.sunsetAskSent = true
    if (live) set.status = 'sunset'
  }
  if (live && def) set.nextTickAt = nextTickAfterSend(def, at, action, isAsk ? 0 : attemptsAfter, stage)

  await C.programRuns.updateOne({ _id: info.runId }, { $set: set, $inc: inc })
}

function nextTickAfterSend(
  def: ProgramDefinition,
  at: Date,
  action: ProgramDefinition['actions'][number] | undefined,
  nextAttemptIndex: number,
  stage: number,
): Date {
  return new Date(at.getTime() + gapMs(def, action, nextAttemptIndex, stage))
}

// ---------------------------------------------------------------------------
// Render vars (§5.12)
// ---------------------------------------------------------------------------

/**
 * `program`, `action`, `attempt` and `facts` for a program send's render
 * context. They win over host-resolved vars of the same name.
 */
export async function programRenderVars(send: SendDoc, ctx: RunnerContext): Promise<Record<string, unknown>> {
  const info = send.program!
  const C = ctx.collections
  const program = await C.programs.findOne({ slug: info.slug }, { projection: { definition: 1 } })
  const def = program?.definition ?? null
  const facts: Facts = guardFacts.get(send) ?? (ctx.config.factsAdapter ? await ctx.config.factsAdapter.resolve(info.subjectId) : {})
  guardFacts.delete(send)

  const isAsk = info.actionId === SUNSET_ASK_ACTION_ID
  const action = def?.actions.find((a) => a.id === info.actionId)
  const total = isAsk ? 1 : (action?.attempts.length ?? info.attempt)

  const first = await C.sends
    .find(
      { 'program.runId': info.runId, 'program.actionId': info.actionId, 'program.ladder': info.ladder },
      { projection: { queuedAt: 1 } },
    )
    .sort({ queuedAt: 1, _id: 1 })
    .limit(1)
    .next()
  const daysSinceFirst = first ? Math.max(0, Math.floor((Date.now() - first.queuedAt.getTime()) / DAY_MS)) : 0

  return {
    program: { slug: info.slug },
    action: {
      id: info.actionId,
      title: isAsk ? 'Still want these emails?' : (action?.title ?? info.actionId),
      ...(action?.cta ? { cta: { label: action.cta.label, url: action.cta.url } } : {}),
    },
    attempt: { n: info.attempt, total, isLast: info.attempt >= total, daysSinceFirst },
    facts,
  }
}
