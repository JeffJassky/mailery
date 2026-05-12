/**
 * Recovery sweep: finds active flow_runs whose `nextActionAt` has passed but
 * weren't woken by their delayed `mailer:advance` job (worker restart, BullMQ
 * data loss). Processes each one inline.
 */

import { processOneRunStep } from './step.js'
import type { RunnerContext } from './index.js'

const SWEEP_LIMIT = 500

export async function sweepStrandedFlowRuns(ctx: RunnerContext): Promise<void> {
  const runs = await ctx.collections.flowRuns
    .find({ status: 'active', nextActionAt: { $lte: new Date() } })
    .sort({ nextActionAt: 1 })
    .limit(SWEEP_LIMIT)
    .toArray()

  for (const run of runs) {
    try {
      await processOneRunStep(run._id!, ctx)
    } catch (err) {
      console.error('mailery: sweep advance failed', { runId: String(run._id), err })
    }
  }
}
