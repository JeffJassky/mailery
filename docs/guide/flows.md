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

## Event parameters (scoped flows)

Contacts are always people — suppression, subscription, and unsubscribe are
per-email-address. When a flow is *about* something else (an account the user
belongs to, a topic that hit a milestone), the trigger event carries that
scope:

```ts
// Host code: a topic met its criteria → notify every member of the account.
for (const member of await accountMembers(accountId)) {
  await mailer.fire('TopicReady', member.userId, { accountId, topicId },
    `topic-ready:${accountId}:${topicId}:${member.userId}`)  // explicit dedupeKey
}
```

Each run snapshots the triggering event. From there:

- Templates read the raw properties: `{{event.accountId}}`, `{{event.topicId}}`.
- Your [`varsAdapter`](./templates#host-variables-varsadapter) resolver gets
  `info.eventProperties` and `info.eventName`, and uses them to load the
  *right* account/topic for typed, structured variables:

```ts
async resolve(contact, info) {
  const accountId = info.eventProperties?.accountId
  return {
    user: await loadUser(contact.externalId),
    account: accountId ? await loadAccount(accountId) : null,
    topic: info.eventProperties?.topicId ? await loadTopic(info.eventProperties.topicId) : null,
  }
}
```

Re-entry semantics: `trigger.once` is once per **contact** per flow, forever —
a user can never re-enter for a second account. For "once per contact per
account/topic", set `once: false` and scope the `fire()` dedupeKey as above:
the event insert dedupes on the key, so flow entry dedupes with it.

Previews can simulate the scope: pass `eventProperties` to
`POST /api/templates/:slug/preview` (or send-test) and both `{{event.*}}` and
the resolver see it.

## Delivery windows

A `send` step can constrain **when** the email actually goes out. The flow's
waits set the earliest moment (T + N days); the window pushes that moment
forward — never backward — to the next allowed slot:

```ts
{
  type: 'send',
  templateSlug: 'day-3-tips',
  delivery: {
    weekdaysOnly: true,        // lands on Sat/Sun → waits until Monday
    timeOfDay: '09:00',        // deliver at 9am local time
    useContactTimezone: true,  // 9am in contact.timezone when known…
    timezone: 'America/New_York', // …else 9am here (IANA name; default UTC)
  },
}
```

Semantics:

- **`weekdaysOnly`** — if the computed slot falls on a Saturday or Sunday (in
  the resolved timezone), it moves to Monday at the same clock time. So a
  trial-start flow with `wait 3 days` where T+3 lands on Saturday delivers
  Monday morning instead.
- **`timeOfDay`** (`'HH:mm'`) — the send waits for the next occurrence of that
  local wall-clock time. Arriving *shortly after* the slot (≤ 1 hour) sends
  immediately, so tick jitter never adds a day; arriving later waits for
  tomorrow's slot.
- **Timezone resolution** — `contact.timezone` (when `useContactTimezone` and
  present) → `timezone` → UTC. Invalid zone names fall back down the chain.
- The run parks on the send step (`send_deferred` in the run history) and a
  delayed advance job re-fires it when the window opens. All other checks
  (suppression, circuit breaker, subscription) still run at actual send time.

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
