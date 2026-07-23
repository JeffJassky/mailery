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
  | 'cancelled'

export type TemplateKind = 'transactional' | 'marketing'

/**
 * How a template's body goes on the wire.
 *
 *   multipart — HTML + plain-text alternative (the default, and what almost
 *               every template wants).
 *   text_only — plain text alone, no HTML part at all. For mail that should
 *               read as if it were typed by a person. Open tracking is
 *               impossible without an HTML part to carry the pixel, and click
 *               tracking is skipped too (rewriting bare URLs in text produces
 *               the opaque redirect links this format exists to avoid), so a
 *               text_only send reports no opens and no clicks — by design.
 */
export type TemplateBodyFormat = 'multipart' | 'text_only'
export const TEMPLATE_BODY_FORMATS: readonly TemplateBodyFormat[] = ['multipart', 'text_only'] as const

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
