/**
 * The Program tick — plans/15-programs.md §5.4, steps 0–15 in order.
 *
 * One tick = one run, one lease, one `factsAdapter.resolve`, one decision row.
 * The numbered comments below are the spec's step numbers.
 */

import { ObjectId } from 'mongodb'

import type { Facts, ProgramDefinition } from '../../../shared/types.js'
import type {
  ProgramDecisionCandidate,
  ProgramDecisionDoc,
  ProgramDoc,
  ProgramRunDoc,
  SendDoc,
} from '../../models/index.js'
import { SUNSET_ASK_ACTION_ID } from '../../programs/validate.js'
import { DEFAULT_BOT_UA_RE, isBotUserAgent } from '../predicate.js'
import { isSuppressed } from '../suppression.js'
import type { RunnerContext } from '../index.js'
import {
  DAY_MS,
  IN_FLIGHT_RECHECK_MS,
  INLINE_FACTS_MAX_BYTES,
  MIN_ADVANCE_MS,
  factsHash,
  sendIsInFlight,
  stableJson,
  timezoneFact,
} from './common.js'
import { countAcceptedSend } from './hooks.js'
import { acquireLease, LeaseLostError, PROCESS_WORKER, releaseLease, renewLease } from './lease.js'
import { toEpochMs } from './predicate.js'
import { evaluateCandidates, nextActionFlipAt, type CandidateWork } from './rank.js'
import { gapMs, sunsetStageFor } from './sunset.js'
import { programSendTime } from './window.js'
import type { ProgramTickOptions, ProgramTickResult } from './index.js'

const ACTIVE_STATUSES = ['active', 'sunset'] as const
/** Send statuses that mean the provider accepted the mail. */
const COUNTABLE = ['sent', 'delivered', 'bounced', 'complained']

/** Run one tick for one run. The full algorithm is §5.4 of the spec. */
export async function tickProgramRun(
  ctx: RunnerContext,
  runId: ObjectId,
  opts: ProgramTickOptions = {},
): Promise<ProgramTickResult> {
  const now = opts.now ?? new Date()
  const trigger = opts.trigger ?? 'schedule'
  const worker = opts.worker ?? PROCESS_WORKER
  const C = ctx.collections

  // 0. program / run gates (no decision row for these).
  const peek = await C.programRuns.findOne({ _id: runId })
  if (!peek) return { status: 'skipped', skipped: 'not_found' }
  const program = await C.programs.findOne({ slug: peek.programSlug })
  if (!program) return { status: 'skipped', skipped: 'not_found' }
  if (!program.enabled || !program.definition || program.version < 1) return { status: 'skipped', skipped: 'disabled' }
  if (!(ACTIVE_STATUSES as readonly string[]).includes(peek.status)) return { status: 'skipped', skipped: 'inactive' }

  // 1. lease.
  const run = await acquireLease(ctx, runId, worker, now)
  if (!run) {
    const again = await C.programRuns.findOne({ _id: runId }, { projection: { status: 1 } })
    if (again && !(ACTIVE_STATUSES as readonly string[]).includes(again.status)) return { status: 'skipped', skipped: 'inactive' }
    return { status: 'skipped', skipped: 'leased' }
  }

  try {
    return await tickLeased(ctx, run, program as ProgramDoc & { definition: ProgramDefinition }, now, trigger, worker)
  } catch (err) {
    // Another worker took the run over while this tick was in a slow host call.
    // Nothing was written on its behalf (writes are fenced on the lease).
    if (err instanceof LeaseLostError) return { status: 'skipped', skipped: 'leased' }
    throw err
  } finally {
    await releaseLease(ctx, runId, worker).catch(() => {})
  }
}

// ---------------------------------------------------------------------------

async function tickLeased(
  ctx: RunnerContext,
  run: ProgramRunDoc,
  program: ProgramDoc & { definition: ProgramDefinition },
  now: Date,
  trigger: ProgramDecisionDoc['trigger'],
  worker: string,
): Promise<ProgramTickResult> {
  const C = ctx.collections
  const def = program.definition
  const adapter = ctx.config.factsAdapter
  if (!adapter) throw new Error('Programs require MailerConfig.factsAdapter')
  const runId = run._id as ObjectId
  const decisionId = new ObjectId()
  const nowMs = now.getTime()

  // 2. facts: exactly one resolve per tick. A throw propagates; the lease is released by the caller.
  const facts: Facts = await adapter.resolve(run.subjectId)
  await renewLease(ctx, runId, worker) // the host call may have been slow
  const predCtx = { facts, subjectId: run.subjectId, collections: C, now, enteredAt: run.enteredAt }

  /** Run-document changes accumulated by this tick, applied once in `finish`. */
  const runSet: Record<string, unknown> = {}
  const works: CandidateWork[] = []

  // Working copies of the sunset state (engagement and holdout acceptance change them).
  let unanswered = run.unansweredAttempts
  let stage: 0 | 1 | 2 = run.sunsetStage
  let runStatus = run.status
  let askSent = run.sunsetAskSent
  /** The counting marker this tick's send decision is based on; the final write is conditional on it. */
  let countedAtStart = run.lastCountedDecisionId ?? null

  const insertDecision = async (r: {
    reason: ProgramDecisionDoc['reason']
    chosen: string | null
    attempt: number | null
    candidates: ProgramDecisionCandidate[]
    sendIds?: ObjectId[]
    outcome?: ProgramDecisionDoc['outcome']
  }): Promise<void> => {
    const inline = Buffer.byteLength(stableJson(facts)) < INLINE_FACTS_MAX_BYTES
    await C.programDecisions.insertOne({
      _id: decisionId,
      runId,
      programSlug: run.programSlug,
      programVersion: program.version,
      subjectId: run.subjectId,
      arm: run.arm,
      at: now,
      factsHash: factsHash(facts),
      facts: inline ? facts : null,
      candidates: r.candidates,
      chosen: r.chosen,
      attempt: r.attempt,
      reason: r.reason,
      ranker: { name: 'priority', version: 1 },
      selectionProb: 1,
      explore: false,
      sendIds: r.sendIds ?? [],
      outcome: r.outcome ?? null,
      trigger,
    })
  }

  const finish = async (r: {
    reason: ProgramDecisionDoc['reason']
    chosen: string | null
    attempt: number | null
    candidates: ProgramDecisionCandidate[]
    sendIds?: ObjectId[]
    outcome?: ProgramDecisionDoc['outcome']
    nextTickAt?: Date
    /**
     * Runs after the decision and run state are persisted (the lease is still
     * held). Send rows are created here, so a dispatch hook that fires at once
     * writes on top of finished state and nothing this tick wrote can clobber it.
     */
    after?: () => Promise<void>
  }): Promise<ProgramTickResult> => {
    const sendIds = r.sendIds ?? []
    const set: Record<string, unknown> = { ...runSet, ...actionDiffs(works), programVersion: program.version, updatedAt: now }
    if (!r.after) set.lease = null
    if (r.nextTickAt) {
      set.nextTickAt = r.nextTickAt.getTime() > nowMs ? r.nextTickAt : new Date(nowMs + MIN_ADVANCE_MS)
    }

    // The run write is fenced on the lease (a stale tick writes nothing) and,
    // when it creates sends, on the counting marker (a send accepted since the
    // fresh read is not on the tick's books, so the send decision is abandoned).
    // A Facts Changed wake that landed while this tick ran (wakeRequestedAt moved
    // since we took the lease) must not be lost: tick again soon.
    const guarded = sendIds.length > 0
    let wakeAt = run.wakeRequestedAt ?? null
    let abandoned = false
    for (let i = 0; ; i++) {
      const filter: Record<string, unknown> = { _id: runId, 'lease.worker': worker }
      if (i < 5) filter.wakeRequestedAt = wakeAt
      if (guarded) filter.lastCountedDecisionId = countedAtStart
      const res = await C.programRuns.updateOne(filter as any, { $set: set })
      if (res.matchedCount > 0) break
      const cur = await C.programRuns.findOne(
        { _id: runId },
        { projection: { lease: 1, lastCountedDecisionId: 1, wakeRequestedAt: 1 } },
      )
      if (!cur || cur.lease?.worker !== worker) throw new LeaseLostError()
      if (guarded && String(cur.lastCountedDecisionId ?? '') !== String(countedAtStart ?? '')) {
        abandoned = true
        break
      }
      wakeAt = cur.wakeRequestedAt ?? null
      if (r.nextTickAt) set.nextTickAt = new Date(nowMs + MIN_ADVANCE_MS)
    }
    if (abandoned) {
      await C.programRuns.updateOne(
        { _id: runId, 'lease.worker': worker },
        { $set: { nextTickAt: new Date(nowMs + MIN_ADVANCE_MS), updatedAt: now } },
      )
      await insertDecision({ ...r, reason: 'in-flight', sendIds: [], outcome: undefined })
      return { status: 'ticked', decisionId, reason: 'in-flight', chosen: r.chosen, attempt: r.attempt, sendIds: [] }
    }
    await settleActionDates(C, runId, works)
    await insertDecision(r)
    if (r.after) {
      await renewLease(ctx, runId, worker) // no send rows unless we still own the run
      await r.after()
    }
    return { status: 'ticked', decisionId, reason: r.reason, chosen: r.chosen, attempt: r.attempt, sendIds }
  }

  // 3. exit.
  if (def.exit.eventNames?.length) {
    const ev = await C.events
      .find({ externalId: run.subjectId, name: { $in: def.exit.eventNames }, occurredAt: { $gt: run.entryEventAt } })
      .sort({ occurredAt: 1 })
      .limit(1)
      .next()
    if (ev) {
      await cancelRunSends(ctx, runId, now)
      Object.assign(runSet, { status: 'exited', exitedAt: now, exitReason: `event:${ev.name}`, inFlight: null })
      return finish({ reason: 'exited', chosen: null, attempt: null, candidates: [] })
    }
  }

  // 4. evaluate actions in priority order, rank them, and 5. check completion.
  const evaluation = await evaluateCandidates(def, run.actions, predCtx)
  const { newlySatisfied, ranked, done } = evaluation
  works.push(...evaluation.works)
  const candidatesRows = evaluation.candidates

  if (done) {
    const fire = def.exit.onComplete?.fireEvent
    if (fire) {
      try {
        await C.events.insertOne({
          externalId: run.subjectId,
          name: fire,
          properties: { subjectType: 'account', programSlug: run.programSlug },
          dedupeKey: `program:${run.programSlug}:${run.subjectId}:complete`,
          occurredAt: now,
          createdAt: now,
        })
      } catch (err: any) {
        if (err?.code !== 11000) throw err // already fired
      }
    }
    Object.assign(runSet, { status: 'completed', completedAt: now })
    return finish({ reason: 'completed', chosen: null, attempt: null, candidates: candidatesRows })
  }

  // 6. engagement.
  const since = (run.lastEngagementAt ?? run.enteredAt).getTime()
  let engaged = newlySatisfied.length > 0
  if (!engaged) {
    const lastSession = toEpochMs(facts.last_session_at)
    engaged = Number.isFinite(lastSession) && lastSession > since
  }
  if (!engaged) engaged = await hasHumanClick(ctx, runId, new Date(since))
  if (engaged) {
    unanswered = 0
    stage = 0
    askSent = false
    if (runStatus === 'sunset') runStatus = 'active'
    Object.assign(runSet, {
      unansweredAttempts: 0,
      sunsetStage: 0,
      sunsetAskSent: false,
      lastEngagementAt: now,
      status: runStatus,
    })
  }

  // 8 (evaluated early so silent decisions keep `chosen`). The sunset ask replaces the first candidate.
  const first = ranked[0] ?? null
  const sunset = def.policy.sunset
  const asking = !!first && !!sunset && stage === 2 && !askSent
  let chosenId: string | null = first ? first.action.id : null
  let attemptNo: number | null = first ? first.st.attempts + 1 : null
  if (asking) {
    chosenId = SUNSET_ASK_ACTION_ID
    attemptNo = 1
  }
  const silent = (reason: ProgramDecisionDoc['reason'], nextTickAt: Date) =>
    finish({ reason, chosen: chosenId, attempt: attemptNo, candidates: candidatesRows, nextTickAt })

  // 7. sunset (no engagement): silent.
  if (runStatus === 'sunset') {
    const factor = sunset ? sunset.slowFactor : 1
    return silent('sunset', new Date(nowMs + def.policy.minGapDays * DAY_MS * factor))
  }
  if (!first) {
    const flip = nextActionFlipAt(works, facts, run.enteredAt, now)
    const gapEnd = nowMs + def.policy.minGapDays * DAY_MS
    return silent('none-eligible', new Date(flip ? Math.min(gapEnd, flip.getTime()) : gapEnd))
  }

  // 9. in flight.
  if (run.inFlight) {
    const rows = await C.sends.find({ _id: { $in: run.inFlight.sendIds } }).toArray()
    // A send that reached the provider but whose outcome hook never counted it
    // (a crash between the 'sent' write and the hook) is counted here, so the
    // attempt is neither lost nor replayed. Idempotent: the count is guarded.
    let reconciled = false
    for (const s of rows) {
      if (!s.program || s.program.counted || !COUNTABLE.includes(s.status)) continue
      try {
        await countAcceptedSend(s, s.sentAt ?? now, ctx)
        reconciled = true
      } catch (err) {
        console.error(`mailery: program count reconciliation failed for send ${String(s._id)}`, err)
        return silent('in-flight', new Date(nowMs + MIN_ADVANCE_MS))
      }
    }
    if (rows.some((s) => sendIsInFlight(s, now))) {
      // A queued row whose job was lost (crash between insert and enqueue) would block forever.
      // `updatedAt`, not `queuedAt`: a released deferred send is old but freshly re-queued.
      for (const s of rows) {
        if (s.status === 'queued' && nowMs - (s.updatedAt ?? s.queuedAt).getTime() >= IN_FLIGHT_RECHECK_MS) {
          await ctx.queues.send
            .add('send', { sendId: String(s._id) }, { attempts: ctx.config.sendRetryAttempts, backoff: { type: 'exponential', delay: 60_000 } })
            .catch(() => {})
        }
      }
      return silent('in-flight', new Date(nowMs + IN_FLIGHT_RECHECK_MS))
    }
    runSet.inFlight = null
    if (reconciled) return silent('in-flight', new Date(nowMs + MIN_ADVANCE_MS)) // decide again on fresh books
  }

  // A send accepted while this tick was resolving facts has moved the run's
  // counters (attempts, lastSentAt, unanswered) past our snapshot: re-read
  // before choosing an attempt or gap, and again at the write (see `finish`).
  {
    const fresh = await C.programRuns.findOne({ _id: runId }, { projection: { lastCountedDecisionId: 1, lease: 1 } })
    if (!fresh || fresh.lease?.worker !== worker) throw new LeaseLostError()
    if (String(fresh.lastCountedDecisionId ?? '') !== String(countedAtStart ?? '')) {
      return silent('in-flight', new Date(nowMs + MIN_ADVANCE_MS))
    }
  }

  // 10. session rule.
  const sessionHours = def.policy.suppressIfSessionWithinHours
  if (sessionHours !== undefined) {
    const lastSession = toEpochMs(facts.last_session_at)
    if (Number.isFinite(lastSession)) {
      const until = lastSession + sessionHours * 60 * 60 * 1000
      if (until > nowMs) return silent('session-suppressed', new Date(until))
    }
  }

  // 11. gap.
  const chosenAction = asking ? undefined : first.action
  const attemptIndex = asking ? 0 : first.st.attempts
  // Momentum (plans/17 F4): an action completed, or a human click, since the last send.
  let progress = false
  if (run.lastSentAt && def.policy.progressGapDays !== undefined) {
    const sentMs = run.lastSentAt.getTime()
    progress = works.some((w) => (w.st.completedAt?.getTime() ?? 0) > sentMs) || (await hasHumanClick(ctx, runId, run.lastSentAt))
  }
  const gap = gapMs(def, chosenAction, attemptIndex, stage, progress)
  if (run.lastSentAt) {
    const eligibleAt = run.lastSentAt.getTime() + gap
    if (eligibleAt > nowMs) return silent('min-gap', new Date(eligibleAt))
  }

  // 12. delivery window, usual hour and blackout dates.
  const tz = timezoneFact(facts)
  {
    const timing = programSendTime(now, def, facts, ctx.config.contactPolicy)
    if (timing.at.getTime() > nowMs) return silent(timing.gate ?? 'delivery-window', timing.at)
  }

  // 13. recipients.
  const contacts = await adapter.recipients(run.subjectId, def.recipients)
  await renewLease(ctx, runId, worker) // the host call may have been slow
  const seen = new Set<string>()
  const recipients = []
  for (const c of contacts ?? []) {
    if (!c || !c.email || !c.email.trim() || seen.has(c.externalId)) continue
    seen.add(c.externalId)
    const supp = await isSuppressed(C, c.email, 'marketing', def.category)
    if (supp.suppressed) continue
    recipients.push(c)
  }
  if (recipients.length === 0) {
    return silent('no-recipients', new Date(nowMs + def.policy.minGapDays * DAY_MS))
  }

  // 14. send rows.
  const templateSlug = asking ? sunset!.askTemplateSlug : first.action.attempts[first.st.attempts]!.deliveries[0]!.templateSlug
  const template = await C.templates.findOne({ slug: templateSlug })
  // A template that drifted (deleted, no longer marketing, moved to another
  // category) is treated like an ineligible candidate: nothing is sent, the
  // decision is still written, and the operator sees it in the log.
  const drift = !template
    ? 'is missing'
    : template.kind !== 'marketing'
      ? `is ${template.kind}, not marketing`
      : (template.category ?? null) !== def.category
        ? `has category ${template.category ?? '(none)'}, not ${def.category}`
        : null
  if (drift) {
    console.error(`mailery: program "${run.programSlug}": template "${templateSlug}" ${drift}; not sending`)
    if (!asking) {
      const row = candidatesRows.find((r) => r.actionId === first.action.id)
      if (row) row.blockedBy = 'ineligible'
    }
    return silent('none-eligible', new Date(nowMs + def.policy.minGapDays * DAY_MS))
  }
  if (!template) throw new Error('unreachable')
  const holdout = run.arm === 'holdout'
  const actionId = asking ? SUNSET_ASK_ACTION_ID : first.action.id
  const actionVersion = asking ? 1 : first.action.version
  const ladder = asking ? 1 : first.st.ladder
  const provider = template.providerOverride ?? ctx.config.defaultProvider

  const sendIds = recipients.map(() => new ObjectId())
  const docs: SendDoc[] = recipients.map((c, i) => ({
    _id: sendIds[i]!,
    dedupeKey: `program:${run.programSlug}:${run.subjectId}:${decisionId}:${c.externalId}`,
    externalId: c.externalId,
    emailAtSend: c.email,
    templateId: template._id!,
    templateSlug: template.slug,
    flowRunId: null,
    broadcastId: null,
    manualSendBy: null,
    kind: template.kind,
    category: def.category,
    provider,
    providerMessageId: null,
    fromName: template.fromName,
    fromEmail: template.fromEmail,
    subject: template.subject,
    bodyHash: '',
    status: holdout ? 'holdout' : 'queued',
    errorMessage: null,
    bounceType: null,
    bounceReason: null,
    links: [],
    vars: {},
    openedAt: null,
    openCount: 0,
    firstClickAt: null,
    clickCount: 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt: now,
    updatedAt: now,
    sentAt: null,
    deliveredAt: null,
    timezoneHint: tz,
    program: {
      slug: run.programSlug,
      subjectId: run.subjectId,
      runId,
      actionId,
      actionVersion,
      attempt: attemptNo!,
      ladder,
      variantId: 'default',
      decisionId,
      templateVersion: template.publishedAt ? template.publishedAt.getTime() : null,
      holdout,
      ...(holdout ? { counted: true } : {}),
    },
  }))

  if (holdout) {
    // Simulated acceptance: the same ladder effects a real accepted send has (§5.5).
    if (!asking) {
      const w = works.find((x) => x.action.id === first.action.id)!
      w.st.attempts += 1
      w.st.lastSentAt = now
    }
    unanswered += 1
    stage = asking ? 2 : sunsetStageFor(def, unanswered)
    const nextAttempt = asking ? 0 : first.st.attempts
    Object.assign(runSet, {
      lastSentAt: now,
      unansweredAttempts: unanswered,
      sunsetStage: stage,
      lastCountedDecisionId: decisionId,
      inFlight: null,
    })
    if (asking) Object.assign(runSet, { sunsetAskSent: true, status: 'sunset' })
    return finish({
      reason: 'holdout',
      chosen: chosenId,
      attempt: attemptNo,
      candidates: candidatesRows,
      sendIds,
      outcome: { status: 'holdout', at: now },
      nextTickAt: new Date(nowMs + gapMs(def, chosenAction, nextAttempt, stage)),
      // Counting state is persisted first, so a crash can lose a holdout row
      // but never replays the attempt (and never duplicates a row).
      after: async () => {
        await C.sends.insertMany(docs)
      },
    })
  }

  // In-flight marker, run state and the decision row go first; the send rows
  // and queue jobs follow (still under the lease). A dispatch hook then
  // writes on top of finished state. A crash before the rows exist leaves an
  // inFlight whose sends are missing, which the next tick treats as terminal.
  runSet.inFlight = { decisionId, actionId, attempt: attemptNo!, sendIds, at: now }
  return finish({
    reason: asking ? 'sunset' : 'highest-rank',
    chosen: chosenId,
    attempt: attemptNo,
    candidates: candidatesRows,
    sendIds,
    nextTickAt: new Date(nowMs + IN_FLIGHT_RECHECK_MS),
    after: async () => {
      await C.sends.insertMany(docs)
      for (const id of sendIds) {
        await ctx.queues.send.add(
          'send',
          { sendId: String(id) },
          { attempts: ctx.config.sendRetryAttempts, backoff: { type: 'exponential', delay: 60_000 } },
        )
      }
    },
  })
}

// ---------------------------------------------------------------------------

const DATE_FIELDS = ['lastSentAt', 'exhaustedAt', 'cooldownUntil'] as const
const PLAIN_FIELDS = ['status', 'attempts', 'ladder', 'version'] as const

/**
 * Dotted `$set` paths for the action-state fields this tick changed. Writing
 * only the diff (never the whole map) keeps a concurrent dispatch hook's
 * `attempts` increment from being overwritten by a stale copy. `completedAt`
 * and states the run has never seen go through `settleActionDates` instead, so
 * a `completedAt` the dispatch guard set meanwhile is never overwritten.
 */
function actionDiffs(works: CandidateWork[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const w of works) {
    if (!w.initial) continue
    const key = `actions.${w.action.id}`
    for (const f of PLAIN_FIELDS) if (w.st[f] !== w.initial[f]) out[`${key}.${f}`] = w.st[f]
    for (const f of DATE_FIELDS) {
      const a = w.st[f]?.getTime() ?? null
      const b = w.initial[f]?.getTime() ?? null
      if (a !== b) out[`${key}.${f}`] = w.st[f]
    }
  }
  return out
}

/**
 * First-writer-wins for the parts of action state a concurrent dispatch guard
 * can also write: a brand-new action state is created only if the run still
 * has none, and `completedAt` is set only while it is still null.
 */
async function settleActionDates(C: RunnerContext['collections'], runId: ObjectId, works: CandidateWork[]): Promise<void> {
  for (const w of works) {
    const key = `actions.${w.action.id}`
    if (!w.initial) {
      const created = await C.programRuns.updateOne({ _id: runId, [key]: { $exists: false } }, { $set: { [key]: w.st } })
      if (created.modifiedCount > 0) continue
    }
    if (w.st.completedAt && !w.initial?.completedAt) {
      await C.programRuns.updateOne(
        { _id: runId, [`${key}.completedAt`]: null },
        { $set: { [`${key}.completedAt`]: w.st.completedAt, [`${key}.status`]: 'satisfied' } },
      )
    }
  }
}

/** A non-bot click on any of the run's sends after `since`. Opens never count. */
async function hasHumanClick(ctx: RunnerContext, runId: ObjectId, since: Date): Promise<boolean> {
  const botRe = ctx.config.botFilter?.userAgentPattern ?? DEFAULT_BOT_UA_RE
  const rows = await ctx.collections.sends
    .find({ 'program.runId': runId, 'clickedLinks.clickedAt': { $gt: since } }, { projection: { clickedLinks: 1 } })
    .limit(200)
    .toArray()
  return rows.some((s) =>
    (s.clickedLinks ?? []).some((c) => c.clickedAt.getTime() > since.getTime() && !isBotUserAgent(c.userAgent, botRe)),
  )
}

/** Cancel a run's queued, deferred and held sends (`run_inactive`). Returns how many. */
export async function cancelRunSends(ctx: RunnerContext, runId: ObjectId, now: Date): Promise<number> {
  const res = await ctx.collections.sends.updateMany(
    { 'program.runId': runId, status: { $in: ['queued', 'deferred', 'held'] } },
    { $set: { status: 'cancelled', exitReason: 'run_inactive', errorMessage: 'cancelled: program run is no longer active', updatedAt: now } },
  )
  return res.modifiedCount
}
