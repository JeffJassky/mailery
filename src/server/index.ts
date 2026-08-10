/**
 * Public exports for the `mailery` package.
 */

declare const __PKG_VERSION__: string | undefined

/**
 * Library version, stamped from package.json at build time (tsup/vitest
 * `define`). 'dev' when the source runs without a bundler define (plain tsx).
 */
export const VERSION = typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : 'dev'

// Core
export { Mailer } from './mailer.js'
export type { MailerConfig, RedisOptions, CircuitBreakerThresholds, SenderDomainConfig, SenderDomainRegistry } from './config.js'
export { validateSenderDomain } from './templates/sender-domain.js'
export type { SenderDomainValidation } from './templates/sender-domain.js'

// Adapters
export { MongoContactAdapter } from './adapters/mongo.js'
export type { MongoContactAdapterOptions } from './adapters/mongo.js'
export { defineVars, varsJsonSchema, RESERVED_VAR_KEYS } from './adapters/vars.js'
export type { VarsAdapter, VarsResolveInfo } from './adapters/vars.js'

// Providers
export { NullProvider } from './providers/null.js'
export { SendGridProvider } from './providers/sendgrid.js'
export type { SendGridProviderOptions } from './providers/sendgrid.js'

// HTTP routers
export { createAdminRouter } from './api/admin.js'
export type { AdminRouterOptions } from './api/admin.js'
export { createPublicRouter } from './api/public.js'
export type { PublicRouterOptions } from './api/public.js'
export type { RouteLogger } from './api/wrap.js'

// Templates (host apps may want compile + render directly for previews)
export {
  compileTemplate,
  compileMailyTemplate,
  derivePlaintext,
  renderTemplate,
  applyTracking,
} from './templates/render.js'

// Runner internals — exported so test harnesses and advanced hosts can drive
// the runner inline. In production let `startWorkers()` invoke these.
export {
  runTick,
  processOneRunStep,
  dispatchSend,
  applyWebhookEvent,
  processNewlyFiredEventTriggers,
  sweepStrandedFlowRuns,
} from './runner/index.js'

// Models (collection helpers, in case hosts need to query directly)
export { getCollections, ensureIndexes } from './models/index.js'
export type {
  Collections,
  SubscriptionDoc,
  EventDoc,
  FlowDoc,
  FlowRunDoc,
  TemplateDoc,
  SendDoc,
  SuppressionDoc,
  BroadcastDoc,
  AuditLogDoc,
  WebhookEventDoc,
  HealthDoc,
  ContactTagDoc,
  LeadDoc,
  OutboxDoc,
  FlowVersionDoc,
  TemplateVersionDoc,
} from './models/index.js'

// Token helpers (rarely needed by hosts, useful for tests)
export { signUnsubscribeToken, verifyUnsubscribeToken, sha256Hex } from './tokens.js'

// Shared types
export { computeDeliveryTime } from './runner/delivery-window.js'

export type {
  Contact,
  ContactAdapter,
  AdapterFilter,
  DeliveryWindow,
  MailProvider,
  SendArgs,
  SendResult,
  NormalizedEvent,
  FlowStep,
  Predicate,
  SegmentDefinition,
  SegmentFilter,
} from '../shared/types.js'

export type {
  SubscriptionStatus,
  SendStatus,
  TemplateKind,
  SuppressionScope,
  SuppressionReason,
  FlowRunStatus,
  BroadcastStatus,
  HealthStatus,
  FlowGoal,
} from '../shared/enums.js'

// Option lists for tooling / admin UIs — flow step kinds, predicate kinds,
// segment filter kinds, dedupe policies.
export {
  FLOW_STEP_KINDS,
  defaultFlowStep,
  PREDICATE_KINDS,
  defaultPredicate,
  predicateKind,
  SEGMENT_FILTER_KINDS,
  defaultSegmentFilter,
  DEDUPE_POLICIES,
} from '../shared/options.js'
export type {
  FlowStepKindOption,
  PredicateKindOption,
  PredicateKind,
  SegmentFilterKindOption,
  SegmentFilterKind,
  DedupePolicyOption,
} from '../shared/options.js'
