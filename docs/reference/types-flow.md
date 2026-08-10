# Flow steps & predicates

```ts
import type { FlowStep, Predicate } from 'mailery'
```

## FlowStep

A discriminated union — each step has a `type` field.

```ts
type FlowStep =
  | { type: 'wait'; value: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' }
  | { type: 'condition'; test: Predicate; ifFalse: 'continue' | 'exit' }
  | { type: 'branch'; test: Predicate; ifTrueSteps: FlowStep[]; ifFalseSteps: FlowStep[] }
  | { type: 'send'; templateSlug: string; providerOverride?: string; vars?: Record<string, unknown>; delivery?: DeliveryWindow }
  | { type: 'tag'; addTags?: string[]; removeTags?: string[] }
  | { type: 'fire_event'; eventName: string; properties?: Record<string, unknown> }
  | { type: 'webhook'; url: string; method?: 'POST' | 'PUT'; payload?: Record<string, unknown>; failureMode?: 'soft' | 'fail_run' }
  | { type: 'exit'; reason?: string }
```

### `wait`

```ts
{ type: 'wait', value: 24, unit: 'hours' }
{ type: 'wait', value: 3, unit: 'days' }
```

The runner schedules a delayed wakeup at `now + duration`. While waiting, the flow_run is in `status: 'active'` but `nextActionAt` is the future. No CPU spent until the wakeup.

### `condition`

```ts
{ type: 'condition', test: { notHasFiredEvent: 'Activated app' }, ifFalse: 'exit' }
{ type: 'condition', test: { hasTag: 'vip' }, ifFalse: 'continue' }
```

- `ifFalse: 'exit'` — end the run if the predicate is false (most common).
- `ifFalse: 'continue'` — skip the next step and resume from the step after.

For two-way branching with distinct sub-flows, use `branch`.

### `branch`

```ts
{
  type: 'branch',
  test: { hasTag: 'vip' },
  ifTrueSteps: [
    { type: 'send', templateSlug: 'vip-welcome' },
    { type: 'wait', value: 7, unit: 'days' },
    { type: 'send', templateSlug: 'vip-followup' },
  ],
  ifFalseSteps: [
    { type: 'send', templateSlug: 'standard-welcome' },
  ],
}
```

Recurse into one or the other sub-list. When the chosen sub-list completes, the run exits (control doesn't return to the parent step list).

### `send`

```ts
{ type: 'send', templateSlug: 'welcome-1' }
{ type: 'send', templateSlug: 'pro-welcome', providerOverride: 'postmark' }
{ type: 'send', templateSlug: 'invoice', vars: { invoiceId: 'inv_123' } }
```

`templateSlug` references a published `mailer_templates` row by slug. The dedupeKey = `${flowRunId}:${stepIndex}` ensures a given step in a given run produces at most one send.

The optional `delivery` window delays the send until the next allowed slot:

```ts
interface DeliveryWindow {
  weekdaysOnly?: boolean       // Sat/Sun slot → Monday, same clock time
  timeOfDay?: string           // 'HH:mm' local wall-clock delivery time
  useContactTimezone?: boolean // prefer contact.timezone when present
  timezone?: string            // IANA fallback zone; default UTC
}
```

See [Flows → Delivery windows](/guide/flows#delivery-windows) for semantics.

Provider selection priority: step `providerOverride` > template `providerOverride` > kind-specific default > global `defaultProvider`.

### `tag`

```ts
{ type: 'tag', addTags: ['engaged'] }
{ type: 'tag', addTags: ['vip'], removeTags: ['cold'] }
```

Routes through `adapter.addTags` / `removeTags` if defined; otherwise writes to `mailer_contact_tags`.

### `fire_event`

```ts
{ type: 'fire_event', eventName: 'Activation Email Sent', properties: { from: 'flow' } }
```

Inserts a synthetic event row. Useful for cross-flow handoffs — one flow's `fire_event` can be another flow's trigger. Dedupe key is `flowrun:${runId}:step${stepIndex}:${eventName}` so re-running the step doesn't duplicate.

### `webhook`

```ts
{ type: 'webhook', url: 'https://analytics.example/event', method: 'POST', payload: { /* ... */ } }
```

POSTs to an external URL. By default, network/5xx failures retry up to `webhookRetryAttempts` (default 3) before logging and advancing. To abort the flow on failure: `failureMode: 'fail_run'`.

### `exit`

```ts
{ type: 'exit', reason: 'goal_reached' }
```

End the run with a recorded reason. Useful at the end of a `branch` sub-list to be explicit.

## Predicate

```ts
type Predicate =
  | { hasTag: string }
  | { notHasTag: string }
  | { fieldEquals: { field: string; value: unknown } }
  | { fieldExists: string }
  | { hasFiredEvent: string; sinceFlowStart?: boolean; withinDays?: number }
  | { notHasFiredEvent: string; withinDays?: number }
  | { subscriptionStatus: 'subscribed' | 'unsubscribed' | 'pending_doi' | 'bounced' | 'complained' }
  | { hasOpened: { templateSlug?: string; sinceFlowStart?: boolean; withinDays?: number } }
  | { hasClicked: { templateSlug?: string; sinceFlowStart?: boolean; withinDays?: number } }
  | { hasOpenedExcludingBots: { templateSlug?: string; sinceFlowStart?: boolean; withinDays?: number } }
  | { hasClickedExcludingBots: { templateSlug?: string; sinceFlowStart?: boolean; withinDays?: number } }
  | { openedAtLeastN: { count: number; withinDays: number } }
  | { clickedAtLeastN: { count: number; withinDays: number } }
  | { all: Predicate[] }                                  // AND
  | { any: Predicate[] }                                  // OR
  | { not: Predicate }
```

### Evaluation

Predicates are evaluated when the runner processes a `condition` or `branch` step. Field/tag checks query the live contact via the adapter; event checks query `mailer_events`; send-engagement checks query `mailer_sends`.

`sinceFlowStart: true` scopes the check to events/sends since `flow_run.enteredAt`. `withinDays: 7` is the same as `since: now - 7d`.

### Engagement predicates are noisy

`hasOpened` and `hasClicked` are flagged in the admin UI with a "noisy signal" badge:

- Apple Mail Privacy Protection prefetches all images → every send to an Apple Mail user shows as "opened" within seconds.
- Corporate firewalls (Mimecast, Proofpoint, SafeLinks) prefetch every link in every email → "clicks" without a human.

Prefer `hasOpenedExcludingBots` / `hasClickedExcludingBots` (which filter known bot User-Agents) or, better, real product events (`Used Feature X`) for engagement-based branching.

Know what the filtered variants promise before you branch on them:

- They compare the User-Agent recorded at open/click time against [`botFilter.userAgentPattern`](/guide/configuration#bot-filtering).
- A send counts if **any** of its opens or clicks looks human.
- An open or click with **no** User-Agent counts as human. Many mail clients send none, so the alternative would discard real engagement — but it also means a scanner that sends no UA still counts.
- Sends recorded before v0.15.0 have no stored User-Agent and therefore all count as human. The filter only sharpens going forward; it does not reclassify history.

Prior to v0.15.0, `hasOpenedExcludingBots` and `openedAtLeastN` did no filtering at all and were identical to `hasOpened`. If a flow was tuned against those numbers, expect its open-based branches to fire less often now.

## Examples

### Activation rescue

```ts
const steps: FlowStep[] = [
  { type: 'wait', value: 1, unit: 'days' },
  { type: 'condition', test: { notHasFiredEvent: 'Activated app' }, ifFalse: 'exit' },
  { type: 'send', templateSlug: 'activation-rescue-day-1' },
  { type: 'wait', value: 3, unit: 'days' },
  { type: 'condition', test: { notHasFiredEvent: 'Activated app' }, ifFalse: 'exit' },
  { type: 'send', templateSlug: 'activation-rescue-day-4' },
]
```

### Tier-based welcome

```ts
const steps: FlowStep[] = [
  {
    type: 'branch',
    test: { fieldEquals: { field: 'tier', value: 'Pro' } },
    ifTrueSteps: [
      { type: 'send', templateSlug: 'pro-welcome' },
      { type: 'tag', addTags: ['pro-onboarded'] },
    ],
    ifFalseSteps: [
      { type: 'send', templateSlug: 'free-welcome' },
      { type: 'wait', value: 7, unit: 'days' },
      { type: 'send', templateSlug: 'free-tips' },
    ],
  },
]
```

### Resend to non-openers

```ts
const steps: FlowStep[] = [
  { type: 'send', templateSlug: 'newsletter-may' },
  { type: 'wait', value: 3, unit: 'days' },
  {
    type: 'condition',
    test: { not: { hasOpenedExcludingBots: { templateSlug: 'newsletter-may', sinceFlowStart: true } } },
    ifFalse: 'exit',
  },
  { type: 'send', templateSlug: 'newsletter-may-resend' },
]
```
