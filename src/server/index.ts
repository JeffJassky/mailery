/**
 * Public exports for the `mailery` package.
 */

export const VERSION = '0.1.0'

// Core
export { Mailer } from './mailer.js'
export type { MailerConfig, RedisOptions, CircuitBreakerThresholds } from './config.js'

// Adapters
export { MongoContactAdapter } from './adapters/mongo.js'
export type { MongoContactAdapterOptions } from './adapters/mongo.js'

// Providers
export { NullProvider } from './providers/null.js'
export { SendGridProvider } from './providers/sendgrid.js'
export type { SendGridProviderOptions } from './providers/sendgrid.js'

// HTTP routers
export { createAdminRouter } from './api/admin.js'
export type { AdminRouterOptions } from './api/admin.js'
export { createPublicRouter } from './api/public.js'
export type { PublicRouterOptions } from './api/public.js'

// Templates (host apps may want compile + render directly for previews)
export {
  compileTemplate,
  derivePlaintext,
  renderTemplate,
  applyTracking,
} from './templates/render.js'

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
export type {
  Contact,
  ContactAdapter,
  AdapterFilter,
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
