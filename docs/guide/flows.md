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
| `wait_until` | Sleep until a date the host owns (a trial end, a renewal), plus an offset. The date is re-read at every wake. See [Waiting for a host date](#waiting-for-a-host-date). |
| `condition` | Evaluate a predicate. If true: continue. If false: exit (or skip one step). |
| `branch` | Evaluate a predicate. Recurse into `ifTrueSteps` or `ifFalseSteps`. |
| `send` | Send a template. Provider chosen by step override → template override → kind default → global default. |
| `tag` | Add/remove tags on the contact (routed through the adapter's `addTags`/`removeTags`, or `mailer_contact_tags` fallback). |
| `fire_event` | Insert a synthetic event into `mailer_events`. Useful for cross-flow handoffs. |
| `webhook` | POST to a URL. Soft-fail or `failureMode: 'fail_run'` to abort the flow. |
| `exit` | End the run with an optional reason. |

Full type definitions: [Flow steps & predicates](/reference/types-flow).

## Waiting for a host date

A `wait` sleeps for a fixed duration. When the emails belong to a deadline the
host owns, the distance to that deadline changes whenever the host moves it.
`wait_until` waits for the date itself:

```ts
{
  type: 'wait_until',
  fact: 'trial_ends_at',   // a date fact declared by your factsAdapter
  subjectFrom: 'accountId', // trigger-event property holding the subject id
  offsetDays: -3,           // optional; negative = before, decimals allowed
  ifMissing: 'exit',        // optional; 'exit' (default) | 'continue'
}
```

The trial clock, with the sends tied to the deadline:

```ts
steps: [
  { type: 'send', templateSlug: 'trial-day0-access' },
  { type: 'wait_until', fact: 'trial_ends_at', subjectFrom: 'accountId', offsetDays: -3 },
  { type: 'send', templateSlug: 'trial-ending-soon' },
  { type: 'wait_until', fact: 'trial_ends_at', subjectFrom: 'accountId', offsetDays: -1 },
  { type: 'send', templateSlug: 'trial-last-day', delivery: { weekdaysOnly: true } },
  { type: 'wait_until', fact: 'trial_ends_at', subjectFrom: 'accountId' },
  { type: 'fire_event', eventName: 'Trial Expired' },
]
```

Extend the trial by 20 days and every run follows: no abort, no rebuild.

How it works:

- **The subject.** `subjectFrom` is the *name* of a property on the run's
  trigger event (the same way a `varsAdapter` scopes by `accountId`). Its value
  must be a non-empty string; it is passed to
  [`factsAdapter.resolve`](./configuration#programs). It is not a template and
  nothing is rendered. The fact must be declared with type `date`.
- **How the date is read.** A `Date`, a number (epoch **milliseconds**, not
  seconds) or a string starting `YYYY-MM-DD`. A date-only string
  (`'2026-12-01'`) is UTC midnight; a string with a time but no offset
  (`'2026-12-01T09:00:00'`) is read in the **server's** time zone, so send
  ISO strings with `Z` or an offset, or `Date` objects. A host that answers
  "unset" with `0` gets an immediate advance: return `null` instead.
  `offsetDays` is limited to ±36500.
- **Read at every wake.** The run parks on the `wait_until` step itself. Each
  time it wakes, the step reads the fact again and computes
  `date + offsetDays`. The date is never stored as the schedule: if it has
  passed (or is within the tick skew) the run moves on, otherwise it parks again.
- **Recheck rule.** A parked run wakes at the earlier of the target and
  `flowWaitUntilRecheckHours` from now (default **24**, a finite number of at
  least 1, otherwise `Mailer.init` throws). So a date moved *later* is followed
  at the next wake (the run wakes at the old time, re-reads, parks again).
  A date moved *earlier* is noticed within the recheck interval. A host that
  needs it sooner aborts and re-fires.
- **`ifMissing`.** When the subject property is absent, or the fact is unset,
  `null` or unparseable: `exit` (default) ends the run with reason
  `wait_until_missing`; `continue` moves to the next step. Sending a deadline
  email with no deadline is worse than sending nothing, so `exit` is the default.
- **Resolver errors.** If `factsAdapter.resolve` throws, nothing is written and
  the recovery sweep retries the run on its next tick, with no backoff and no
  limit. Return facts without `trial_ends_at` (or `null`) for an unknown subject
  rather than throwing, so the run takes `ifMissing` instead of being retried
  forever. A `resolve` that returns `null` is treated as no facts.
- **History.** `wait_until_parked` (`{ fact, subjectId, target, wakeAt }`,
  written only when the target changes, so rechecks do not grow the history),
  `wait_until_reached` (`{ fact, subjectId, target }`) and `wait_until_skipped`
  (`{ fact, reason: 'subject_missing' | 'fact_missing' }`).
- **Publish validation.** Publishing a flow checks each `wait_until` step: a
  `factsAdapter` must be configured and `fact` must be declared with type
  `date`. A failure is `422 validation_failed` with `issues: [{ path, message }]`
  and nothing is published. Other step types are not validated.
- **Misconfigured steps.** Flows written straight to Mongo skip publish
  validation. The runner re-checks each time and fails the run (it never
  throws, never advances) with `exitReason` `wait_until_misconfigured: <code>`,
  where `<code>` is one of `invalid_fact`, `invalid_subject_from`,
  `invalid_offset_days`, `invalid_if_missing`, `no_facts_adapter`,
  `fact_not_declared` or `fact_not_date`.
- **Forcing and simulating.** The agent API's
  [`POST /runs/:id/advance`](/reference/agent-api#post-runs-id-advance-test-contacts-only)
  moves past a parked `wait_until` (history `wait_completed` with
  `forcedBy`, `fact`, and `scheduledFor`: the date it was waiting for, or
  `null` if it had not parked yet), skipping the `ifMissing` check. A
  misconfigured `wait_until` is not forced past: the run fails as it would for
  real. The flow simulator resolves the fact once per subject and accepts a
  `facts` override (keys must be declared facts); a misconfigured step ends the
  simulation with `terminal.kind: 'failed'`. See [`POST /flows/:slug/simulate`](/reference/agent-api#post-flows-slug-simulate).

Abort, unsubscribe and missing-contact handling are unchanged: a parked run is
an ordinary active run with a future `nextActionAt`.

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

## Contact policy and flow sends

With [`contactPolicy`](./contact-policy) configured, a flow's marketing send can be **deferred**: the send row is created as usual and the step advances, but the email waits (status `deferred`, with a `notBefore` time) until the recipient's gap, cap and quiet hours allow it. The flow does not wait for it; later steps run on their own schedule. When the deferral ends the flow's abort check runs again, so a run aborted in the meantime never sends. A send held past `deferral.maxHours` is cancelled with `exitReason: 'policy_expired'`.

## Pausing & stopping

- **Pause** (admin UI): `enabled: false`. No new entrants. In-flight runs continue.
- **Stop** (admin UI): `enabled: false` AND bulk-exit all active runs.
- **Cancel one run**: from the contact detail page, click "Cancel" on the active run.
- **`abortFlow` / `abortAllFlows`** also cancel the run's sends that are still `queued`, `failed` or `deferred` by the contact policy (a deferred send is cancelled even if its run has already completed). Each cancelled send is reported to the `flow` hook's `onOutcome` as `cancelled`.
