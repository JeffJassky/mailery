# 19a — Handoff: build and release `wait_until` (mailery 0.22.0)

For a fresh agent. Written 2026-11-11. Nothing is built yet. Your job is to
implement the feature specified in [`19-wait-until.md`](./19-wait-until.md),
test it, document it, and take it to a published 0.22.0 release.

Read `19-wait-until.md` first. It is the spec. This file is everything else:
why it exists, what was verified in the code, the traps, the order of work and
the release procedure.

---

## 1. Mission and definition of done

Add one flow step, `wait_until`, that parks a run until a date the host owns,
read live through the facts adapter at every wake.

Done means all of these:

1. `wait_until` works in the runner, the simulator, publish validation, the
   agent API and the admin flow editor, as specified.
2. Tests in section 6 exist and `yarn typecheck && yarn test && yarn build`
   pass on a machine with no network and no `.env`.
3. Docs, `INVARIANTS.md`, `plans/README.md` and `CHANGELOG.md` are updated.
4. `package.json` is at `0.22.0` and the change is merged to `main`.
5. The release is published to npm. **Stop and get Jeff's explicit go-ahead
   before pushing a tag or publishing** (section 8).

## 2. Why this exists

Mailery is embedded in Maxed Marketing (`~/Projects/Amplify11/MaxMarketing`).
Its trial emails run as a flow with fixed waits: day 0, wait 7 days, "three days
left", wait 3 days, "last day", then `fire_event Trial Expired` to start a
winback flow.

Maxed wants to extend trials (an admin button and redeemable codes, +20 days).
With fixed waits an extended trial still gets "three days left" on day 7 and is
handed to winback on day 10 while access is live. The trial end date already
exists in Maxed as a declared date fact, `trial_ends_at`, keyed by account id.
A wait anchored to that fact makes the emails follow the date, whatever it is.

You are not building the Maxed side. Section 9 describes how the host will use
the step so you can judge whether the API fits.

## 3. The feature in one screen

```ts
| {
    type: 'wait_until'
    fact: string            // a date fact declared by MailerConfig.factsAdapter
    subjectFrom: string     // trigger-event property holding the subject id
    offsetDays?: number     // relative to the fact; negative = before; real number; default 0
    ifMissing?: 'exit' | 'continue'   // default 'exit'
  }
```

Behaviour:

- The run parks **on the same step** and re-enters it at every wake. Each entry
  calls `factsAdapter.resolve(subjectId)` and recomputes the target.
- Target reached (or already past) → advance.
- Target in the future → park until `min(target, now + recheck)`.
- Date moved later while parked → the next wake parks again. No host call.
- Date moved earlier → noticed at the next recheck.
- Subject id or date missing → `ifMissing`.

Full semantics, design reasoning and the file table are in `19-wait-until.md`
sections 1 to 3.

### Decisions already taken

These were proposed to Jeff and not objected to. Build them as stated; if he
says otherwise, they are one-line changes.

| Question | Decision |
|---|---|
| `ifMissing` default | `exit`, reason `wait_until_missing` |
| Recheck interval | Flat key `MailerConfig.flowWaitUntilRecheckHours`, default 24. Not finite or below 1 → throw at `Mailer.init` |
| Agent "force step" on a `wait_until` | Advance past it with a direct `advanceStep`, action `wait_completed` (section 4, Publish and API) |
| Agent simulate route | Accepts an optional `facts` override; live facts without it |
| Date source | Facts adapter only. Not the vars adapter, not trigger properties |
| A `wakeFlow` API | Not in this release |
| Fact predicates in flow `condition` / `branch` | Not in this release |

## 4. What was verified in the code (2026-11-11, `main` at `aab5bdc`, v0.21.0)

Re-check anything you depend on; line numbers drift.

**Runner**

- `src/server/runner/step.ts`: `processOneRunStep` dispatches on `step.type`
  (~76). A run whose `nextActionAt` is in the future is skipped at the top
  (~36); that guard is what lets a parked run stay parked.
- `handleWait` (~109) increments `currentStepIndex` when it parks. **Do not
  copy that.** `wait_until` must stay on its step.
- `deferSendForWindow` (~329) is the pattern to copy: same step, sets
  `nextActionAt`, pushes history, enqueues a delayed advance job whose `jobId`
  includes the wake instant, and filters the write so a second worker is a
  no-op.
- `advanceStep`, `exitFlowRun`, `failFlowRun` (~372 to 421) are the helpers to
  use. `branchKey(run)` must be part of any advance `jobId`.
- The contact and subscription gates run before the step switch on every entry,
  so a parked run that wakes for an unsubscribed contact exits by itself.
- `src/server/runner/sweep.ts`: each tick processes active runs with
  `nextActionAt <= now`. A step that throws is logged and retried next tick.
  That is the error path for a failing `factsAdapter.resolve`; add no retry
  machinery of your own.

**Facts**

- `FactsAdapter` is in `src/shared/types.ts` (~280): `declare`, `resolve(subjectId)`,
  `recipients`. Fact values are `string | number | boolean | Date | null`.
- The runner reaches it as `ctx.config.factsAdapter`
  (see `src/server/runner/programs/tick.ts` ~95). It is optional config.
- `toEpochMs` is exported from `src/server/runner/programs/predicate.ts` (~13)
  and already handles Date, ISO string and junk. Reuse it.
- Date facts are validated for programs in `src/server/programs/validate.ts`
  (~170 to 200). That is the issue shape to mirror.
- A memory facts adapter for tests exists: `src/testing/memory-facts-adapter.ts`.

**Types, schema, options**

- `FlowStep` union: `src/shared/types.ts` ~95.
- `flowStepSchema`: `src/shared/schemas.ts` ~242, a `z.discriminatedUnion('type', ...)`.
- `FLOW_STEP_KINDS` and `defaultFlowStep`: `src/shared/options.ts` ~26 and ~37.
  `defaultFlowStep` is an exhaustive switch, so the typechecker will point at it.
- History action union: `FlowRunHistoryEntry` in `src/server/models/index.ts` ~139.
- Config: `src/server/config.ts`. There is no `flows` group; every option is a
  flat key. `tickIntervalSeconds` is declared (~413), defaulted (~705) and
  resolved (~751) in three places; `flowWaitUntilRecheckHours` follows it.
  Init-time validation throws (see the `categories` and `contactPolicy`
  validators, ~536 and ~603); do the same for a bad recheck value.
- Test builders: `src/testing/builders.ts` has a `step` helper object (~163)
  with one function per step type. Add `step.waitUntil`.
- The `nextActionAt: { $lt: deliverAt }` filter in `deferSendForWindow` is safe
  to copy: at a wake the new park time is always later than the stored one,
  including after a force.

**Publish and API**

- Flow draft and publish live in `src/server/api/admin.ts` (~1172 to 1300).
  **Neither validates steps today.** `PATCH /flows/:slug/draft` stores the
  array as sent; `POST /flows/:slug/publish` copies the draft to a new version.
- `src/server/api/agent.ts`, `advanceOnce` (~1613): "force" sets `nextActionAt`
  to now and calls `processOneRunStep`. **That cannot move a run past a
  `wait_until`**: the step re-reads a date still in the future and parks again,
  and because the target is unchanged no history entry is added, so the call
  reports no progress. Add a dedicated branch: find the run's current step with
  `loadStepsForRun` + `locateStep`; if it is a `wait_until`, call `advanceStep`
  directly (action `wait_completed`, `details: { forcedBy, fact, scheduledFor }`)
  and loop. Do not reuse the existing forced-wait write: it logs
  `currentStepIndex - 1`, right for `wait` (which has already moved on) and
  wrong for `wait_until` (which has not).
- `POST /flows/:slug/simulate` in `agent.ts` (~590) passes no facts to the
  simulator. Add an optional `facts` body field (plain object, 400 otherwise),
  merged over live facts. Check for an admin simulate route and treat it the same.
- Only one other route creates flow versions: the agent's `gate`, which builds
  a canary from steps that are already published. It needs no `wait_until` check.
- `src/server/api/programs.ts` ~244 already returns the declared facts to the
  client (`facts: mailer.config.factsAdapter?.declare ?? null`). The flow editor
  needs the same list; reuse that source rather than adding a new one if you can.

**Simulator**

- `src/server/runner/simulate.ts`: virtual clock `t`, one `case` per step type,
  `SimulatedStep.outcome` union (~41). It has a private copy of `unitToMs`.

**Client**

- `src/client/screens/flow-detail.tsx`: step summary switch (~25 to 75) and
  `StepEditor` (~388) with one case per type. The wait editor (~390) is the
  smallest example.

**Find every other enumeration of step types** before you call it done:

```bash
grep -rn "fire_event" src docs --include="*.ts" --include="*.tsx" --include="*.md" -l
```

Any file that lists step kinds (agent route descriptions, reference docs, the
CLI, linters) needs the new one.

## 5. Traps

1. **Hosts write flows straight to Mongo.** Maxed seeds flows with a script
   (`plans/DIRECT_DB.md` documents the pattern), which bypasses publish
   validation entirely. The runner must therefore be safe on a bad step: no
   facts adapter configured, an undeclared fact, or a non-string `fact` /
   `subjectFrom` must end in `failFlowRun(run, 'wait_until_misconfigured: …')`,
   never a throw-and-retry loop and never a silent advance.
2. **Do not zod-parse whole step arrays at publish.** Nothing does today, and
   existing flows in production were never validated. Scope the new publish
   check to `wait_until` steps.
3. **History growth.** With a 24h recheck, a run parked for 90 days would push
   90 entries if every park logged. Push `wait_until_parked` only when the
   target differs from the last one recorded for that step.
4. **Job ids.** Include the wake instant in the delayed job's `jobId`, as
   `deferSendForWindow` does, or a re-park after a date change is deduped away
   and the run waits for the tick sweep instead.
5. **Test clock rule** (`test/README.md`): fake `Date` only,
   `vi.useFakeTimers({ toFake: ['Date'] })`, move time with `vi.setSystemTime`.
   Faking timers hangs the MongoDB driver.
6. **`drain` in `src/testing/drive.ts`** loops while runs are due (~97). A step
   that parks on itself with a future `nextActionAt` must not make it spin, and
   a step that parks with a past `nextActionAt` would. Check it with a test.
   For the same reason the "resolver throws" test cannot use `drain`: the run
   stays due, so `drain` runs all 100 rounds and returns `settled: false`. Call
   `processOneRunStep` directly and expect it to reject, then fix the adapter
   and `drain`.
7. **`subjectFrom` is a property name, not a template.** Read
   `run.triggerEvent?.properties?.[subjectFrom]` and require a non-empty
   string. Do not render it.
8. **Second worktree.** `../mailery-0.21` is a worktree on `release/0.21`.
   Leave it alone. Work in this directory.
9. **Untracked files.** `plans/15-programs.local.md` is Jeff's; do not commit,
   move or delete it. `plans/19-wait-until.md` and this file are meant to be
   committed with the feature.
10. **Yarn, Node 22** (`.nvmrc`). `yarn install --frozen-lockfile` in CI; do not
    introduce a `package-lock.json`.

## 6. Order of work

Branch `release/0.22` from `main`; the PRs below merge into it, and one final
PR takes it to `main`.

### Execution model

Same split as 0.21 ([`15a-work-breakdown.md`](./15a-work-breakdown.md)), scaled
down:

| Role | Who | What |
|---|---|---|
| Contract + tests | Fable | PR 1: steps 1 and the test files for steps 3 to 7, failing |
| Implementation | Sonnet | PR 2: steps 2, 4, 5, 6. PR 3: steps 7, 8 |
| Area review | Fable, on the integrated branch | Two passes: the runner's park and wake logic, and the agent force path |
| Close-out | Fable | Steps 9 and 10 |

Implementers may add tests. They may not delete or weaken one, and may not
change the contract; if it is wrong they stop and report.

### Steps

1. **Contract.** Types, schema, options, history actions, config key, the
   `step.waitUntil` test builder. Typecheck will list the exhaustive switches
   you have to extend.
2. **Runner.** `handleWaitUntil` in `step.ts`, including the misconfiguration
   path from trap 1.
3. **Runner tests** (the ten cases in `19-wait-until.md` section 4, plus
   misconfiguration). Put the step-type coverage in
   `test/matrix/flow-lifecycle.test.ts`, which already walks every step type
   under a frozen clock; put the multi-run and abort cases beside
   `test/integration/account-scoped-runs.test.ts` and `flow-abort.test.ts`.
4. **Publish validation** in `admin.ts`, with tests for: no adapter, undeclared
   fact, non-date fact, valid step. Check whether the agent API has its own
   publish route that needs the same call.
5. **Simulator** + the `facts` override on the simulate route, with tests
   (`test/board/simulate.test.ts` is the nearest example).
6. **Agent force path** + tests: a forced run moves past a `wait_until` whose
   date is in the future, the history entry carries the step's own index, and
   the step after it is processed.
7. **Client.** Summary line, editor, run-history rendering. Check
   `test/client` and `test/e2e/flows.spec.ts` for the existing level of
   coverage and match it.
8. **Docs.** `docs/guide/flows.md` (step table + a section on waiting for a
   host date, with the recheck rule and the misconfiguration behaviour),
   `docs/reference/types-flow.md`, `plans/DIRECT_DB.md` if it lists step
   shapes, the agent API reference if it lists step kinds.
9. **Plans.** New invariant in `plans/INVARIANTS.md` (a `wait_until` reads its
   date at every wake; `nextActionAt` is a wake time, never the deadline of
   record). Rows for 19 and 19a in `plans/README.md`.
10. **Changelog and version.** `CHANGELOG.md` entry `## 0.22.0`, following the
    0.21.0 layout (Added, and "Changed — new statuses" for the new history
    actions and exit reasons). `package.json` to `0.22.0`.

Commit in reviewable steps. Run `yarn typecheck && yarn test` before each
commit that touches `src`.

## 7. Acceptance checks before asking to release

```bash
yarn typecheck
```

```bash
yarn test
```

```bash
yarn build
```

```bash
yarn docs:build
```

Then, by hand or by test, confirm these end to end against a real
`mongodb-memory-server` run with the memory facts adapter:

- A flow `send → wait_until(end, -3) → send → wait_until(end) → fire_event`
  with `end` 10 days out sends the second email at day 7 and fires the event
  at day 10.
- Moving `end` to day 30 while the run is parked at the first wait moves the
  second email to day 27 with no host call other than the fact changing.
- Moving `end` to day 30 after the second email has gone out delays only the
  event.
- A run whose subject has no date exits with `wait_until_missing`.
- `abortFlow` with `matchTriggerProperties` on a parked run stops it.

Report the test count and the output of the four commands.

## 8. Release procedure

Verified from `.github/workflows`:

- `ci.yml`: on pull requests and pushes to `main`, runs install, typecheck,
  test, build.
- `release.yml`: on a pushed tag matching `v*` (or manual dispatch), runs the
  same checks and then `npm publish --provenance --access public` through npm
  trusted publishing (OIDC). No token is needed locally.
- `docs.yml`: deploys the docs site.
- The previous release went in as a pull request titled `Release 0.21.0`.

Steps:

1. After both area reviews pass, open the pull request `release/0.22` → `main`.
   Wait for CI.
2. **Stop. Tell Jeff the PR is green and ask for the go-ahead to merge and
   release.** Merging, tagging and publishing are his call; a published npm
   version cannot be taken back.
3. On his yes: merge, then tag the merge commit `v0.22.0` and push the tag.
4. Watch the Release workflow to completion and confirm the version on npm:

```bash
npm view mailery version
```

5. Report the published version and the PR link.

Do not publish from a laptop with `npm publish`. Do not bump past `0.22.0`.

## 9. How the host will use it (context only, not your work)

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

- Maxed fires `Trial Started` per account owner with `{ accountId, … }` in the
  event properties, so `subjectFrom: 'accountId'` resolves.
- Its facts adapter already declares `trial_ends_at` as a date and resolves by
  account id.
- Maxed seeds flows by direct Mongo write and aborts them with
  `mailer.abortFlow(slug, externalId, { matchTriggerProperties: { accountId } })`.
- It will upgrade by bumping the `mailery` dependency once 0.22.0 is on npm.
  That upgrade, the new flow seed and the trial-extension feature are a
  separate task in the Maxed repo.

If something in this usage cannot be expressed cleanly with the step as
specified, say so before building around it.

## 10. Out of scope

- Any change in the Maxed Marketing repo.
- Changes to `wait`, to Programs, or to the contact policy.
- `wakeFlow`, fact predicates in flows, variable units for the offset.
- Refactors of the flow publish path beyond the `wait_until` check.

## 11. What to report back

- Branch and PR link.
- Files changed, grouped as in section 6.
- Test count before and after, and the four command outputs from section 7.
- Any place the code differed from section 4, and what you did about it.
- Anything in the spec you changed, and why.
