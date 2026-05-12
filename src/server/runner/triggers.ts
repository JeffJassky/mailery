/**
 * Event-trigger scan. Finds new event firings since each flow's
 * lastTriggerScanAt watermark, creates flow_runs for matching contacts,
 * enqueues immediate-advance jobs.
 */

import type { RunnerContext } from './index.js'
import type { FlowDoc, EventDoc } from '../models/index.js'

const BATCH_SIZE = 1000

export async function processNewlyFiredEventTriggers(ctx: RunnerContext): Promise<void> {
  const flows = await ctx.collections.flows.find({ enabled: true, 'trigger.type': 'event' }).toArray()
  for (const flow of flows) {
    await processFlowTriggers(flow, ctx)
  }
}

async function processFlowTriggers(flow: FlowDoc, ctx: RunnerContext): Promise<void> {
  const eventName = flow.trigger.eventName
  if (!eventName) return
  const since = flow.lastTriggerScanAt ?? flow.createdAt

  const events = await ctx.collections.events
    .find({ name: eventName, occurredAt: { $gt: since } })
    .sort({ occurredAt: 1 })
    .limit(BATCH_SIZE)
    .toArray()

  if (events.length === 0) return

  for (const event of events) {
    await tryEnterFlow(flow, event, ctx)
  }

  const newestOccurredAt = events[events.length - 1]!.occurredAt
  await ctx.collections.flows.updateOne(
    { _id: flow._id },
    { $set: { lastTriggerScanAt: newestOccurredAt, updatedAt: new Date() } },
  )
}

async function tryEnterFlow(flow: FlowDoc, event: EventDoc, ctx: RunnerContext): Promise<void> {
  if (flow.trigger.once) {
    const existing = await ctx.collections.flowRuns.findOne(
      { externalId: event.externalId, flowId: flow._id },
      { projection: { _id: 1 } },
    )
    if (existing) return
  }

  const sub = await ctx.collections.subscriptions.findOne({ externalId: event.externalId })
  if (!sub || sub.status !== 'subscribed') return

  const result = await ctx.collections.flowRuns.insertOne({
    externalId: event.externalId,
    flowId: flow._id!,
    flowSlug: flow.slug,
    flowVersion: flow.version,
    emailAtEntry: sub.emailAtSubscribe,
    enteredAt: new Date(),
    status: 'active',
    currentStepIndex: 0,
    currentBranchPath: [],
    nextActionAt: new Date(),
    attemptsForCurrentStep: 0,
    history: [{ stepIndex: -1, action: 'entered', at: new Date(), details: { eventDedupeKey: event.dedupeKey } }],
    exitedAt: null,
    exitReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  await ctx.queues.advance.add('advance', { flowRunId: String(result.insertedId) })
}
