/**
 * Event-trigger scan. Finds new event firings since each flow's
 * lastTriggerScanAt watermark, creates flow_runs for matching contacts,
 * enqueues immediate-advance jobs.
 */

import type { RunnerContext } from './index.js'
import type { FlowDoc, EventDoc } from '../models/index.js'

const BATCH_SIZE = 1000

/**
 * Re-scan window. The watermark advances on `createdAt` (insert time), but a
 * concurrent `fire()` can commit a row with a createdAt slightly before the
 * scan's read. Re-reading this much history every pass closes that race; the
 * unique (flowId, triggerDedupeKey) index makes re-reads harmless.
 */
const SCAN_OVERLAP_MS = 30_000

export async function processNewlyFiredEventTriggers(ctx: RunnerContext): Promise<void> {
  const flows = await ctx.collections.flows.find({ enabled: true, 'trigger.type': 'event' }).toArray()
  for (const flow of flows) {
    await processFlowTriggers(flow, ctx)
  }
}

async function processFlowTriggers(flow: FlowDoc, ctx: RunnerContext): Promise<void> {
  const eventName = flow.trigger.eventName
  if (!eventName) return
  // Watermark on createdAt, not occurredAt: occurredAt can lag insert time
  // (outbox-drained events carry the host-transaction timestamp), so an
  // occurredAt watermark permanently skips any event that lands "in the past."
  // createdAt only ever moves forward with inserts.
  const since = flow.lastTriggerScanAt ?? flow.createdAt
  const scanFrom = new Date(since.getTime() - SCAN_OVERLAP_MS)

  const events = await ctx.collections.events
    .find({ name: eventName, createdAt: { $gt: scanFrom } })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE)
    .toArray()

  if (events.length === 0) return

  for (const event of events) {
    await tryEnterFlow(flow, event, ctx)
  }

  const newestCreatedAt = events[events.length - 1]!.createdAt
  if (newestCreatedAt.getTime() > since.getTime()) {
    await ctx.collections.flows.updateOne(
      { _id: flow._id },
      { $set: { lastTriggerScanAt: newestCreatedAt, updatedAt: new Date() } },
    )
  }
}

async function tryEnterFlow(flow: FlowDoc, event: EventDoc, ctx: RunnerContext): Promise<void> {
  if (flow.trigger.once) {
    const existing = await ctx.collections.flowRuns.findOne(
      { externalId: event.externalId, flowId: flow._id },
      { projection: { _id: 1 } },
    )
    if (existing) return
  }

  // Flow entry requires an active subscription — flows are marketing-scope.
  // Transactional mail for not-subscribed contacts goes through sendOneOff.
  const sub = await ctx.collections.subscriptions.findOne({ externalId: event.externalId })
  if (!sub || sub.status !== 'subscribed') return

  let result
  try {
    result = await ctx.collections.flowRuns.insertOne({
      externalId: event.externalId,
      flowId: flow._id!,
      flowSlug: flow.slug,
      flowVersion: flow.version,
      emailAtEntry: sub.emailAtSubscribe,
      triggerEvent: { name: event.name, properties: event.properties ?? {}, occurredAt: event.occurredAt },
      triggerDedupeKey: event.dedupeKey,
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
  } catch (err: any) {
    // Event already entered this flow (overlap-window re-read) — no-op.
    if (err?.code !== 11000) throw err
    return
  }

  await ctx.queues.advance.add('advance', { flowRunId: String(result.insertedId) })
}
