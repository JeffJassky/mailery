/**
 * Per-run tick lease (§5.4 step 1). A run is ticked by at most one worker at a
 * time: the lease is taken with a single `findOneAndUpdate` and carries an
 * expiry, so a crashed worker's lease frees itself after `programs.leaseMs`.
 */

import crypto from 'node:crypto'
import type { ObjectId } from 'mongodb'

import { PROGRAMS_DEFAULTS } from '../../config.js'
import type { ProgramRunDoc } from '../../models/index.js'
import type { RunnerContext } from '../index.js'

/** Default lease owner: one id per process. */
export const PROCESS_WORKER = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`

export function leaseMs(ctx: RunnerContext): number {
  return ctx.config.programs?.leaseMs ?? PROGRAMS_DEFAULTS.leaseMs
}

/** The run with the lease taken, or null when it is held, missing or no longer active. */
export async function acquireLease(
  ctx: RunnerContext,
  runId: ObjectId,
  worker: string,
  now: Date,
): Promise<ProgramRunDoc | null> {
  return ctx.collections.programRuns.findOneAndUpdate(
    {
      _id: runId,
      status: { $in: ['active', 'sunset'] },
      $or: [{ lease: null }, { 'lease.until': { $lt: now } }],
    },
    { $set: { lease: { until: new Date(now.getTime() + leaseMs(ctx)), worker } } },
    { returnDocument: 'after' },
  )
}

/** Release a lease this worker holds. Safe to call after the tick already cleared it. */
export async function releaseLease(ctx: RunnerContext, runId: ObjectId, worker: string): Promise<void> {
  await ctx.collections.programRuns.updateOne({ _id: runId, 'lease.worker': worker }, { $set: { lease: null } })
}
