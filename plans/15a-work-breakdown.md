# 15a — Work breakdown for release 0.21

Executes [`15-programs.md`](./15-programs.md). Locked 2026-10-07.

## Execution model

Front-load design into one contract PR. Sonnet executes four PRs against it. Review
happens in three area passes on the integrated branch, not per PR. The tests written
in PR 1 are the per-PR reviewer.

| Role | Who | Where |
|---|---|---|
| Contract + tests | Fable | PR 1 |
| Implementation | Sonnet, one agent per PR, worktree-isolated | PRs 2–5 |
| Per-PR gate | Sonnet reviewer, one pass, checklist below | PRs 2–5 |
| Untested-surface audit | Sonnet, before PR 2 starts | PR 1 |
| Area review | Fable, three passes | integrated `release/0.21` |

Branching: `release/0.21` off `main`. PRs 1–5 merge into it in order. One final PR
`release/0.21 → main` after the three area reviews pass.

Not per-PR Fable review. The cost is wrong and the contract makes it unnecessary.

## Per-task fields

Every task below is written so a Sonnet agent can run it unattended:

- **Files** — what it may touch. Anything else is scope creep; stop and report.
- **Contract** — the types/schemas from PR 1 it implements. It may not change them.
  If the contract is wrong, stop and report; do not patch around it.
- **Tests to make green** — named test files from PR 1. Adding tests is encouraged;
  deleting or weakening one is forbidden.
- **Invariants** — from `INVARIANTS.md`. Must still pass.
- **Non-goals** — what this task does not do even if it looks adjacent.

---

## PR 1 — Contract and tests (Fable)

Goal: every interface, schema, collection shape and test that PRs 2–5 code against.
No implementation beyond stubs that type-check.

### 1.1 Types and schemas
- **Files**: `src/shared/types.ts`, `src/shared/schemas.ts`, `src/shared/enums.ts`,
  `src/server/models/index.ts` (collection declarations + indexes only).
- **Adds**: `CategoryDef`, `Template.category`, category suppression scope,
  `ContactPolicy`, `FactsAdapter`, `FactDecl`, `Program`, `Action`, `Attempt`,
  `ProgramRunDoc`, `ProgramDecisionDoc`, `SendDoc.program`, `fact` predicate leaf,
  `MailerConfig.{categories,contactPolicy,factsAdapter,programs}`.
- **Zod**: program publish validation (declared categories, declared facts, acyclic
  `requires`, unique action ids, ≥1 attempt, exactly one delivery per attempt).

### 1.2 Test suite (red until implemented)
- `test/categories/blocking-matrix.test.ts` — every (kind, category, scope) cell.
- `test/categories/token.test.ts` — old token → marketing; new token → category;
  expiry; tamper.
- `test/categories/preferences.test.ts` — page writes journaled; one-click durable
  before 200 (extends existing INVARIANT 8 tests); opt-in deletes row; transactional
  never listed.
- `test/policy/rolling-window.test.ts` — vectors for gap, N-per-days, tz chain
  (contact → account → UTC), quiet hours across midnight and DST, defer vs drop at
  `maxHours`, source priority contention, transactional bypass.
- `test/programs/tick.test.ts` — every `blockedBy` branch; `hold` vs `skip`;
  exhausted prerequisite blocks dependents; cooldown reopens ladder; completion
  monotonic under fact regression; silent tick writes decision; completed run fires
  `onComplete` once.
- `test/programs/attempts.test.ts` — attempt unchanged under policy deferral,
  session suppression, sunset, holdout; increments on accepted send only.
- `test/programs/dispatch-reverify.test.ts` — satisfied-before-send cancels; deferred
  send re-verifies.
- `test/programs/lease.test.ts` — two concurrent ticks, one send.
- `test/programs/schedule.test.ts` — `nextTickAt` from gap + delivery window;
  fact-change wakes early but not inside `minGapDays`.
- `test/programs/holdout.test.ts` — deterministic arm; holdout row written, no
  provider call; stats split by arm.
- `test/programs/sunset.test.ts` — stage transitions; engagement resets; open never
  counts.
- `test/upgrade/zero-config.test.ts` — snapshot of existing e2e outputs with none of
  the new config set; must be byte-identical.
- `test/programs/publish-validation.test.ts` — every zod rejection in 1.1.

### 1.3 Fixtures
- `src/testing/builders.ts`: `buildProgram()`, `buildAction()`, `buildFacts()`,
  `MemoryFactsAdapter`.
- `src/testing/drive.ts`: `tickProgram(slug, subjectId, { now })`, `advanceTo(date)`.

### 1.4 Untested-surface audit (Sonnet, after 1.1–1.3, before PR 2)
Read `15-programs.md` end to end against `test/`. Produce a list of spec statements
with no test. Fable adds the missing ones. PR 1 merges only after this list is empty
or each omission is justified in the PR description.

---

## PR 2 — Categories and preference page (Sonnet)

- **Files**: `src/server/unsubscribe.ts`, `src/server/tokens.ts`,
  `src/server/unsub-journal.ts`, `src/server/api/public/*unsub*`, new
  `src/server/api/public/preferences.ts`, `src/server/templates/` (header emit),
  `src/server/mailer.ts` (new public methods), `src/client/screens/templates/*`,
  `src/client/screens/contacts/*`, new `src/client/screens/categories/*`,
  `docs/guide/suppression.md`, `docs/reference/public-endpoints.md`.
- **Contract**: 1.1 category types, scope enum, token payload, `MailerConfig.categories`.
- **Tests**: `test/categories/*`, existing suppression + INVARIANT 8 suites.
- **Invariants**: 4, 8, 22.
- **Scope**: `Template.category` persist + publish validation; suppression check uses
  blocking rule; token carries category; GET `/unsub/:token` → preference page; POST
  one-click scoped; `mailer.unsubscribe/resubscribe/getPreferences`; `List-ID`
  header; admin category column/filter; contact page preference state; categories
  list page.
- **Non-goals**: no contact policy; no change to circuit breaker; no DOI changes; no
  new email kinds.

## PR 3 — Contact policy and dispatch re-verify (Sonnet)

- **Files**: new `src/server/runner/contact-policy.ts`, `src/server/runner/dispatch*.ts`
  (insert stage + re-verify hook), `src/server/queues/*` (deferred re-dispatch job),
  `src/client/screens/sends/*` (deferred status + reason), `docs/guide/` new
  `contact-policy.md`.
- **Contract**: `ContactPolicy`, `SendDoc.status: 'deferred'`, `notBefore`,
  `exitReason: 'policy_expired' | 'satisfied_before_send'`, re-verify hook signature
  `(send) => Promise<'send' | 'cancel'>` registered per source.
- **Tests**: `test/policy/*`, `test/programs/dispatch-reverify.test.ts` (hook half),
  `test/upgrade/zero-config.test.ts`.
- **Invariants**: 3, 6, 19.
- **Scope**: stage after suppression, before provider; rolling windows; tz chain;
  defer with delayed job; drop at `maxHours`; source priority; transactional bypass
  and ledger write; unset config → no-op; re-verify hook runs on every dispatch
  including re-dispatch, with Flow guard registered for flows.
- **Non-goals**: no Program logic; no per-category caps; no digest/batching.

## PR 4 — Programs engine (Sonnet)

- **Files**: new `src/server/runner/programs/{tick,scheduler,lease,sunset,holdout,facts,exit}.ts`,
  `src/server/mailer.ts` (`abortProgram`, `getProgramState`, `fire('Facts Changed')`
  handling), `src/server/events.ts` (subject-scoped events), `src/server/templates/`
  (program vars), `docs/guide/programs.md`, `docs/guide/events.md`.
- **Contract**: `Program*` types, `ProgramRunDoc`, `ProgramDecisionDoc`,
  `SendDoc.program`, `FactsAdapter`, `fact` predicate.
- **Tests**: `test/programs/*` except publish-validation, `test/upgrade/zero-config.test.ts`.
- **Invariants**: 1, 15, 18, 19, 20, 21, 23.
- **Scope**: §5.4 tick verbatim; lease; `nextTickAt`; fact-change wakeup; sunset;
  holdout; completion + `onComplete` dedupe; `abortProgram`; program versioning via
  `mailer_program_versions`; template vars; `varsAdapter` info; entry from
  `entry.eventName` with `subjectType: 'account'`.
- **Non-goals**: no admin routes/UI (PR 5); no ranker other than priority; no
  exploration; no channels other than email; no variant config.

## PR 5 — Surface: admin, CLI, docs, host adapter (Sonnet)

- **Files**: `src/server/api/admin/programs.ts`, `src/server/api/agent/programs.ts`,
  `src/client/screens/programs/*`, `src/cli/doctor.ts`,
  `src/server/scripts/backfill-categories.ts`, `docs/reference/admin-api.md`,
  `docs/reference/agent-api.md`, `docs/guide/admin-ui.md`, `CHANGELOG.md`,
  `README.md`. In maxed: `src/server/services/mailerFacts.ts`,
  `src/server/services/mailerActivationProgram.ts`,
  `src/server/scripts/mailer-seed-activation-program.ts`.
- **Contract**: §5.13, §5.14, §11 of the spec; `getProgramState` from PR 4.
- **Tests**: admin API route tests (new, Sonnet writes them against §5.14), playwright
  for preference page + program editor + run view, `doctor` unit tests, maxed facts
  adapter unit test against seeded `ClientAccount`/`ConnectedAccount`.
- **Invariants**: 10 (audit on every mutating route).
- **Scope**: programs list/detail/run view/decision timeline/per-action funnel by
  arm; JSON editor + draft/publish; agent API routes; `doctor` per §11; backfill
  script; CHANGELOG 0.21 with "check before upgrading" + per-host checklist; maxed
  facts adapter (connected = first import landed), playbook-action generator from
  `PLAYBOOK_PLATFORMS`, seeded program disabled.
- **Non-goals**: no new engine behaviour; no maxed UI checklist (host follow-up); do
  not enable the program in maxed.

---

## Sonnet per-PR review checklist

One reviewer agent per PR, one pass, output a list or "clean":

1. Files touched outside the task's **Files** list.
2. Any test deleted, skipped, or loosened.
3. Any change to a type or schema from PR 1.
4. Spec section the PR claims to implement vs what the diff does; name gaps.
5. New code path with no test.
6. `console.log`, TODO, commented-out code, hard-coded ids.
7. Docs updated for every new public method, route, config key.

Reviewer does not re-derive design. If the spec seems wrong, say so in one line and
stop; do not propose a fix.

---

## Fable area reviews (on integrated `release/0.21`)

### R1 — Compliance surface
Token round-trip old and new; blocking rule at the suppression check call site, not
only in tests; preference writes journaled; one-click durable before 200 including
timeout path; `List-Unsubscribe` and `List-ID` emission; GDPR forget still blocks by
hash across category scopes. Invariants 4, 8, 9, 22.

### R2 — Engine semantics
Walk §5.4 against the code line by line. Lease under worker crash (stale lease
expiry). Attempt accounting on every suppression path including provider rejection.
Re-verify after deferral uses fresh facts, not the tick snapshot. Monotonic
`completedAt`. `hold` stops lower priority but not the decision log. `onComplete`
fires once under concurrent ticks. Holdout never calls provider. Sunset never reads
opens. Invariants 1, 15, 18–21, 23.

### R3 — Upgrade safety and host fit
`zero-config` snapshot genuinely covers flows, broadcasts, webhooks, unsub. `doctor`
reports what §11 promises and exits non-zero correctly. Maxed adapter: every declared
fact resolves; "connected" means first import landed; recipients rule resolves owners
only; `Facts Changed` fired from the right handlers; `abortProgram` on cancel. Then
run the maxed real-stack harness scenario from §10.

Each review produces a findings list. Fixes go as Sonnet PRs into `release/0.21`,
re-reviewed by the same Fable pass only for the findings it raised.

---

## Order and parallelism

```
PR1 (Fable) ──► 1.4 audit (Sonnet) ──► PR2 ─┐
                                      PR3 ─┼─► PR4 ──► PR5 ──► R1 R2 R3 ──► main
                                            │        (PR5 maxed half can start with PR4)
PR2 and PR3 run in parallel in separate worktrees.
```

## Definition of done for the release
- All PR 1 tests green on `release/0.21`.
- R1–R3 findings closed.
- `doctor` clean on all three hosts with 0.21 installed and no new config.
- Maxed real-stack scenario passes.
- CHANGELOG 0.21 published; `sources.yaml` status updated.
