/**
 * Enumerable option lists for the union types in `./types.ts`. Used by the
 * admin client to render dropdowns + by tooling to enumerate the surface.
 *
 * Kept in `shared/` so the client and server agree on the canonical labels +
 * default constructors. Pure data + pure functions — no React, no DOM.
 */

import type { FlowStep, Predicate, SegmentFilter } from './types.js'

// ---------------------------------------------------------------------------
// Flow step types
// ---------------------------------------------------------------------------

export interface FlowStepKindOption {
  value: FlowStep['type']
  label: string
  /** Icon name from the client's icon set (lookup at render time). */
  icon: string
  /** Visual class on the canvas chip. */
  iconClass: string
  /** One-line description for tooltips / docs generation. */
  description: string
}

export const FLOW_STEP_KINDS: readonly FlowStepKindOption[] = [
  { value: 'wait',       label: 'Wait',       icon: 'Clock',    iconClass: 'wait',      description: 'Pause the run for a duration before continuing.' },
  { value: 'condition',  label: 'Condition',  icon: 'Branch',   iconClass: 'condition', description: 'Evaluate a predicate. Exit or skip on false.' },
  { value: 'branch',     label: 'Branch',     icon: 'Branch',   iconClass: 'condition', description: 'Evaluate a predicate. Recurse into one of two sub-lists.' },
  { value: 'send',       label: 'Send',       icon: 'Mail',     iconClass: 'send',      description: 'Send a template to the contact.' },
  { value: 'tag',        label: 'Tag',        icon: 'Tag',      iconClass: 'tag',       description: 'Add or remove tags on the contact.' },
  { value: 'fire_event', label: 'Fire event', icon: 'Activity', iconClass: 'send',      description: 'Insert a synthetic event (cross-flow handoff).' },
  { value: 'webhook',    label: 'Webhook',    icon: 'Webhook',  iconClass: 'tag',       description: 'POST to an external URL.' },
  { value: 'exit',       label: 'Exit',       icon: 'Exit',     iconClass: 'exit',      description: 'End the run with an optional reason.' },
] as const

export function defaultFlowStep(type: FlowStep['type']): FlowStep {
  switch (type) {
    case 'wait':       return { type: 'wait', value: 1, unit: 'days' }
    case 'condition':  return { type: 'condition', test: { hasTag: 'engaged' }, ifFalse: 'exit' }
    case 'branch':     return { type: 'branch', test: { hasTag: 'vip' }, ifTrueSteps: [], ifFalseSteps: [] }
    case 'send':       return { type: 'send', templateSlug: '' }
    case 'tag':        return { type: 'tag', addTags: [], removeTags: [] }
    case 'fire_event': return { type: 'fire_event', eventName: '' }
    case 'webhook':    return { type: 'webhook', url: '', method: 'POST' }
    case 'exit':       return { type: 'exit' }
  }
}

// ---------------------------------------------------------------------------
// Predicate kinds (the union variants of Predicate, minus composites)
// ---------------------------------------------------------------------------

export type PredicateKind =
  | 'hasTag'
  | 'notHasTag'
  | 'fieldEquals'
  | 'fieldExists'
  | 'triggerPropertyEquals'
  | 'triggerPropertyTruthy'
  | 'hasFiredEvent'
  | 'notHasFiredEvent'
  | 'subscriptionStatus'
  | 'hasOpened'
  | 'hasClicked'
  | 'hasOpenedExcludingBots'
  | 'hasClickedExcludingBots'
  | 'openedAtLeastN'
  | 'clickedAtLeastN'

export interface PredicateKindOption {
  value: PredicateKind
  label: string
  /** True when this predicate's signal is noisy (Apple MPP, bot prefetch). */
  noisy?: boolean
}

export const PREDICATE_KINDS: readonly PredicateKindOption[] = [
  { value: 'hasTag', label: 'has tag' },
  { value: 'notHasTag', label: 'does NOT have tag' },
  { value: 'fieldEquals', label: 'field equals' },
  { value: 'fieldExists', label: 'field exists' },
  { value: 'triggerPropertyEquals', label: 'trigger property equals' },
  { value: 'triggerPropertyTruthy', label: 'trigger property is set' },
  { value: 'hasFiredEvent', label: 'fired event' },
  { value: 'notHasFiredEvent', label: 'has NOT fired event' },
  { value: 'subscriptionStatus', label: 'subscription status' },
  { value: 'hasOpened', label: 'opened', noisy: true },
  { value: 'hasClicked', label: 'clicked', noisy: true },
  { value: 'hasOpenedExcludingBots', label: 'opened (excl. bots)' },
  { value: 'hasClickedExcludingBots', label: 'clicked (excl. bots)' },
  { value: 'openedAtLeastN', label: 'opened at least N' },
  { value: 'clickedAtLeastN', label: 'clicked at least N' },
] as const

/** Identify which kind of predicate this object is (or null for composites/unknown). */
export function predicateKind(p: Predicate | null | undefined): PredicateKind | null {
  if (!p) return null
  for (const k of PREDICATE_KINDS) {
    if (k.value in (p as object)) return k.value
  }
  return null
}

export function defaultPredicate(kind: PredicateKind): Predicate {
  switch (kind) {
    case 'hasTag': return { hasTag: 'engaged' }
    case 'notHasTag': return { notHasTag: 'cold' }
    case 'fieldEquals': return { fieldEquals: { field: 'tier', value: 'Pro' } }
    case 'fieldExists': return { fieldExists: 'tier' }
    case 'triggerPropertyEquals': return { triggerPropertyEquals: { key: 'plan', value: 'pro' } }
    case 'triggerPropertyTruthy': return { triggerPropertyTruthy: 'wasReferred' }
    case 'hasFiredEvent': return { hasFiredEvent: 'Activated app' }
    case 'notHasFiredEvent': return { notHasFiredEvent: 'Cancelled' }
    case 'subscriptionStatus': return { subscriptionStatus: 'subscribed' }
    case 'hasOpened': return { hasOpened: { sinceFlowStart: true } }
    case 'hasClicked': return { hasClicked: { sinceFlowStart: true } }
    case 'hasOpenedExcludingBots': return { hasOpenedExcludingBots: { sinceFlowStart: true } }
    case 'hasClickedExcludingBots': return { hasClickedExcludingBots: { sinceFlowStart: true } }
    case 'openedAtLeastN': return { openedAtLeastN: { count: 1, withinDays: 7 } }
    case 'clickedAtLeastN': return { clickedAtLeastN: { count: 1, withinDays: 7 } }
  }
}

// ---------------------------------------------------------------------------
// Segment filter kinds
// ---------------------------------------------------------------------------

export type SegmentFilterKind = SegmentFilter['kind']

export interface SegmentFilterKindOption {
  value: SegmentFilterKind
  label: string
  /** Where the filter is evaluated: host-side via adapter, or mailer-side post-filter. */
  side: 'host' | 'mailer' | 'composite'
}

export const SEGMENT_FILTER_KINDS: readonly SegmentFilterKindOption[] = [
  { value: 'subscriptionStatus', label: 'Subscription status', side: 'mailer' },
  { value: 'hasTag', label: 'Has tag', side: 'host' },
  { value: 'notHasTag', label: 'Does NOT have tag', side: 'host' },
  { value: 'fieldEquals', label: 'Field equals', side: 'host' },
  { value: 'fieldIn', label: 'Field in list', side: 'host' },
  { value: 'fieldExists', label: 'Field exists', side: 'host' },
  { value: 'firedEvent', label: 'Fired event', side: 'mailer' },
  { value: 'notFiredEvent', label: 'Has NOT fired event', side: 'mailer' },
  { value: 'subscribedAfter', label: 'Subscribed after', side: 'mailer' },
  { value: 'subscribedBefore', label: 'Subscribed before', side: 'mailer' },
  { value: 'opened', label: 'Opened', side: 'mailer' },
  { value: 'notOpened', label: 'Did NOT open', side: 'mailer' },
  { value: 'any', label: 'Any of (OR)', side: 'composite' },
  { value: 'not', label: 'NOT', side: 'composite' },
] as const

export function defaultSegmentFilter(kind: SegmentFilterKind): SegmentFilter {
  switch (kind) {
    case 'subscriptionStatus': return { kind: 'subscriptionStatus', equals: 'subscribed' }
    case 'hasTag': return { kind: 'hasTag', tag: '' }
    case 'notHasTag': return { kind: 'notHasTag', tag: '' }
    case 'fieldEquals': return { kind: 'fieldEquals', field: '', value: '' }
    case 'fieldIn': return { kind: 'fieldIn', field: '', values: [] }
    case 'fieldExists': return { kind: 'fieldExists', field: '' }
    case 'firedEvent': return { kind: 'firedEvent', eventName: '', withinDays: 30 }
    case 'notFiredEvent': return { kind: 'notFiredEvent', eventName: '', withinDays: 90 }
    case 'subscribedAfter': return { kind: 'subscribedAfter', date: new Date(Date.now() - 30 * 86_400_000) }
    case 'subscribedBefore': return { kind: 'subscribedBefore', date: new Date() }
    case 'opened': return { kind: 'opened', withinDays: 14 }
    case 'notOpened': return { kind: 'notOpened', withinDays: 14 }
    case 'any': return { kind: 'any', filters: [] }
    case 'not': return { kind: 'not', filter: { kind: 'hasTag', tag: '' } }
  }
}

// ---------------------------------------------------------------------------
// Dedupe policies for event registration
// ---------------------------------------------------------------------------

export interface DedupePolicyOption {
  value: 'once-per-contact' | 'once-per-day' | 'every-time'
  label: string
  description: string
  derivedKeyShape: string
}

export const DEDUPE_POLICIES: readonly DedupePolicyOption[] = [
  {
    value: 'once-per-contact',
    label: 'Once per contact',
    description: 'Lifecycle markers (Created, Activated)',
    derivedKeyShape: '${externalId}:${eventName}',
  },
  {
    value: 'once-per-day',
    label: 'Once per day',
    description: 'Daily behaviors (Viewed Storyboard)',
    derivedKeyShape: '${externalId}:${eventName}:${YYYY-MM-DD}',
  },
  {
    value: 'every-time',
    label: 'Every time',
    description: 'True every-occurrence events (Imported)',
    derivedKeyShape: '${externalId}:${eventName}:${UUIDv4}',
  },
] as const
