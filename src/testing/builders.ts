/**
 * Document builders for tests. Hand-rolling a full `TemplateDoc` / `FlowDoc`
 * literal is ~40 lines of noise per fixture; these fill every required field
 * with a sane default so a test only states what it is actually asserting on.
 *
 *   await H.seedTemplate({ slug: 'welcome', subject: 'Hi {{contact.fields.firstName}}' })
 *   await H.seedFlow({ slug: 'onboarding', eventName: 'Created', steps: [...] })
 *
 * `createdAt` defaults to a minute in the past: the event-trigger scan uses
 * `lastTriggerScanAt ?? createdAt` as its watermark and only picks up events
 * with `occurredAt > watermark`, so a flow created at the same instant as the
 * event it should catch would never fire.
 */

import type { TemplateDoc, FlowDoc, FlowTrigger } from '../server/models/index.js'
import type { FlowStep, DeliveryWindow } from '../shared/types.js'
import type { TemplateKind, FlowGoal } from '../shared/enums.js'
import { compileTemplate, derivePlaintext } from '../server/templates/render.js'

/** How far in the past builder-made docs claim to have been created. */
const BACKDATE_MS = 60_000

export interface TemplateSpec {
  slug: string
  name?: string
  description?: string
  kind?: TemplateKind
  fromName?: string
  fromEmail?: string
  replyTo?: string | null
  providerOverride?: string | null
  subject?: string
  preheader?: string
  /** MJML source — compiled to html + derived plain text. */
  mjml?: string
  /** Pre-compiled HTML. Wins over `mjml`. */
  html?: string
  /**
   * Body copy wrapped in a minimal MJML document. The lazy path — use when the
   * test cares about the rendered *content*, not the markup around it.
   */
  text?: string
  /** Explicit plain-text part. Omit to auto-derive from the HTML. */
  plainText?: string
  variablesSchema?: TemplateDoc['variablesSchema']
  tags?: string[]
  trackOpens?: boolean
  trackClicks?: boolean
  published?: boolean
  createdAt?: Date
}

export async function buildTemplate(spec: TemplateSpec): Promise<TemplateDoc> {
  const now = new Date()
  const createdAt = spec.createdAt ?? new Date(now.getTime() - BACKDATE_MS)

  let mjml = ''
  let html: string
  if (spec.html) {
    html = spec.html
  } else {
    mjml = spec.mjml ?? wrapMjml(spec.text ?? 'Hello {{contact.fields.firstName}}')
    const compiled = await compileTemplate(mjml)
    html = compiled.html
  }
  const plainText = spec.plainText ?? derivePlaintext(html)

  return {
    slug: spec.slug,
    name: spec.name ?? spec.slug,
    description: spec.description ?? '',
    kind: spec.kind ?? 'marketing',
    fromName: spec.fromName ?? 'Test',
    fromEmail: spec.fromEmail ?? 'hello@example.com',
    replyTo: spec.replyTo ?? null,
    providerOverride: spec.providerOverride ?? null,
    subject: spec.subject ?? 'Test subject',
    preheader: spec.preheader ?? '',
    body: { mjml, editorJson: null, html, plainText, compiledAt: createdAt },
    variablesSchema: spec.variablesSchema ?? {},
    draft: null,
    tags: spec.tags ?? [],
    trackOpens: spec.trackOpens ?? false,
    trackClicks: spec.trackClicks ?? false,
    stats: {
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
      unsubscribed: 0,
      lastSentAt: null,
    },
    publishedAt: spec.published === false ? null : createdAt,
    publishedBy: spec.published === false ? null : 'test',
    createdAt,
    updatedAt: createdAt,
  }
}

/** Minimal valid MJML document around a body string. */
export function wrapMjml(body: string): string {
  return `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`
}

export interface FlowSpec {
  slug: string
  name?: string
  description?: string
  steps: FlowStep[]
  /** Shorthand for an `event` trigger. Ignored when `trigger` is given. */
  eventName?: string
  /** Re-entry policy for the shorthand trigger. Defaults to true (enter once). */
  once?: boolean
  trigger?: FlowTrigger
  enabled?: boolean
  goal?: FlowGoal
  audience?: string
  version?: number
  createdAt?: Date
}

export function buildFlow(spec: FlowSpec): FlowDoc {
  const now = new Date()
  const createdAt = spec.createdAt ?? new Date(now.getTime() - BACKDATE_MS)
  const trigger: FlowTrigger = spec.trigger ?? {
    type: 'event',
    eventName: spec.eventName ?? `${spec.slug}:trigger`,
    once: spec.once ?? true,
  }

  return {
    slug: spec.slug,
    name: spec.name ?? spec.slug,
    description: spec.description ?? '',
    trigger,
    enabled: spec.enabled ?? true,
    steps: spec.steps,
    version: spec.version ?? 1,
    draft: null,
    goal: spec.goal ?? 'activation',
    audience: spec.audience ?? 'test',
    expectedVolumePerWeek: null,
    stats: { activeRuns: 0, completedRuns: 0, sendsTotal: 0, sendsLast7Days: 0 },
    lastTriggerScanAt: null,
    publishedAt: createdAt,
    publishedBy: 'test',
    createdAt,
    updatedAt: createdAt,
  }
}

// ---------------------------------------------------------------------------
// Step shorthands — keep flow definitions in tests readable at a glance.
// ---------------------------------------------------------------------------

export const step = {
  send(templateSlug: string, opts: Omit<Extract<FlowStep, { type: 'send' }>, 'type' | 'templateSlug'> = {}): FlowStep {
    return { type: 'send', templateSlug, ...opts }
  },
  sendAt(templateSlug: string, delivery: DeliveryWindow): FlowStep {
    return { type: 'send', templateSlug, delivery }
  },
  wait(value: number, unit: 'minutes' | 'hours' | 'days' | 'weeks' = 'minutes'): FlowStep {
    return { type: 'wait', value, unit }
  },
  tag(addTags?: string[], removeTags?: string[]): FlowStep {
    return { type: 'tag', addTags, removeTags }
  },
  exit(reason?: string): FlowStep {
    return { type: 'exit', reason }
  },
  fireEvent(eventName: string, properties?: Record<string, unknown>): FlowStep {
    return { type: 'fire_event', eventName, properties }
  },
} as const
