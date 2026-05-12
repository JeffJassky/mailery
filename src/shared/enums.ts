/**
 * Shared enums — string-literal unions for status fields and other discriminators.
 * Kept separate from types.ts so the client can import these without pulling in
 * server-shaped interfaces.
 */

export type SubscriptionStatus = 'subscribed' | 'pending_doi' | 'unsubscribed' | 'bounced' | 'complained'

export type SendStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'suppressed'

export type TemplateKind = 'transactional' | 'marketing'

export type SuppressionScope = 'all' | 'marketing' | 'transactional'

export type SuppressionReason =
  | 'unsubscribed'
  | 'hard_bounce'
  | 'complaint'
  | 'manual'
  | 'list_cleaning'
  | 'gdpr_forget'

export type FlowRunStatus = 'active' | 'completed' | 'exited' | 'failed'

export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed'

export type HealthStatus = 'healthy' | 'degraded' | 'tripped'

export type FlowGoal = 'activation' | 'conversion' | 'retention' | 'reactivation' | 'transactional' | 'broadcast'
