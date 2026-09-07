/**
 * Flow simulation: "what would happen to this contact if the trigger fired
 * now?" — answered by walking the published steps against the contact's real
 * state (tags, fields, events, sends, subscription) with a virtual clock and
 * WITHOUT writing anything.
 *
 * This is the dry run an operator wants before arming a flow: it shows the
 * branch a contact takes, every gate's verdict, the sends and the wall-clock
 * moment each would go out (waits and delivery windows applied), and where
 * the run ends. It reads the same predicate evaluator the runner uses, so a
 * gate that passes here passes in production — for the state as it is at the
 * moment of the call. Events that would arrive during the run are of course
 * not known, which is why `path[].at` is labelled a projection.
 */

import { ObjectId } from 'mongodb'

import type { Contact, FlowStep } from '../../shared/types.js'
import type { FlowDoc, FlowRunDoc } from '../models/index.js'
import type { RunnerContext } from './index.js'
import { evaluatePredicate } from './predicate.js'
import { computeDeliveryTime } from './delivery-window.js'

const MAX_STEPS = 1000

export interface SimulateOptions {
  /** Virtual "now" the simulated run enters at. Defaults to the real now. */
  at?: Date
  /** Properties of the simulated trigger event ({{event.*}}, triggerProperty* predicates). */
  eventProperties?: Record<string, unknown>
  /** Steps to walk. Defaults to the flow's live steps. */
  steps?: FlowStep[]
}

export interface SimulatedStep {
  /** Projected wall-clock moment the step is reached. */
  at: Date
  stepIndex: number
  branchPath: Array<number | 'true' | 'false'>
  type: FlowStep['type']
  outcome:
    | 'waited'
    | 'passed'
    | 'skipped_next'
    | 'exited'
    | 'branch_true'
    | 'branch_false'
    | 'send'
    | 'send_deferred'
    | 'tagged'
    | 'event_fired'
    | 'webhook'
    | 'completed'
  detail?: Record<string, unknown>
}

export interface SimulationResult {
  flow: { slug: string; version: number; enabled: boolean }
  contact: { externalId: string; email: string }
  enteredAt: Date
  /** Whether the trigger scan would create a run at all, and why not. */
  wouldEnter: { ok: boolean; reasons: string[] }
  path: SimulatedStep[]
  sends: Array<{ templateSlug: string; at: Date; stepIndex: number; branchPath: Array<number | 'true' | 'false'> }>
  terminal: { kind: 'completed' | 'exited' | 'truncated'; reason: string; at: Date }
  /** Projected time from entry to the terminal step. */
  durationMs: number
}

export async function simulateFlow(
  flow: FlowDoc,
  contact: Contact,
  ctx: RunnerContext,
  opts: SimulateOptions = {},
): Promise<SimulationResult> {
  const enteredAt = opts.at ?? new Date()
  const steps = opts.steps ?? flow.steps ?? []
  const eventName = flow.trigger?.eventName ?? 'simulated'
  const eventProperties = opts.eventProperties ?? {}

  // --- Would the trigger scan even create a run? -------------------------
  const reasons: string[] = []
  if (!flow.enabled) reasons.push('flow is disabled (enabled: false)')
  const sub = await ctx.collections.subscriptions.findOne({ externalId: contact.externalId })
  if (!sub) reasons.push('contact has no subscription row — the trigger scan requires one')
  else if (sub.status !== 'subscribed') reasons.push(`subscription status is "${sub.status}", not "subscribed"`)
  if (flow.trigger?.once) {
    const existing = await ctx.collections.flowRuns.findOne(
      { externalId: contact.externalId, flowId: flow._id! },
      { projection: { _id: 1, status: 1 } },
    )
    if (existing) reasons.push(`trigger.once is true and the contact already has a run (${existing.status})`)
  }
  if (steps.length === 0) reasons.push('flow has no live steps — a run would complete immediately')

  // --- Walk ----------------------------------------------------------------
  // The synthetic run stands in for what the runner would insert: predicates
  // read `enteredAt` (sinceFlowStart) and `triggerEvent` (triggerProperty*).
  const run: FlowRunDoc = {
    _id: new ObjectId(),
    externalId: contact.externalId,
    flowId: flow._id!,
    flowSlug: flow.slug,
    flowVersion: flow.version,
    emailAtEntry: contact.email,
    triggerEvent: { name: eventName, properties: eventProperties, occurredAt: enteredAt },
    triggerDedupeKey: null,
    enteredAt,
    status: 'active',
    currentStepIndex: 0,
    currentBranchPath: [],
    nextActionAt: enteredAt,
    attemptsForCurrentStep: 0,
    history: [],
    exitedAt: null,
    exitReason: null,
    createdAt: enteredAt,
    updatedAt: enteredAt,
  } as unknown as FlowRunDoc

  const path: SimulatedStep[] = []
  const sends: SimulationResult['sends'] = []
  let list: FlowStep[] = steps
  let index = 0
  let branchPath: Array<number | 'true' | 'false'> = []
  let t = enteredAt
  let terminal: SimulationResult['terminal'] | null = null

  const record = (type: FlowStep['type'], outcome: SimulatedStep['outcome'], detail?: Record<string, unknown>) => {
    path.push({ at: t, stepIndex: index, branchPath: [...branchPath], type, outcome, ...(detail ? { detail } : {}) })
  }
  const predicateCtx = () => ({
    contact,
    run: { ...run, currentStepIndex: index, currentBranchPath: branchPath, nextActionAt: t },
    collections: ctx.collections,
    now: t,
    botFilter: ctx.config.botFilter,
  })

  for (let guard = 0; guard < MAX_STEPS && !terminal; guard += 1) {
    const step = list[index]
    if (!step) {
      terminal = { kind: 'completed', reason: 'sequence_complete', at: t }
      break
    }
    switch (step.type) {
      case 'wait': {
        const ms = unitToMs(step.value, step.unit)
        record('wait', 'waited', { value: step.value, unit: step.unit, until: new Date(t.getTime() + ms) })
        t = new Date(t.getTime() + ms)
        index += 1
        break
      }
      case 'condition': {
        const result = await evaluatePredicate(step.test, predicateCtx())
        if (result) {
          record('condition', 'passed', { test: step.test, result })
          index += 1
        } else if (step.ifFalse === 'continue') {
          record('condition', 'skipped_next', { test: step.test, result })
          index += 2
        } else {
          record('condition', 'exited', { test: step.test, result })
          terminal = { kind: 'exited', reason: 'condition_false', at: t }
        }
        break
      }
      case 'branch': {
        const result = await evaluatePredicate(step.test, predicateCtx())
        record('branch', result ? 'branch_true' : 'branch_false', { test: step.test, result })
        branchPath = [...branchPath, index, result ? 'true' : 'false', 0]
        list = result ? step.ifTrueSteps : step.ifFalseSteps
        index = 0
        break
      }
      case 'send': {
        let at = t
        if (step.delivery) {
          at = computeDeliveryTime(t, step.delivery, contact.timezone)
        }
        if (at.getTime() > t.getTime() + 30_000) {
          record('send', 'send_deferred', { templateSlug: step.templateSlug, delivery: step.delivery, until: at })
          t = at
        }
        record('send', 'send', { templateSlug: step.templateSlug })
        sends.push({ templateSlug: step.templateSlug, at: t, stepIndex: index, branchPath: [...branchPath] })
        index += 1
        break
      }
      case 'tag':
        record('tag', 'tagged', { addTags: step.addTags ?? [], removeTags: step.removeTags ?? [] })
        index += 1
        break
      case 'fire_event':
        record('fire_event', 'event_fired', { eventName: step.eventName })
        index += 1
        break
      case 'webhook':
        record('webhook', 'webhook', { url: step.url, method: step.method ?? 'POST', note: 'not called in simulation' })
        index += 1
        break
      case 'exit':
        record('exit', 'exited', { reason: step.reason ?? 'exit_step' })
        terminal = { kind: 'exited', reason: step.reason ?? 'exit_step', at: t }
        break
    }
  }
  if (!terminal) terminal = { kind: 'truncated', reason: `stopped after ${MAX_STEPS} steps`, at: t }

  return {
    flow: { slug: flow.slug, version: flow.version, enabled: flow.enabled },
    contact: { externalId: contact.externalId, email: contact.email },
    enteredAt,
    wouldEnter: { ok: reasons.length === 0, reasons },
    path,
    sends,
    terminal,
    durationMs: terminal.at.getTime() - enteredAt.getTime(),
  }
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
