# 19 — `wait_until`: a flow wait anchored to a host date

Drafted 2026-11-11. Target release 0.22.0. Additive: no migration, no change to
existing flows or runs.

## 0. Why

A flow `wait` only sleeps for a fixed duration (`value` + `unit`). A flow whose
emails belong to a deadline the host owns (a trial end, a renewal, an
appointment) has to hardcode the distance to that deadline in its waits. When
the host moves the deadline, the run keeps its old schedule: the "3 days left"
email goes out on the old day and the handoff event fires while access is still
live.

The driving case is Maxed's trial clock flow (`send` → `wait 7d` → `send` →
`wait 3d` → `send` → `fire_event Trial Expired`). Extending a trial by 20 days
cannot be expressed without either a host-side scheduler or aborting and
rebuilding the run.

Programs already solve this for fact-gated actions (`minAgeDays` / `maxAgeDays`
on date facts, and the run wakes when the condition flips, plans/17 F1). Flows
have no equivalent. This plan adds one.

### Why not move those emails into a Program

Considered and rejected for the driving case. Program sends are marketing-scope:
contact policy can defer them, holdout can withhold them, sunset can slow them.
Deadline emails ("today is your last day") are transactional and must land on
the day. A flow is the right home; it only lacks a date-anchored wait.

## 1. The step

```ts
| {
    type: 'wait_until'
    /** Name of a date fact declared by the factsAdapter. */
    fact: string
    /** Key in the run's trigger-event properties that holds the subject id. */
    subjectFrom: string
    /** Days relative to the fact. Negative = before. Real number. Default 0. */
    offsetDays?: number
    /** Fact unset, null or unparseable, or subject id missing. Default 'exit'. */
    ifMissing?: 'exit' | 'continue'
  }
```

Example, the trial clock rewritten:

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

### Design choices

| Choice | Decision | Reason |
|---|---|---|
| Where the date comes from | `factsAdapter.resolve(subjectId)` | Facts are already declared with types (`date`), already documented as live host state (INVARIANT 20), already cheap enough to call per tick, and the declaration drives editor dropdowns and publish validation. The vars adapter is a render-time contract and is often expensive. |
| Why not a trigger-event property | Rejected | Trigger properties are a snapshot taken when the run started. A deadline that moves is exactly the case this step exists for. |
| How a flow finds its subject | `subjectFrom` names a trigger property | Flows have no subject; the trigger event already carries it (`accountId`), the same way `varsAdapter` and `abortFlow({ matchTriggerProperties })` scope by it. |
| Offset unit | `offsetDays`, real number | Matches `minAgeDays` / `maxAgeDays`. One number, sign gives direction. |
| Missing date default | `exit` | Sending a deadline email with no deadline is worse than sending nothing. |
| Date already past | Continue immediately | Same as a wait that has elapsed. |

## 2. Runner semantics

`handleWaitUntil` in `src/server/runner/step.ts`. It parks the run **on the same
step** (the `deferSendForWindow` pattern), unlike `wait`, which increments the
step index when it parks. That is what makes the date live: every wake re-enters
the step and reads the fact again.

On each entry:

1. `subjectId = run.triggerEvent?.properties?.[step.subjectFrom]`. Not a
   non-empty string → `ifMissing`.
2. `facts = await ctx.config.factsAdapter.resolve(subjectId)`.
   `target = toEpochMs(facts[step.fact]) + offsetDays * DAY_MS`. Not finite →
   `ifMissing`.
3. `target <= now + DUE_SKEW_MS` → `advanceStep` with history
   `wait_until_reached` (`details: { fact, target }`).
4. Otherwise park: `nextActionAt = min(target, now + recheckMs)`. Enqueue a
   delayed advance job, `jobId` includes the wake instant (as the window
   deferral does). Push history `wait_until_parked` only when `target` differs
   from the last parked target for this step, so rechecks do not grow history.

`ifMissing`: `continue` → `advanceStep` with `wait_until_skipped`; `exit` →
`exitFlowRun(run, 'wait_until_missing')`.

### What this gives

- **Deadline moved later** (extension): the run wakes at the old time, re-reads,
  parks again. No host call, no abort.
- **Deadline moved earlier**: picked up at the next recheck. `recheckMs` comes
  from a new flat config key `MailerConfig.flowWaitUntilRecheckHours`, default
  24. A value that is not a finite number of at least 1 is rejected at
  `Mailer.init` with a thrown error, like the other config validators. A host
  that needs it sooner aborts and re-fires, as today.
- **Resolver throws**: the step throws, nothing is written, the run stays due
  and the tick sweep retries it. Same failure shape as any other step.
- **Abort, unsubscribe, missing contact**: unchanged. The run is `active` with a
  future `nextActionAt`; `abortFlow` and the per-wake contact and subscription
  gates already cover it.
- **Concurrency**: the park write is filtered on `_id` + `currentStepIndex`;
  two workers parking the same run write the same values and the job id dedupes.
- **Flow versioning** (INVARIANT 15): unaffected. In-flight runs keep their
  version's steps.

### Not in scope

- A `wakeFlow` API to force an immediate re-read. The recheck cap covers it;
  add later if a host needs sub-day reaction to an earlier date.
- Fact predicates in flow `condition` / `branch` steps. Separate feature.
- Any change to `wait`.

## 3. File-by-file

| File | Change |
|---|---|
| `src/shared/types.ts` | Add the `wait_until` variant to `FlowStep`. |
| `src/shared/schemas.ts` | Add to `flowStepSchema`: `fact` and `subjectFrom` non-empty strings, `offsetDays` finite number, `ifMissing` enum. |
| `src/shared/options.ts` | Entry in `FLOW_STEP_KINDS`; case in `defaultFlowStep`. |
| `src/server/models/index.ts` | History actions `wait_until_parked`, `wait_until_reached`, `wait_until_skipped`. |
| `src/server/config.ts` | Flat key `flowWaitUntilRecheckHours` (default 24), declared, defaulted and resolved in the same three places as `tickIntervalSeconds`. Config has no `flows` group. Below 1 or not finite → throw at init. |
| `src/server/runner/step.ts` | `case 'wait_until'` + `handleWaitUntil`. Reuse `toEpochMs` from `runner/programs/predicate.ts` (move it to a shared runner util if the import direction is awkward). |
| `src/server/runner/simulate.ts` | `case 'wait_until'`: resolve facts once per subject, advance the virtual clock to the target, honour `ifMissing`. New outcome `waited_until`. Accept a `facts` override in `SimulateOptions`, merged over the live facts, as the program simulator does. |
| `src/server/api/agent.ts` (`POST /flows/:slug/simulate`, ~590) | Accept an optional `facts` object in the body and pass it through. Without it the simulation uses live facts. Reject a non-object with 400. Apply the same to an admin simulate route if one exists. |
| `src/testing/builders.ts` (`step`, ~163) | Add `step.waitUntil(fact, subjectFrom, opts?)`. |
| `src/server/api/admin.ts` (`POST /flows/:slug/publish`, ~1252) | Validate each `wait_until`: a `factsAdapter` is configured, `fact` is declared, its type is `date`. Return 422 with issues in the shape program publish uses. Flow draft and publish do no step validation today (steps are stored as sent), so this check is new and is scoped to `wait_until` steps only. Hosts that write flows straight to Mongo bypass it, so the runner must also fail a misconfigured step safely (see 19a). |
| `src/server/api/agent.ts` (`advanceOnce`, ~1613) | Forcing must advance past a `wait_until`. The existing mechanism (set `nextActionAt` to now, call `processOneRunStep`) cannot: the step re-reads a date that is still in the future and parks again, with no new history entry. Add a branch: load the run's current step (`loadStepsForRun` + `locateStep`); when it is a `wait_until`, call `advanceStep` directly with action `wait_completed` and `details: { forcedBy, fact, scheduledFor }`, then loop to process what follows. `advanceStep` logs `run.currentStepIndex`, which is correct here; the existing forced-`wait` entry logs `currentStepIndex - 1` because `wait` has already moved the index, so do not reuse that write. A forced `wait_until` skips the `ifMissing` check; that is what force means. |
| `src/client/screens/flow-detail.tsx` | Step summary (`until trial_ends_at − 3d`); editor: date-fact dropdown from the declared facts, `subjectFrom` input, offset input, `ifMissing` select. Disabled with a hint when no `factsAdapter` is configured. Run view renders the three new history actions. |
| `src/testing/*` | `drain` already skips runs with a future `nextActionAt`; confirm a parked `wait_until` does not spin it. Memory facts adapter already exists. |
| `docs/guide/flows.md`, `docs/reference/types-flow.md` | Step table row, a "waiting for a host date" section with the trial example and the recheck rule. |
| `plans/INVARIANTS.md` | New invariant: a `wait_until` reads its date at every wake and never stores it as the schedule of record. |
| `CHANGELOG.md`, `package.json` | 0.22.0. |

## 4. Tests

Integration, alongside `wait-not-skipped.test.ts` and
`account-scoped-runs.test.ts`, using the memory facts adapter:

1. Date in the past → step advances at once, history `wait_until_reached`.
2. Date in the future → run parked on the same step, `nextActionAt` = target
   (or the recheck cap when the target is further out).
3. Date moved later while parked → wake re-parks; the following send does not go out.
4. Date moved earlier while parked → advances at the next recheck.
5. Fact null / subject property missing → `exit` and `continue` variants.
6. Two runs for one contact, different subjects → each follows its own date.
7. `abortFlow` on a parked run → exits, no later send.
8. Resolver throws → run unchanged and still due; succeeds on the next pass.
   Call `processOneRunStep` directly and expect it to reject: `drain` counts
   due runs, so a run that keeps throwing makes it burn all its rounds and
   return `settled: false`. Use `drain` only after the adapter is fixed.
9. Repeated rechecks with an unchanged target add no history entries.
10. Negative, zero, fractional and positive `offsetDays`.

Unit: schema accept/reject; target arithmetic. Simulate: projected times with and
without a `facts` override. Publish: undeclared fact, non-date fact, no adapter.
Client: summary text and editor round-trip.

`test/longhorizon/real-clock.test.ts`: one real-queue case, date 2 minutes out,
moved 1 minute later while parked.

## 5. Order of work

1. Types, schema, options, config, history actions.
2. Runner handler + integration tests 1 to 10.
3. Publish validation + simulate.
4. Agent force loop.
5. Client editor and run view.
6. Docs, invariant, changelog, release 0.22.0.

Steps 1 to 3 are the usable core (a host can seed flows by script). Roughly two
days of work for 1 to 4, one more for 5 and 6.

## 6. What the host (Maxed) does with it

- Seed a new flow slug with the steps in section 1; leave `trial-onboarding`
  enabled only to drain its in-flight runs, then disable it.
- Add the new slug to the list `abortTrialFlows` covers.
- `trial_ends_at` is already a declared date fact and the subject id is already
  the account id, so no adapter work.
- Extending a trial becomes a write to `trialEndsAt`. Runs still waiting follow
  it on their own. Only a run that already finished its tail (expired, or in
  winback) needs abort + re-fire.

## 7. Decided

1. `ifMissing` defaults to `exit`.
2. Recheck defaults to 24 hours.
3. Forcing a step in the agent API advances past a `wait_until`.
