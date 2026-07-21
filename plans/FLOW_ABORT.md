# Flow Abort — a first-class way to stop a contact's flow runs

Status: **implemented** (suggestion #1 — `abortFlow` / `abortAllFlows`; #2 and #3 remain future options)
Origin: Maxed Marketing trial-sequence integration (first real host wiring of v0.6)

## Implemented API

### `mailer.abortFlow(flowSlug, externalId, opts?)`

```ts
const result = await mailer.abortFlow('trial-onboarding', userId, { reason: 'upgraded' })
// result: { abortedRuns: number, cancelledSends: number }
```

Aborts every **active** run of the flow for that contact, immediately:

1. **Exits the runs** (`status: 'exited'`, `exitReason: 'aborted_by_host:<reason>'`,
   history entry). Runs parked in a `wait` exit too — the delayed wake-up job
   finds the run non-active and no-ops (`processOneRunStep` guards on
   `status === 'active'`).
2. **Cancels undispatched mail** produced by the flow's past send steps: any
   send row for those runs still in `queued` or `failed` (awaiting retry)
   becomes `status: 'cancelled'` and is never dispatched. This closes the
   windows where a send lingers in the queue — provider retry backoff, a
   tripped circuit breaker, or the stranded-send sweep — and would otherwise
   deliver after the abort.
3. **Writes an audit row** (`action: 'flow.abort'`, actor `host`) when anything
   was aborted or cancelled.

Returns `{ abortedRuns: 0, cancelledSends: 0 }` as a no-op when nothing is
active. Throws on an unknown `flowSlug`. `reason` is optional (≤200 chars);
without it the exit reason is plain `aborted_by_host`.

### `mailer.abortAllFlows(externalId, opts?)`

```ts
await mailer.abortAllFlows(userId, { reason: 'account-deleted' })
```

Same semantics with no flow filter — exits every active run for the contact
across all flows (audit action `flow.abort_all`). For "stop everything" events:
account deleted, churned, hard opt-out.

### Belt-and-suspenders dispatch guard

`dispatchSend` now refuses to dispatch a send whose flow run was host-aborted
(`status === 'exited'` and `exitReason` starts with `aborted_by_host`), marking
it `cancelled` instead. This closes the race where a send is (re-)enqueued
between the abort's cancellation sweep and dispatch. Sends of completed or
naturally-exited runs still dispatch — their mail was legitimately queued.

### Supporting changes

- `SendStatus` union gained `'cancelled'` (`src/shared/enums.ts`). Cancelled
  sends are skipped by the dispatch worker and ignored by the stranded-send
  sweep.
- Input validation: `abortFlowInputSchema` / `abortAllFlowsInputSchema`
  (`src/shared/schemas.ts`).
- `exitFlowRun` re-exported from `src/server/runner/index.js` (the abort path
  reuses the runner's exit primitive, as planned).
- Tests: `test/integration/flow-abort.test.ts` — wait-parked abort, send
  cancellation, dispatch-time guard, no-op, unknown slug, abort-all.

### Semantics worth knowing

- **`trigger.once` interplay:** a flow with `trigger: { once: true }` will not
  re-enter for a contact who has *any* prior run, aborted included. Right for
  trials (one trial ever); if you want "pause now, allow later re-entry," the
  flow must not be `once`.
- **In-flight provider calls:** a send already in `sending` (provider call in
  progress at abort time) is not clawed back. The abort windows closed here are
  the queued/retrying ones.
- **No transactional variant:** unlike `fire()`/`fireFromSession()`, abort has
  no outbox path. Calling it inside a host transaction that later rolls back
  leaves the abort applied. Call it after commit.

## Original proposal (for context)

## The use case

A host app runs lifecycle sequences where a business event must stop all pending
email for a contact. The canonical example from the first production
integration:

- **trial-onboarding** — triggered by `Trial Started`, 6 sends across a 10-day
  trial, ends by firing a synthetic `Trial Expired` event…
- **trial-winback** — …which triggers 5 more sends across the following month.
- **If the customer upgrades at any point, both sequences must stop.** Nothing
  is more embarrassing than "your preview has ended — claim your account" landing
  in the inbox of someone who paid yesterday.

"Stop everything for this contact when X happens" is not specific to trials. The
same shape appears everywhere flows exist: user churns → stop onboarding; user
completes the goal → stop the nudges; support escalation → pause marketing;
account deleted → stop everything.

## How it's done today, and what that costs

The only tool available is the per-step condition guard:

```ts
steps: [
  { type: 'send', templateSlug: 'trial-day0-access' },
  { type: 'wait', value: 1, unit: 'days' },
  { type: 'condition', test: { notHasFiredEvent: 'Upgraded' }, ifFalse: 'exit' },
  { type: 'send', templateSlug: 'trial-day1-what-ai-says' },
  { type: 'wait', value: 2, unit: 'days' },
  { type: 'condition', test: { notHasFiredEvent: 'Upgraded' }, ifFalse: 'exit' },
  { type: 'send', templateSlug: 'trial-day3-labels' },
  // … ×6 more
]
```

Problems, in decreasing order of pain:

1. **O(sends) ceremony.** The two trial flows carry **10 identical guard steps**
   for one sentence of intent ("upgrade cancels everything"). Every new send
   step silently requires remembering its guard — the failure mode of forgetting
   is exactly the embarrassing email above, and nothing warns you.
2. **Delayed exit semantics.** Guards only evaluate at step boundaries. A run
   parked in a 7-day `wait` stays active for up to 7 days after the upgrade.
   It exits before *sending* anything (correct outcome), but dashboards show
   active runs that are really zombies, and any step with side effects
   (webhook, tag, fire_event) placed before the next guard still executes.
3. **The host must express "stop" as an event.** The integration registers an
   `Upgraded` event whose only consumer is guard predicates. It pollutes the
   event registry and per-contact event history with what is really a control
   signal, and it forces a dedupe-policy decision (`once-per-contact`?
   `every-time`?) for something that isn't behavioral data.
4. **Positional fragility.** Guards are just steps; reordering in the admin UI
   can separate a guard from the send it protects. (The related
   `ifFalse: 'continue'` skip-one-step gate has the same fragility — acceptable
   for content gating, worrying for lifecycle correctness.)

The condition system itself is fine — per-step predicates are the right tool for
*conditional content* ("skip the competitor email when no competitor is set").
The mismatch is using a per-step tool for a *flow-lifecycle* concern.

## Suggested cleaner approaches

Complementary, not either/or. Listed in recommended build order.

### 1. `mailer.abortFlow()` — imperative host primitive

```ts
await mailer.abortFlow('trial-onboarding', externalId, { reason: 'upgraded' })
await mailer.abortFlow('trial-winback',  externalId, { reason: 'upgraded' })
// or: await mailer.abortAllFlows(externalId, { reason: 'account-deleted' })
```

Exits every active run of the flow for that contact **immediately** — including
runs parked in `wait` (the scheduled wake-up finds the run exited and no-ops).
No-op when nothing is active. Writes run history + audit
(`aborted_by_host:upgraded`).

- Smallest possible mental model: the host knows the moment the business event
  happens (it's already calling `fire()` there) and says what it means directly.
- Kills problems 1–4 outright for hosts willing to write one line of code.
- Reuses `exitFlowRun`; the runner already tolerates exited runs at wake-up
  (verify + add a test). Small, self-contained change.

### 2. `cancelOnEvents` — declarative flow-level cancel

```ts
{
  slug: 'trial-onboarding',
  trigger: { type: 'event', eventName: 'Trial Started', once: true },
  cancelOnEvents: ['Upgraded'],
  steps: [ /* pure waits + sends */ ],
}
```

Event processing (alongside `processNewlyFiredEventTriggers`) exits active runs
of any flow whose `cancelOnEvents` contains the incoming event. One line in the
flow definition replaces every guard; visible in the admin UI where flows are
reviewed; works for admin-authored flows without host code changes.

- Keeps the "stop" signal reviewable next to the steps it governs.
- Still requires the control-signal event to exist (problem 3 remains), and
  exit happens at event-ingestion time rather than the same instant as the
  host-side state change. Best built as sugar **on top of** #1's exit path.

### 3. `guard` — flow-level predicate checked before every step

```ts
{
  slug: 'trial-onboarding',
  guard: { notHasFiredEvent: 'Upgraded' },   // evaluated before EACH step; false → exit
  steps: [ /* … */ ],
}
```

A middle ground that reuses the existing predicate vocabulary: semantically
identical to writing the guard before every step, but stated once. Fixes
problems 1 and 4 with zero new runtime concepts; keeps problems 2 and 3
(boundary-time evaluation, control-signal event). Cheap to implement in the
step loop; pairs well with either of the above rather than replacing them.

## Recommendation

Build **#1 (`abortFlow`)** first — it is the primitive the others can be
expressed with, it has the cleanest semantics (instant, no control-event
needed), and it unblocks the trial-sequence integration immediately: the two
flows drop all 10 guard steps and the `Upgraded` event registration, and the
host's upgrade handler calls `abortFlow` twice.

Add **#2 or #3** later if admin-authored flows need self-contained cancel
semantics without host involvement. Per-step conditions stay exactly as they
are — they remain the right tool for conditional content within a flow.
