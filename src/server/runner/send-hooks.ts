/**
 * Per-origin dispatch hooks (0.21). `dispatchSend` consults these so an
 * originating system can veto a send at the last moment and learn how it
 * ended, without dispatch knowing anything about that system.
 *
 *   guard      — runs on every dispatch, re-dispatches of deferred sends
 *                included, after suppression + circuit breaker and BEFORE the
 *                contact policy (a send that should be cancelled must not be
 *                deferred first). INVARIANT 19 for Programs.
 *   onOutcome  — runs once per status transition dispatch makes: sent,
 *                deferred, cancelled (guard or policy_expired), suppressed,
 *                failed. Never for `held`.
 *
 * Hooks live on `RunnerContext.sendHooks`, built by the Mailer constructor:
 * `flow` gets the aborted-run guard (moved there from inline in dispatch,
 * behaviour unchanged), `program` gets the Program hooks. A throwing guard
 * fails the send closed — the error propagates and the queue retries.
 */

import type { SendExitReason, SendOrigin } from '../../shared/enums.js'
import type { ContactPolicyReason, SendDoc } from '../models/index.js'
import type { RunnerContext } from './index.js'

export type SendGuardVerdict =
  | { verdict: 'send' }
  | { verdict: 'cancel'; exitReason: SendExitReason | null; message: string }

export type SendOutcome =
  | { status: 'sent'; at: Date }
  | { status: 'deferred'; notBefore: Date; reason: ContactPolicyReason }
  | { status: 'cancelled'; exitReason: SendExitReason | null; message: string }
  | { status: 'suppressed'; scope: string | null }
  | { status: 'failed'; error: string }

export interface SendOriginHooks {
  guard?(send: SendDoc, ctx: RunnerContext): Promise<SendGuardVerdict>
  onOutcome?(send: SendDoc, outcome: SendOutcome, ctx: RunnerContext): Promise<void>
}

export type SendHooks = Partial<Record<SendOrigin, SendOriginHooks>>

/** Which system produced a send row. */
export function sendOrigin(send: Pick<SendDoc, 'program' | 'broadcastId' | 'flowRunId'>): SendOrigin {
  if (send.program) return 'program'
  if (send.broadcastId) return 'broadcast'
  if (send.flowRunId) return 'flow'
  return 'oneoff'
}
