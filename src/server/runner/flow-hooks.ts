/**
 * The `flow` origin's dispatch hooks (0.21). The guard is the aborted-run
 * check that used to sit inline in `dispatchSend`, moved here unchanged.
 */

import type { SendOriginHooks } from './send-hooks.js'

export const flowSendHooks: SendOriginHooks = {
  /**
   * Closes the race where a send is enqueued between a flow abort's
   * send-cancellation sweep and dispatch. Only host aborts block here —
   * completed/naturally-exited runs may still have legitimately queued mail.
   */
  async guard(send, ctx) {
    if (!send.flowRunId) return { verdict: 'send' }
    const run = await ctx.collections.flowRuns.findOne({ _id: send.flowRunId })
    if (run && run.status === 'exited' && run.exitReason?.startsWith('aborted_by_host')) {
      return { verdict: 'cancel', exitReason: null, message: run.exitReason }
    }
    return { verdict: 'send' }
  },
}
