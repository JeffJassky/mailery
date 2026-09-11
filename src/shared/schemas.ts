/**
 * Zod schemas for runtime validation at write boundaries — public API entry
 * points (fire, upsertSubscription, suppress, sendOneOff, scheduleBroadcast)
 * and REST handler bodies.
 *
 * Domain TypeScript types live in `./types.ts`; these schemas overlap with
 * those types deliberately so we get both compile-time and runtime checking
 * at the surfaces that need it.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

export const externalIdSchema = z.string().min(1).max(256)
export const emailSchema = z.string().email().toLowerCase().trim()
export const slugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'must be kebab-case slug')

// ---------------------------------------------------------------------------
// Public API inputs
// ---------------------------------------------------------------------------

export const fireInputSchema = z.object({
  eventName: z.string().min(1).max(128),
  externalId: externalIdSchema,
  properties: z.record(z.string(), z.unknown()).optional(),
  dedupeKey: z.string().min(1).max(512).optional(),
})
export type FireInput = z.infer<typeof fireInputSchema>

export const registerEventSchema = z.object({
  name: z.string().min(1).max(128),
  dedupePolicy: z.enum(['once-per-contact', 'once-per-day', 'every-time']),
})
export type RegisterEventInput = z.infer<typeof registerEventSchema>

export const upsertSubscriptionSchema = z.object({
  externalId: externalIdSchema,
  source: z.string().min(1).max(256),
  consentTimestamp: z.date().optional(),
  consentIp: z.string().optional(),
  consentUserAgent: z.string().optional(),
})
export type UpsertSubscriptionInput = z.infer<typeof upsertSubscriptionSchema>

export const unsubscribeScopeSchema = z.enum(['all', 'marketing', 'transactional'])
export const unsubscribeReasonSchema = z.enum([
  'user_request',
  'hard_bounce',
  'complaint',
  'manual',
  'gdpr_forget',
  'list_cleaning',
])

export const unsubscribeInputSchema = z.object({
  email: emailSchema,
  scope: unsubscribeScopeSchema,
  reason: unsubscribeReasonSchema.default('user_request'),
  source: z.string().max(256).default('manual'),
  notes: z.string().max(1024).optional(),
})
export type UnsubscribeInput = z.infer<typeof unsubscribeInputSchema>

/**
 * An explicit opt-in from someone who previously unsubscribed. Clears only the
 * suppression an unsubscribe wrote (`reason: 'unsubscribed'`) — a bounce or
 * complaint row is deliverability, not preference, and survives.
 */
export const resubscribeInputSchema = z.object({
  externalId: externalIdSchema,
  /** `marketing` clears marketing + all-scope opt-outs; `all` clears every scope. */
  scope: z.enum(['marketing', 'all']).default('marketing'),
  source: z.string().min(1).max(256),
  consentTimestamp: z.date().optional(),
  consentIp: z.string().optional(),
  consentUserAgent: z.string().optional(),
})
export type ResubscribeInput = z.input<typeof resubscribeInputSchema>

export const suppressInputSchema = z.object({
  email: emailSchema,
  scope: unsubscribeScopeSchema,
  reason: z.enum(['unsubscribed', 'hard_bounce', 'complaint', 'manual', 'list_cleaning', 'gdpr_forget']),
  source: z.string().max(256).default('manual'),
  notes: z.string().max(1024).optional(),
  expiresAt: z.date().optional(),
})
export type SuppressInput = z.infer<typeof suppressInputSchema>

export const tagInputSchema = z.object({
  externalId: externalIdSchema,
  tag: z.string().min(1).max(128),
})
export type TagInput = z.infer<typeof tagInputSchema>

export const abortFlowInputSchema = z.object({
  flowSlug: slugSchema,
  externalId: externalIdSchema,
  reason: z.string().min(1).max(200).optional(),
  /**
   * Restrict the abort to runs whose trigger event carried these properties —
   * e.g. `{ accountId }` to cancel one account's series while the same
   * contact's other accounts keep running. Omit to abort every active run for
   * the contact on this flow.
   *
   * Keys and values are both constrained because these go straight into a
   * Mongo query. Values are primitives only: an object value like
   * `{ $ne: null }` would reach the query as an OPERATOR and match every
   * scoped run, turning a one-account abort into abort-everything. Hosts
   * typically pass an id from a request body, so treat it as untrusted. The
   * key regex likewise blocks `$`-prefixed keys and dots (a dot would silently
   * extend the path and change match semantics).
   */
  matchTriggerProperties: z
    .record(
      z.string().regex(/^[A-Za-z0-9_]+$/),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
})
export type AbortFlowInput = z.infer<typeof abortFlowInputSchema>

export const abortAllFlowsInputSchema = abortFlowInputSchema.omit({ flowSlug: true })
export type AbortAllFlowsInput = z.infer<typeof abortAllFlowsInputSchema>

export const sendOneOffInputSchema = z.object({
  templateSlug: slugSchema,
  externalId: externalIdSchema,
  vars: z.record(z.string(), z.unknown()).optional(),
  providerOverride: z.string().optional(),
  dedupeKey: z.string().min(1).max(512),
})
export type SendOneOffInput = z.infer<typeof sendOneOffInputSchema>

// ---------------------------------------------------------------------------
// Segment definitions (mirror SegmentFilter in types.ts)
// ---------------------------------------------------------------------------

const subscriptionStatusEnum = z.enum(['subscribed', 'unsubscribed', 'pending_doi', 'bounced', 'complained'])

/**
 * A host field name. Host-side filters become keys in the adapter's query
 * (for MongoContactAdapter, literally a Mongo filter key), so a `$`-prefixed
 * name would be an operator, not a field.
 */
const fieldNameSchema = (strict: boolean) =>
  (strict ? z.string().min(1) : z.string()).max(256).regex(/^(?!\$)[^\0]*$/, 'must not start with $')

/**
 * Filter values are primitives only. An object value such as `{ $ne: null }`
 * would reach a Mongo-backed adapter as an OPERATOR and match every contact.
 */
const segmentValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

/**
 * Build the segment-filter schema. `strict` is what scheduling (and every
 * agent-path write) requires: non-empty tags, fields and event names, and a
 * non-empty `any`. The lenient form only checks types, so the admin composer
 * can save a draft while a row is still half filled in.
 */
export function segmentFilterSchema(strict: boolean): z.ZodType<unknown> {
  const str = strict ? z.string().min(1).max(256) : z.string().max(256)
  const days = z.number().int().positive().max(36_500).optional()
  const self: z.ZodType<unknown> = z.lazy(() =>
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('fieldEquals'), field: fieldNameSchema(strict), value: segmentValueSchema }),
      z.object({ kind: z.literal('fieldIn'), field: fieldNameSchema(strict), values: z.array(segmentValueSchema).max(1000) }),
      z.object({ kind: z.literal('fieldExists'), field: fieldNameSchema(strict) }),
      z.object({ kind: z.literal('hasTag'), tag: str }),
      z.object({ kind: z.literal('notHasTag'), tag: str }),
      z.object({ kind: z.literal('subscriptionStatus'), equals: subscriptionStatusEnum }),
      z.object({ kind: z.literal('firedEvent'), eventName: str, withinDays: days }),
      z.object({ kind: z.literal('notFiredEvent'), eventName: str, withinDays: days }),
      z.object({ kind: z.literal('subscribedAfter'), date: z.coerce.date() }),
      z.object({ kind: z.literal('subscribedBefore'), date: z.coerce.date() }),
      z.object({ kind: z.literal('opened'), templateSlug: slugSchema.optional(), withinDays: days }),
      z.object({ kind: z.literal('notOpened'), templateSlug: slugSchema.optional(), withinDays: days }),
      z.object({ kind: z.literal('any'), filters: strict ? z.array(self).min(1).max(50) : z.array(self).max(50) }),
      z.object({ kind: z.literal('not'), filter: self }),
    ]),
  )
  return self
}

export function segmentDefinitionSchema(strict: boolean) {
  return z.object({ filters: z.array(segmentFilterSchema(strict)).max(50) })
}

// ---------------------------------------------------------------------------
// Flow step + predicate schemas (mirror types.ts)
// ---------------------------------------------------------------------------

export const flowStepSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('wait'),
      value: z.number().int().positive(),
      unit: z.enum(['minutes', 'hours', 'days', 'weeks']),
    }),
    z.object({
      type: z.literal('condition'),
      test: predicateSchema,
      ifFalse: z.enum(['continue', 'exit']),
    }),
    z.object({
      type: z.literal('branch'),
      test: predicateSchema,
      ifTrueSteps: z.array(flowStepSchema),
      ifFalseSteps: z.array(flowStepSchema),
    }),
    z.object({
      type: z.literal('send'),
      templateSlug: slugSchema,
      providerOverride: z.string().optional(),
      vars: z.record(z.string(), z.unknown()).optional(),
      delivery: z
        .object({
          weekdaysOnly: z.boolean().optional(),
          timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm').optional(),
          useContactTimezone: z.boolean().optional(),
          timezone: z.string().optional(),
        })
        .optional(),
    }),
    z.object({
      type: z.literal('tag'),
      addTags: z.array(z.string()).optional(),
      removeTags: z.array(z.string()).optional(),
    }),
    z.object({
      type: z.literal('fire_event'),
      eventName: z.string().min(1).max(128),
      properties: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      type: z.literal('webhook'),
      // `url` is validated for shape only and is deliberately never templated —
      // see the comment on handleWebhookStep in src/server/runner/step.ts, and
      // INVARIANT 16. Rendering contact/event data into this field would turn an
      // admin-authored flow into a server-side request forgery primitive.
      url: z.string().url(),
      method: z.enum(['POST', 'PUT']).optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
      failureMode: z.enum(['soft', 'fail_run']).optional(),
    }),
    z.object({
      type: z.literal('exit'),
      reason: z.string().optional(),
    }),
  ]),
)

export const predicateSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ hasTag: z.string() }),
    z.object({ notHasTag: z.string() }),
    z.object({ fieldEquals: z.object({ field: z.string(), value: z.unknown() }) }),
    z.object({ fieldExists: z.string() }),
    z.object({
      triggerPropertyEquals: z.object({
        key: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      }),
    }),
    z.object({ triggerPropertyTruthy: z.string().min(1) }),
    z.object({
      hasFiredEvent: z.string(),
      sinceFlowStart: z.boolean().optional(),
      withinDays: z.number().int().positive().optional(),
    }),
    z.object({
      notHasFiredEvent: z.string(),
      withinDays: z.number().int().positive().optional(),
    }),
    z.object({
      subscriptionStatus: z.enum(['subscribed', 'unsubscribed', 'pending_doi', 'bounced', 'complained']),
    }),
    z.object({
      hasOpened: z.object({
        templateSlug: slugSchema.optional(),
        sinceFlowStart: z.boolean().optional(),
        withinDays: z.number().int().positive().optional(),
      }),
    }),
    z.object({
      hasClicked: z.object({
        templateSlug: slugSchema.optional(),
        sinceFlowStart: z.boolean().optional(),
        withinDays: z.number().int().positive().optional(),
      }),
    }),
    z.object({
      hasOpenedExcludingBots: z.object({
        templateSlug: slugSchema.optional(),
        sinceFlowStart: z.boolean().optional(),
        withinDays: z.number().int().positive().optional(),
      }),
    }),
    z.object({
      hasClickedExcludingBots: z.object({
        templateSlug: slugSchema.optional(),
        sinceFlowStart: z.boolean().optional(),
        withinDays: z.number().int().positive().optional(),
      }),
    }),
    z.object({
      openedAtLeastN: z.object({ count: z.number().int().positive(), withinDays: z.number().int().positive() }),
    }),
    z.object({
      clickedAtLeastN: z.object({ count: z.number().int().positive(), withinDays: z.number().int().positive() }),
    }),
    z.object({ all: z.array(predicateSchema) }),
    z.object({ any: z.array(predicateSchema) }),
    z.object({ not: predicateSchema }),
  ]),
)
