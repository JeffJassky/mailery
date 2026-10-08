/**
 * Deterministic runner driver.
 *
 * The test harness uses the `noop` queue driver: `queue.add()` throws nothing
 * away quietly but nothing ever fires it either, so the runner only moves when
 * a test tells it to. `drain` is that push — it alternates the trigger scan,
 * the due-run sweep and send dispatch until the system is quiescent, which is
 * what a real deployment converges to between ticks.
 *
 *   await H.mailer.fire('Created', 'u1')
 *   await drain(H.mailer.getRunnerContext())
 *   expect(H.provider.sent).toHaveLength(1)
 *
 * "Quiescent" means: no active flow_run whose `nextActionAt` has passed, and
 * no queued send left to dispatch. Runs parked in a `wait` step or deferred by
 * a delivery window are *expected* to remain — move the clock forward and
 * drain again.
 */

import type { ObjectId } from 'mongodb'

import { processNewlyFiredEventTriggers, sweepStrandedFlowRuns } from '../server/runner/index.js'
import { dispatchSend } from '../server/runner/send.js'
import { releaseDueDeferredSends } from '../server/runner/contact-policy.js'
import { runProgramScheduler, tickProgramRun, type ProgramTickResult } from '../server/runner/programs/index.js'
import type { RunnerContext } from '../server/runner/index.js'

export interface DrainOptions {
  /**
   * Safety valve. Each round advances every due run by exactly one step, so a
   * flow needs one round per step. Hitting the cap means the system did not
   * converge — `settled` comes back false rather than throwing, so a test can
   * assert on non-convergence deliberately.
   */
  maxRounds?: number
  /** Skip send dispatch to inspect `queued` send rows before they go out. */
  dispatch?: boolean
  /**
   * Let provider/render errors propagate. Off by default: `dispatchSend`
   * rethrows so the real queue can retry, and a drain that unwound on the
   * first failure could not assert on the failed send row it just wrote.
   */
  throwOnSendError?: boolean
}

export interface DrainResult {
  rounds: number
  /** Sends passed to `dispatchSend`. Not all of them reached the provider. */
  dispatched: number
  /** Errors thrown by `dispatchSend`, swallowed unless `throwOnSendError`. */
  errors: Error[]
  settled: boolean
}

export async function drain(ctx: RunnerContext, opts: DrainOptions = {}): Promise<DrainResult> {
  const maxRounds = opts.maxRounds ?? 100
  const shouldDispatch = opts.dispatch !== false
  // A send left in `queued` (circuit breaker tripped, re-enqueued for later)
  // would otherwise be re-dispatched every round and never let the loop end.
  const attempted = new Set<string>()
  const errors: Error[] = []
  let dispatched = 0
  let rounds = 0

  while (rounds < maxRounds) {
    rounds++

    await processNewlyFiredEventTriggers(ctx)
    await sweepStrandedFlowRuns(ctx)

    let didWork = false

    // 0.21: Programs and contact-policy deferrals. Both are no-ops on a
    // database with no enabled program and no deferred send.
    const programs = await runProgramScheduler(ctx)
    if (programs.ticked > 0) didWork = true
    if ((await releaseDueDeferredSends(ctx)) > 0) didWork = true

    if (shouldDispatch) {
      const queued = await ctx.collections.sends
        .find({ status: 'queued' }, { projection: { _id: 1 } })
        .toArray()
      for (const row of queued) {
        const id = String(row._id)
        if (attempted.has(id)) continue
        attempted.add(id)
        didWork = true
        dispatched++
        try {
          await dispatchSend(row._id as ObjectId, ctx)
        } catch (err: any) {
          errors.push(err instanceof Error ? err : new Error(String(err)))
          if (opts.throwOnSendError) throw err
        }
      }
    }

    const due = await ctx.collections.flowRuns.countDocuments({
      status: 'active',
      nextActionAt: { $lte: new Date() },
    })
    // A due program run with an enabled program is work the next round does.
    const dueProgramRuns = programs.ticked > 0
      ? await ctx.collections.programRuns.countDocuments({
          status: { $in: ['active', 'sunset'] },
          nextTickAt: { $lte: new Date() },
        })
      : 0
    if (!didWork && due === 0 && dueProgramRuns === 0) {
      return { rounds, dispatched, errors, settled: true }
    }
  }

  return { rounds, dispatched, errors, settled: false }
}

/**
 * Dispatch every currently-queued send, once. Use when a test drove the flow
 * with `drain({ dispatch: false })` and wants to inspect the queued rows first.
 */
export async function dispatchQueued(ctx: RunnerContext): Promise<number> {
  const queued = await ctx.collections.sends
    .find({ status: 'queued' }, { projection: { _id: 1 } })
    .toArray()
  for (const row of queued) {
    await dispatchSend(row._id as ObjectId, ctx).catch(() => {})
  }
  return queued.length
}

/**
 * Tick one subject's run in a program now (0.21), as the scheduler would.
 * Throws when the subject has no run — enter it first (fire the entry event
 * and `drain`, or `H.mailer.enterProgram`).
 */
export async function tickProgram(
  ctx: RunnerContext,
  slug: string,
  subjectId: string,
  opts: { now?: Date; trigger?: 'schedule' | 'entry' | 'facts_changed' | 'forced' } = {},
): Promise<ProgramTickResult> {
  const run = await ctx.collections.programRuns.findOne({ programSlug: slug, subjectId }, { projection: { _id: 1 } })
  if (!run) throw new Error(`tickProgram: no run for program "${slug}" subject "${subjectId}"`)
  return tickProgramRun(ctx, run._id as ObjectId, { now: opts.now ?? new Date(), trigger: opts.trigger ?? 'schedule' })
}
