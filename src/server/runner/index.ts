/**
 * Runner context + public entry points. The shared context object is passed
 * to every handler so the runner stays a pure function over (state, action).
 */

import type { Db } from 'mongodb'
import type Handlebars from 'handlebars'

import type {
  ContactAdapter,
  MailProvider,
} from '../../shared/types.js'
import type { ResolvedConfig } from '../config.js'
import type { Collections } from '../models/index.js'
import type { Queues } from '../queues/index.js'
import type { VarsAdapter } from '../adapters/vars.js'

export interface RunnerContext {
  db: Db
  collections: Collections
  adapter: ContactAdapter
  varsAdapter?: VarsAdapter
  providers: Record<string, MailProvider>
  queues: Queues
  config: ResolvedConfig
  handlebarsHelpers?: Record<string, Handlebars.HelperDelegate>
  /**
   * Optional audit-log writer. Available when the runner context is derived
   * from a Mailer instance (Mailer.getRunnerContext()); absent in some
   * lightweight test harnesses. Runner code that uses this must tolerate
   * `undefined`.
   */
  audit?: (entry: {
    actor: string
    action: string
    resource: { collection: string; id?: string; slug?: string }
    diffSummary?: string
  }) => Promise<void>
}

export { runTick } from './tick.js'
export { dispatchBroadcastById, resumeStalledBroadcasts } from './broadcasts.js'
export { processOneRunStep, exitFlowRun } from './step.js'
export { dispatchSend } from './send.js'
export { processNewlyFiredEventTriggers } from './triggers.js'
export { sweepStrandedFlowRuns } from './sweep.js'
export { applyWebhookEvent } from './webhook.js'
export { drainPendingUnsubscribes } from './pending-unsubs.js'
export type {
  DrainPendingUnsubsOptions,
  DrainPendingUnsubsResult,
} from './pending-unsubs.js'
