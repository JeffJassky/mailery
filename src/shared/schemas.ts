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

export const sendOneOffInputSchema = z.object({
  templateSlug: slugSchema,
  externalId: externalIdSchema,
  vars: z.record(z.string(), z.unknown()).optional(),
  providerOverride: z.string().optional(),
  dedupeKey: z.string().min(1).max(512),
})
export type SendOneOffInput = z.infer<typeof sendOneOffInputSchema>

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
