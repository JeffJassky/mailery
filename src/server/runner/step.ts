/**
 * Flow_run state machine. One step transition per `processOneRunStep` call.
 * Idempotent — optimistic concurrency on `currentStepIndex` means two workers
 * racing on the same run advance exactly once.
 */

import type { ObjectId } from 'mongodb'

import type { FlowStep } from '../../shared/types.js'
import type { FlowRunDoc, FlowDoc } from '../models/index.js'
import { evaluatePredicate } from './predicate.js'
import type { RunnerContext } from './index.js'
import { computeDeliveryTime } from './delivery-window.js'
import { handleSend } from './send.js'

export async function processOneRunStep(runId: ObjectId, ctx: RunnerContext): Promise<void> {
  const run = await ctx.collections.flowRuns.findOne({ _id: runId })
  if (!run || run.status !== 'active') return

  const flow = await ctx.collections.flows.findOne({ _id: run.flowId })
  if (!flow) {
    await failFlowRun(run, 'flow_missing', ctx)
    return
  }

  const steps = await loadStepsForRun(run, flow, ctx)
  const step = locateStep(steps, run.currentStepIndex, run.currentBranchPath)
  if (!step) {
    await completeFlowRun(run, 'completed', ctx)
    return
  }

  const contact = await ctx.adapter.getById(run.externalId)
  if (!contact) {
    await exitFlowRun(run, 'contact_missing', ctx)
    return
  }

  // Marketing-flow subscription gate. Transactional sends bypass this at
  // send-step level (re-checked there).
  const sub = await ctx.collections.subscriptions.findOne({ externalId: run.externalId })
  if (sub && sub.status !== 'subscribed') {
    await exitFlowRun(run, sub.status, ctx)
    return
  }

  switch (step.type) {
    case 'wait':
      return handleWait(run, step, ctx)
    case 'condition':
      return handleCondition(run, step, contact, ctx)
    case 'branch':
      return handleBranch(run, step, contact, ctx)
    case 'send': {
      // Delivery window: push the send to the next allowed slot (weekday /
      // time-of-day, optionally in the contact's timezone) before rendering.
      if (step.delivery) {
        const deliverAt = computeDeliveryTime(new Date(), step.delivery, contact.timezone)
        if (deliverAt.getTime() > Date.now() + 30_000) {
          return deferSendForWindow(run, deliverAt, ctx)
        }
      }
      return handleSend(run, step, contact, flow, ctx)
    }
    case 'tag':
      return handleTag(run, step, ctx)
    case 'fire_event':
      return handleFireEvent(run, step, ctx)
    case 'webhook':
      return handleWebhookStep(run, step, ctx)
    case 'exit':
      return exitFlowRun(run, step.reason ?? 'exit_step', ctx)
  }
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

async function handleWait(
  run: FlowRunDoc,
  step: Extract<FlowStep, { type: 'wait' }>,
  ctx: RunnerContext,
): Promise<void> {
  const ms = unitToMs(step.value, step.unit)
  const nextAt = new Date(Date.now() + ms)

  const updated = await ctx.collections.flowRuns.findOneAndUpdate(
    { _id: run._id, currentStepIndex: run.currentStepIndex },
    {
      $set: { nextActionAt: nextAt, attemptsForCurrentStep: 0, updatedAt: new Date() },
      $inc: { currentStepIndex: 1 },
      $push: {
        history: {
          stepIndex: run.currentStepIndex,
          action: 'wait_started',
          at: new Date(),
          details: { until: nextAt },
        },
      },
    },
    { returnDocument: 'after' },
  )

  if (!updated) return // another worker advanced; their job will fire.

  await ctx.queues.advance.add(
    'advance',
    { flowRunId: String(run._id) },
    { delay: ms, jobId: `advance:${run._id}:${run.currentStepIndex + 1}` },
  )
}

async function handleCondition(
  run: FlowRunDoc,
  step: Extract<FlowStep, { type: 'condition' }>,
  contact: Awaited<ReturnType<typeof ctx.adapter.getById>>,
  ctx: RunnerContext,
): Promise<void> {
  if (!contact) return
  const result = await evaluatePredicate(step.test, { contact, run, collections: ctx.collections })

  if (result) {
    await advanceStep(run, ctx, { action: 'condition_evaluated', details: { result: true } })
    return
  }
  if (step.ifFalse === 'continue') {
    await advanceStep(run, ctx, { action: 'condition_evaluated', details: { result: false, skipped: 1 } }, { stepInc: 2 })
    return
  }
  await exitFlowRun(run, 'condition_false', ctx)
}

async function handleBranch(
  run: FlowRunDoc,
  step: Extract<FlowStep, { type: 'branch' }>,
  contact: Awaited<ReturnType<typeof ctx.adapter.getById>>,
  ctx: RunnerContext,
): Promise<void> {
  if (!contact) return
  const result = await evaluatePredicate(step.test, { contact, run, collections: ctx.collections })
  const newPath = [...run.currentBranchPath, run.currentStepIndex, result ? 'true' : 'false', 0] as Array<number | 'true' | 'false'>

  const updated = await ctx.collections.flowRuns.findOneAndUpdate(
    { _id: run._id, currentStepIndex: run.currentStepIndex },
    {
      $set: {
        currentBranchPath: newPath,
        currentStepIndex: 0,
        nextActionAt: new Date(),
        attemptsForCurrentStep: 0,
        updatedAt: new Date(),
      },
      $push: {
        history: {
          stepIndex: run.currentStepIndex,
          action: 'branch_taken',
          at: new Date(),
          details: { result },
        },
      },
    },
    { returnDocument: 'after' },
  )

  if (!updated) return
  await ctx.queues.advance.add('advance', { flowRunId: String(run._id) })
}

async function handleTag(
  run: FlowRunDoc,
  step: Extract<FlowStep, { type: 'tag' }>,
  ctx: RunnerContext,
): Promise<void> {
  const adds = step.addTags ?? []
  const removes = step.removeTags ?? []

  if (ctx.adapter.addTags && adds.length > 0) {
    await ctx.adapter.addTags(run.externalId, adds)
  } else if (adds.length > 0) {
    await ctx.collections.contactTags.bulkWrite(
      adds.map((tag) => ({
        updateOne: {
          filter: { externalId: run.externalId, tag },
          update: { $setOnInsert: { externalId: run.externalId, tag, appliedBy: 'flow', appliedAt: new Date() } },
          upsert: true,
        },
      })),
    )
  }

  if (ctx.adapter.removeTags && removes.length > 0) {
    await ctx.adapter.removeTags(run.externalId, removes)
  } else if (removes.length > 0) {
    await ctx.collections.contactTags.deleteMany({ externalId: run.externalId, tag: { $in: removes } })
  }

  await advanceStep(run, ctx, { action: 'tagged', details: { addTags: adds, removeTags: removes } })
}

async function handleFireEvent(
  run: FlowRunDoc,
  step: Extract<FlowStep, { type: 'fire_event' }>,
  ctx: RunnerContext,
): Promise<void> {
  const dedupeKey = `flowrun:${run._id}:step${run.currentStepIndex}:${step.eventName}`
  try {
    await ctx.collections.events.insertOne({
      externalId: run.externalId,
      name: step.eventName,
      properties: step.properties ?? {},
      dedupeKey,
      occurredAt: new Date(),
      createdAt: new Date(),
    })
  } catch (err: any) {
    if (err?.code !== 11000) throw err
  }
  await advanceStep(run, ctx, { action: 'event_fired', details: { name: step.eventName } })
}

async function handleWebhookStep(
  run: FlowRunDoc,
  step: Extract<FlowStep, { type: 'webhook' }>,
  ctx: RunnerContext,
): Promise<void> {
  try {
    const res = await fetch(step.url, {
      method: step.method ?? 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(step.payload ?? { externalId: run.externalId, flowRunId: String(run._id) }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`webhook step returned ${res.status}`)
    await advanceStep(run, ctx, { action: 'webhook_called', details: { url: step.url, status: res.status } })
  } catch (err: any) {
    const attempts = (run.attemptsForCurrentStep ?? 0) + 1
    if (attempts >= ctx.config.webhookRetryAttempts) {
      if (step.failureMode === 'fail_run') {
        await failFlowRun(run, `webhook failed: ${err?.message}`, ctx)
      } else {
        // Soft fail — log and advance.
        await advanceStep(run, ctx, {
          action: 'webhook_called',
          details: { url: step.url, error: err?.message, exhausted: true },
        })
      }
    } else {
      await ctx.collections.flowRuns.updateOne(
        { _id: run._id, currentStepIndex: run.currentStepIndex },
        { $inc: { attemptsForCurrentStep: 1 }, $set: { nextActionAt: new Date(Date.now() + 60_000) } },
      )
      await ctx.queues.advance.add(
        'advance',
        { flowRunId: String(run._id) },
        { delay: 60_000, jobId: `advance:${run._id}:${run.currentStepIndex}:retry-${attempts}` },
      )
    }
  }
}

/**
 * Park the run on the SAME step until the delivery window opens, then let the
 * normal advance job re-enter processOneRunStep — at which point the window
 * check passes and handleSend runs. Idempotent via the jobId (one defer job
 * per step per slot) and the nextActionAt guard.
 */
async function deferSendForWindow(run: FlowRunDoc, deliverAt: Date, ctx: RunnerContext): Promise<void> {
  const updated = await ctx.collections.flowRuns.findOneAndUpdate(
    // Only write once per deferral — if nextActionAt already points at (or
    // past) the slot, another worker/tick got here first.
    { _id: run._id, currentStepIndex: run.currentStepIndex, nextActionAt: { $lt: deliverAt } },
    {
      $set: { nextActionAt: deliverAt, updatedAt: new Date() },
      $push: {
        history: {
          stepIndex: run.currentStepIndex,
          action: 'send_deferred' as const,
          at: new Date(),
          details: { until: deliverAt },
        },
      },
    },
    { returnDocument: 'after' },
  )
  if (!updated) return

  await ctx.queues.advance.add(
    'advance',
    { flowRunId: String(run._id) },
    {
      delay: Math.max(0, deliverAt.getTime() - Date.now()),
      jobId: `advance:${run._id}:${run.currentStepIndex}:window:${deliverAt.getTime()}`,
    },
  )
}

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

export interface AdvanceOptions {
  stepInc?: number
}

export interface AdvanceLog {
  action: FlowRunDoc['history'][number]['action']
  details?: Record<string, unknown>
}

export async function advanceStep(
  run: FlowRunDoc,
  ctx: RunnerContext,
  log: AdvanceLog,
  opts: AdvanceOptions = {},
): Promise<void> {
  const stepInc = opts.stepInc ?? 1
  const updated = await ctx.collections.flowRuns.findOneAndUpdate(
    { _id: run._id, currentStepIndex: run.currentStepIndex },
    {
      $set: { nextActionAt: new Date(), attemptsForCurrentStep: 0, updatedAt: new Date() },
      $inc: { currentStepIndex: stepInc },
      $push: {
        history: { stepIndex: run.currentStepIndex, action: log.action, at: new Date(), details: log.details },
      },
    },
    { returnDocument: 'after' },
  )
  if (!updated) return
  await ctx.queues.advance.add('advance', { flowRunId: String(run._id) })
}

export async function exitFlowRun(run: FlowRunDoc, reason: string, ctx: RunnerContext): Promise<void> {
  await ctx.collections.flowRuns.updateOne(
    { _id: run._id, status: 'active' },
    {
      $set: { status: 'exited', exitedAt: new Date(), exitReason: reason, updatedAt: new Date() },
      $push: { history: { stepIndex: run.currentStepIndex, action: 'exited', at: new Date(), details: { reason } } },
    },
  )
}

export async function completeFlowRun(run: FlowRunDoc, reason: string, ctx: RunnerContext): Promise<void> {
  await ctx.collections.flowRuns.updateOne(
    { _id: run._id, status: 'active' },
    {
      $set: { status: 'completed', exitedAt: new Date(), exitReason: reason, updatedAt: new Date() },
    },
  )
}

export async function failFlowRun(run: FlowRunDoc, reason: string, ctx: RunnerContext): Promise<void> {
  await ctx.collections.flowRuns.updateOne(
    { _id: run._id, status: 'active' },
    {
      $set: { status: 'failed', exitedAt: new Date(), exitReason: reason, updatedAt: new Date() },
      $push: { history: { stepIndex: run.currentStepIndex, action: 'failed', at: new Date(), details: { reason } } },
    },
  )
}

export async function loadStepsForRun(
  run: FlowRunDoc,
  flow: FlowDoc,
  ctx: RunnerContext,
): Promise<FlowStep[]> {
  if (run.flowVersion === flow.version) return flow.steps
  const snapshot = await ctx.collections.flowVersions.findOne({ flowId: run.flowId, version: run.flowVersion })
  return snapshot?.steps ?? flow.steps
}

/**
 * Walk a branch path through nested branch steps to find the active step.
 * Branch path layout: [parentStepIndex, 'true'|'false', childStepIndex, ...repeat]
 */
export function locateStep(
  steps: FlowStep[],
  currentStepIndex: number,
  branchPath: ReadonlyArray<number | 'true' | 'false'>,
): FlowStep | null {
  let arr: FlowStep[] = steps

  for (let i = 0; i < branchPath.length; i += 3) {
    const parentIndex = branchPath[i] as number
    const branchKey = branchPath[i + 1] as 'true' | 'false'
    const parent = arr[parentIndex]
    if (!parent || parent.type !== 'branch') return null
    arr = branchKey === 'true' ? parent.ifTrueSteps : parent.ifFalseSteps
  }

  return arr[currentStepIndex] ?? null
}

function unitToMs(value: number, unit: 'minutes' | 'hours' | 'days' | 'weeks'): number {
  const m = 60_000
  switch (unit) {
    case 'minutes':
      return value * m
    case 'hours':
      return value * 60 * m
    case 'days':
      return value * 24 * 60 * m
    case 'weeks':
      return value * 7 * 24 * 60 * m
  }
}
