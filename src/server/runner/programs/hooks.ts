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

    // The template may have drifted since the tick chose it (INVARIANT 3/4/8):
    // a program sends marketing mail in its own category, nothing else.
    const tpl = await C.templates.findOne({ _id: send.templateId }, { projection: { kind: 1, category: 1 } })
    if (!tpl || tpl.kind !== 'marketing' || (tpl.category ?? null) !== def.category) {
      const why = !tpl ? 'is missing' : tpl.kind !== 'marketing' ? `is now ${tpl.kind}, not marketing` : `is now in category ${tpl.category ?? '(none)'}, not ${def.category}`
      return { verdict: 'cancel', exitReason: 'ineligible_before_send', message: `template ${send.templateSlug} ${why}` }
    }

    // The sunset ask is not an action: it is only valid while the run is still waiting to ask.
    if (info.actionId === SUNSET_ASK_ACTION_ID) return sunsetAskVerdict(run, info.decisionId, ctx)

    const action = def.actions.find((a) => a.id === info.actionId)
    if (!action) {
      return { verdict: 'cancel', exitReason: 'ineligible_before_send', message: `action ${info.actionId} was removed from the program` }
    }

    const adapter = ctx.config.factsAdapter
    if (!adapter) throw new Error('Programs require MailerConfig.factsAdapter')
    const facts = await adapter.resolve(info.subjectId) // a throw fails the send closed
    guardFacts.set(send, facts)
    const now = new Date()
    const predCtx = { facts, subjectId: info.subjectId, collections: C, now, enteredAt: run.enteredAt }

    const done = run.actions?.[action.id]?.completedAt != null || (await evaluateProgramPredicate(action.satisfied, predCtx))
    if (done) {
      // Monotonic (INVARIANT 21): set once, never cleared.
      const key = `actions.${action.id}`
      // A complete state if the run never saw this action; otherwise just the two fields.
      const created = await C.programRuns.updateOne(
        { _id: run._id, [key]: { $exists: false } },
        {
          $set: {
            [key]: {
              status: 'satisfied',
              attempts: 0,
              ladder: 1,
              lastSentAt: null,
              completedAt: now,
              exhaustedAt: null,
              cooldownUntil: null,
              version: action.version,
            },
          },
        },
      )
      if (created.modifiedCount === 0) {
        await C.programRuns.updateOne(
          { _id: run._id, [`${key}.completedAt`]: null },
          { $set: { [`${key}.completedAt`]: now, [`${key}.status`]: 'satisfied' } },
        )
      }
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
    .find({ _id: { $in: run.inFlight.sendIds } }, { projection: { status: 1, queuedAt: 1, updatedAt: 1 } })
    .toArray()
  const now = new Date()
  if (rows.some((s) => sendIsInFlight(s, now))) return
  await ctx.collections.programRuns.updateOne({ _id: runId, 'inFlight.decisionId': decisionId }, { $set: { inFlight: null } })
}

/**
 * The sunset ask only makes sense while the run is still at stage 2 with the
 * ask unsent and no engagement since the decision that chose it. A tick that
 * re-engaged the run resets all of that.
 */
async function sunsetAskVerdict(
  run: { status: string; sunsetStage: number; sunsetAskSent: boolean; lastEngagementAt: Date | null },
  decisionId: ObjectId,
  ctx: RunnerContext,
): Promise<{ verdict: 'send' } | { verdict: 'cancel'; exitReason: 'ineligible_before_send'; message: string }> {
  const decision = await ctx.collections.programDecisions.findOne({ _id: decisionId }, { projection: { at: 1 } })
  const engagedSince = !!run.lastEngagementAt && !!decision && run.lastEngagementAt.getTime() > decision.at.getTime()
  if (run.sunsetStage !== 2 || run.sunsetAskSent || engagedSince) {
    return { verdict: 'cancel', exitReason: 'ineligible_before_send', message: 'the subject re-engaged; the sunset ask is no longer due' }
  }
  return { verdict: 'send' }
}

/**
 * An accepted send consumes the attempt — once per decision (INVARIANT 18),
 * however many recipients it fanned out to and however often dispatch re-runs
 * (and however often the tick's reconciliation calls it for a send whose hook
 * never ran).
 *
 * One atomic pipeline update guarded on `lastCountedDecisionId`: either the
 * whole count applies or none of it does, so a crash can never leave the
 * decision marked counted with the attempt missing. Only the next-tick time is
 * a second write (it depends on the counted result, and a missed one is
 * harmless: the in-flight recheck and the min-gap rule cover it).
 */
export async function countAcceptedSend(send: SendDoc, at: Date, ctx: RunnerContext): Promise<void> {
  const info = send.program!
  const C = ctx.collections
  if (info.counted) return

  const program = await C.programs.findOne({ slug: info.slug })
  const def = program?.definition ?? null
  const isAsk = info.actionId === SUNSET_ASK_ACTION_ID
  const action = def?.actions.find((a) => a.id === info.actionId)
  const lit = (v: unknown) => ({ $literal: v })

  const unansweredNew = { $add: ['$unansweredAttempts', 1] }
  const sunset = def?.policy.sunset
  const stageExpr: unknown = sunset
    ? {
        $switch: {
          branches: [
            { case: { $gte: [unansweredNew, sunset.askAfter] }, then: 2 },
            { case: { $gte: [unansweredNew, sunset.slowAfter] }, then: 1 },
          ],
          default: 0,
        },
      }
    : def
      ? 0
      : '$sunsetStage'

  // The ask moves the run to sunset only while it is still due (same rule as the guard).
  let askDue: unknown = false
  if (isAsk) {
    const decision = await C.programDecisions.findOne({ _id: info.decisionId }, { projection: { at: 1 } })
    askDue = {
      $and: [
        { $in: ['$status', ACTIVE] },
        { $eq: ['$sunsetStage', 2] },
        { $ne: ['$sunsetAskSent', true] },
        ...(decision
          ? [{ $or: [{ $eq: [{ $ifNull: ['$lastEngagementAt', null] }, null] }, { $lte: ['$lastEngagementAt', lit(decision.at)] }] }]
          : []),
      ],
    }
  }

  const set: Record<string, unknown> = {
    lastCountedDecisionId: lit(info.decisionId),
    unansweredAttempts: unansweredNew,
    sunsetStage: isAsk ? { $cond: [askDue, 2, stageExpr] } : stageExpr,
    lastSentAt: {
      $cond: [{ $or: [{ $eq: [{ $ifNull: ['$lastSentAt', null] }, null] }, { $lt: ['$lastSentAt', lit(at)] }] }, lit(at), '$lastSentAt'],
    },
  }
  if (isAsk) {
    set.sunsetAskSent = { $cond: [askDue, true, '$sunsetAskSent'] }
    set.status = { $cond: [askDue, 'sunset', '$status'] }
  } else {
    const key = info.actionId
    set.actions = {
      $mergeObjects: [
        { $ifNull: ['$actions', {}] },
        {
          [key]: {
            $mergeObjects: [
              { $ifNull: [`$actions.${key}`, {}] },
              { attempts: { $add: [{ $ifNull: [`$actions.${key}.attempts`, 0] }, 1] }, lastSentAt: lit(at) },
            ],
          },
        },
      ],
    }
  }

  const after = await C.programRuns.findOneAndUpdate(
    { _id: info.runId, lastCountedDecisionId: { $ne: info.decisionId } },
    [{ $set: set }],
    { returnDocument: 'after' },
  )
  await C.sends.updateOne({ _id: send._id }, { $set: { 'program.counted': true } })
  if (!after) return // already counted (another recipient, a replay, or the reconciliation)

  if ((ACTIVE as string[]).includes(after.status) && def) {
    const attemptsAfter = after.actions?.[info.actionId]?.attempts ?? 0
    await C.programRuns.updateOne(
      { _id: info.runId, status: { $in: ACTIVE } },
      { $set: { nextTickAt: nextTickAfterSend(def, at, action, isAsk ? 0 : attemptsAfter, after.sunsetStage) } },
    )
  }
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

  const first = await C.sends
    .find(
      { 'program.runId': info.runId, 'program.actionId': info.actionId, 'program.ladder': info.ladder },
      { projection: { queuedAt: 1 } },
    )
    .sort({ queuedAt: 1, _id: 1 })
    .limit(1)
    .next()
  const daysSinceFirst = first ? Math.max(0, Math.floor((Date.now() - first.queuedAt.getTime()) / DAY_MS)) : 0

  return buildProgramRenderVars(def, info, facts, daysSinceFirst)
}

/**
 * Pure core of `programRenderVars`, also used
 * by the template preview's `program` option. `actionId` may be
 * `$sunset-ask`. Unknown action ids fall back to the id as title and
 * `total = attempt`.
 */
export function buildProgramRenderVars(
  def: ProgramDefinition | null,
  info: { slug: string; actionId: string; attempt: number },
  facts: Facts,
  daysSinceFirst: number,
): Record<string, unknown> {
  const isAsk = info.actionId === SUNSET_ASK_ACTION_ID
  const action = def?.actions.find((a) => a.id === info.actionId)
  const total = isAsk ? 1 : (action?.attempts.length ?? info.attempt)

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
