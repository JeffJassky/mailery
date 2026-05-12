# Flows

Flows are event-triggered automations. They live as documents in `mailer_flows` and execute step-by-step via the flow runner.

## Anatomy

```ts
{
  slug: 'activation-rescue',
  name: 'Activation Rescue',
  description: 'Sent if a user signs up but never activates within 24h.',

  trigger: {
    type: 'event',
    eventName: 'Created',
    once: true,                     // enter at most once per contact
  },

  enabled: true,

  steps: [
    { type: 'wait', value: 1, unit: 'days' },
    { type: 'condition', test: { notHasFiredEvent: 'Activated app' }, ifFalse: 'exit' },
    { type: 'send', templateSlug: 'activation-rescue-day-1' },
    { type: 'wait', value: 3, unit: 'days' },
    { type: 'condition', test: { notHasFiredEvent: 'Activated app' }, ifFalse: 'exit' },
    { type: 'send', templateSlug: 'activation-rescue-day-4' },
  ],

  version: 1,
  goal: 'activation',
  audience: 'New signups who haven't activated within 24h',
  // ...stats, timestamps
}
```

## Step types

| Step | What it does |
|---|---|
| `wait` | Sleep N minutes/hours/days/weeks. The runner schedules a delayed wakeup. |
| `condition` | Evaluate a predicate. If true: continue. If false: exit (or skip one step). |
| `branch` | Evaluate a predicate. Recurse into `ifTrueSteps` or `ifFalseSteps`. |
| `send` | Send a template. Provider chosen by step override → template override → kind default → global default. |
| `tag` | Add/remove tags on the contact (routed through the adapter's `addTags`/`removeTags`, or `mailer_contact_tags` fallback). |
| `fire_event` | Insert a synthetic event into `mailer_events`. Useful for cross-flow handoffs. |
| `webhook` | POST to a URL. Soft-fail or `failureMode: 'fail_run'` to abort the flow. |
| `exit` | End the run with an optional reason. |

Full type definitions: [Flow steps & predicates](/reference/types-flow).

## Predicates

Predicates evaluate against the contact (host fields + tags) and mailer state (events, sends, subscription).

```ts
// Simple
{ hasTag: 'vip' }
{ fieldEquals: { field: 'tier', value: 'Pro' } }
{ subscriptionStatus: 'subscribed' }
{ hasFiredEvent: 'Activated app', withinDays: 7 }
{ notHasFiredEvent: 'Cancelled' }

// Engagement (label: noisy — Apple MPP + bots inflate counts)
{ hasOpened: { templateSlug: 'welcome-1', sinceFlowStart: true } }
{ hasOpenedExcludingBots: { withinDays: 30 } }
{ clickedAtLeastN: { count: 2, withinDays: 30 } }

// Composition
{ all: [ { hasTag: 'vip' }, { fieldEquals: { field: 'tier', value: 'Pro' } } ] }
{ any: [ { hasTag: 'beta' }, { hasTag: 'preview' } ] }
{ not: { hasTag: 'banned' } }
```

## Authoring

Three ways to create / edit flows:

### 1. Admin UI

Visit `/admin/mailer/flows`, click "New flow". Fill out the form. Add steps via the step palette. Publish when ready.

### 2. Direct DB insert

Insert into `mailer_flows` directly. Always start with `enabled: false` and put your work in `draft.steps`; publish promotes draft → live and snapshots the previous version into `mailer_flow_versions`.

```ts
await db.collection('mailer_flows').insertOne({
  slug: 'commercial-creator-onboarding',
  name: 'Commercial Creator Onboarding',
  trigger: { type: 'event', eventName: 'Created', once: true },
  enabled: false,
  steps: [],
  version: 0,
  draft: {
    steps: [
      { type: 'condition', test: { fieldEquals: { field: 'tier', value: 'Pro' } }, ifFalse: 'exit' },
      { type: 'send', templateSlug: 'commercial-welcome' },
      { type: 'wait', value: 3, unit: 'days' },
      { type: 'send', templateSlug: 'commercial-pro-features' },
    ],
    notes: 'Initial draft',
    lastModifiedBy: 'script:deploy',
    lastModifiedAt: new Date(),
  },
  // ... other required fields
})
```

See [Direct MongoDB writes](https://github.com/JeffJassky/mailery/blob/main/plans/DIRECT_DB.md) for full cookbooks.

### 3. Programmatic via deploy script

Wrap the above in a Node script and run as part of your deploy pipeline:

```ts
// scripts/deploy-flows.ts
for (const flow of flowDefinitions) {
  await db.collection('mailer_flows').updateOne(
    { slug: flow.slug },
    { $set: { 'draft.steps': flow.steps, 'draft.lastModifiedAt': new Date() } },
    { upsert: true },
  )
}
```

Then publish via the admin UI or another script call.

## Idempotency

A flow with `trigger.once: true` will never enter a contact twice. mailery checks for an existing `flow_run` row before inserting a new one. If a contact unsubscribes mid-flow, in-flight runs exit immediately on the next step transition.

Each `send` step has a `dedupeKey = ${flowRunId}:${stepIndex}`. If two workers race on the same step, only one wins the `Send` insert; the second's enqueue is a silent no-op.

## Versioning

Editing a flow doesn't affect contacts already in it. Each `flow_run` pins `flowVersion` on entry. The runner reads steps from `mailer_flow_versions` when the version doesn't match the live `flow.version`.

To force in-flight runs to switch to a new version: exit them via the admin UI, then re-fire the trigger event.

## Pausing & stopping

- **Pause** (admin UI): `enabled: false`. No new entrants. In-flight runs continue.
- **Stop** (admin UI): `enabled: false` AND bulk-exit all active runs.
- **Cancel one run**: from the contact detail page, click "Cancel" on the active run.
