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

export interface RunnerContext {
  db: Db
  collections: Collections
  adapter: ContactAdapter
  providers: Record<string, MailProvider>
  queues: Queues
  config: ResolvedConfig
  handlebarsHelpers?: Record<string, Handlebars.HelperDelegate>
}

export { runTick } from './tick.js'
export { processOneRunStep } from './step.js'
export { dispatchSend } from './send.js'
export { processNewlyFiredEventTriggers } from './triggers.js'
export { sweepStrandedFlowRuns } from './sweep.js'
export { applyWebhookEvent } from './webhook.js'
