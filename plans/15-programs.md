# 15 — Programs, categories, and contact policy (release 0.21)

Status: spec, approved direction 2026-10-07. One release. Three parts that ship together
because Programs depend on the other two:

- **A. Categories + preference page** — marketing email gains a category; unsubscribe
  means "stop this category"; the unsubscribe page becomes a preference page.
- **B. Contact policy** — one gatekeeper in front of every send (Flows, broadcasts,
  Programs) so nothing emails the same person twice in a morning.
- **C. Programs** — a next-best-action engine: on a schedule, read account state, pick
  the single most valuable thing the account hasn't done, email about it, track
  attempts with escalating copy, move on when done or exhausted.

Research behind the decisions: `plans/design/research/00-synthesis.md` (own judgment)
and `01`–`04` (vendor research, partially verified). Decisions already taken are in §13.

Audience reality: three host apps, all ours. The release is additive (§11) and ships
with a `doctor` command rather than a migration guide.

---

## 1. Why Flows are the wrong tool

A Flow is a *sequence*: event → wait → send → wait → send. It answers "what happens
after X". Activation needs a *policy*: "given everything we know about this account
right now, what is the one most valuable thing to ask for?" Modelling that as a flow
means a branch tree that grows with every new integration and every new playbook, and
every send step needs its own guard. The trial flows already hit this (FLOW_ABORT.md).

Research confirmed no mainstream journey tool has a "pick the single best eligible
message" primitive; the systems that do (Pega, Adobe decisioning, Duolingo's
notification bandit) all run one pipeline:

```
candidates → filter → rank → pick one → log decision + outcome → silence on empty
```

Programs are that pipeline with a static-priority ranker. Flows stay for event-driven
timelines. Programs are for "what next, given state".

---

## 2. Concepts

| Term | Meaning |
|---|---|
| **Fact** | One piece of account state, supplied by the host (`shopify_connected: true`, `business_type: 'ecommerce'`, `playbooks_run: 2`). Never derived from mailer sends. |
| **Action** | One recommendable thing ("connect Shopify"). Has `eligible`, `satisfied`, `requires`, ordered `attempts`, priority. Also the unit the in-app checklist renders. |
| **Attempt** | One intent to nudge toward an action, with its own copy. Attempt 1 asks, 2 reminds, 3 is last call. One attempt may have several deliveries (channels) later; v1 is email only. |
| **Program** | Ordered action list + policy + entry/exit. One per journey (`activation`). |
| **Subject** | The thing a Program is *about*. v1: the account. Facts and the ledger are keyed by subject. |
| **Recipient** | The contact(s) who get the email, resolved from the subject at send time. |
| **Run** | Per (program, subject) state: per-action status, attempts, sunset stage, next tick. |
| **Decision** | Per-tick record of every candidate considered, why each was or wasn't chosen, and the outcome. |
| **Category** | A named stream of marketing email a recipient can opt out of independently (`lifecycle.onboarding`, `product.updates`). |
| **Contact policy** | Cross-system send rules: gaps, caps, quiet hours, priority between sources. |

---

## 3. Part A — Categories and the preference page

### 3.1 Today
Two legal kinds: `transactional` (user-caused; always deliverable) and `marketing`
(needs an unsubscribe link). Suppression `scope` is `all | marketing | transactional`.
The unsubscribe link removes the recipient from all marketing. There is no way to stop
one stream and keep another.

### 3.2 Change
- `Template.category?: string`. Dotted slug. Only meaningful on `kind: 'marketing'`;
  rejected on transactional at publish.
- `MailerConfig.categories`: declared list with labels and descriptions for the
  preference page. Undeclared category on a template fails publish.

  ```ts
  categories: [
    { id: 'lifecycle.onboarding', label: 'Getting-started tips', description: '…', defaultOptIn: true },
    { id: 'product.updates',      label: 'Product updates' },
    { id: 'insights.weekly',      label: 'Weekly insights' },
  ]
  ```
- Suppression rows gain category scopes: `scope: 'category:lifecycle.onboarding'`.
  Existing values unchanged.
- **Blocking rule** (replaces INVARIANT 4's table, extends it):

  | Template | Blocked by scope |
  |---|---|
  | `transactional` | `all`, `transactional` |
  | `marketing`, no category | `all`, `marketing` |
  | `marketing`, category C | `all`, `marketing`, `category:C` |

  Every existing suppression row blocks exactly what it blocks today.
- **Unsubscribe token** carries the template's category when present. Old tokens (no
  category) verify and mean `marketing`, as today, until they expire.
- **One-click POST** (RFC 8058) unsubscribes the token's scope durably before 200.
  INVARIANT 8 unchanged. For a categorised email that scope is the category: the
  Gmail button means "stop these", which is what the recipient meant.
- **GET /unsub/:token** renders the **preference page**: one checkbox per declared
  category showing current state, a separate "Unsubscribe from all marketing email"
  button, and no mention of transactional. Saves write `mailer_suppressions` rows
  (opt-out) or delete them (opt-in) with `source: 'preferences'`, journaled like
  one-click. Token lifetime applies; expired tokens show a re-request form (already
  planned as V2 in public-endpoints).
- **Public API**: `mailer.unsubscribe(email, { scope: 'category:x' })`,
  `mailer.resubscribe(email, { scope })`, `mailer.getPreferences(email)` →
  `{ categories: { [id]: boolean }, marketing: boolean }`.
- **Admin**: category column + filter on templates; preference state on the contact
  page; categories list page (read-only; source of truth is config).
- **Headers**: `List-Unsubscribe` unchanged. Add `List-ID: <category>.<domain>` on
  categorised mail so clients can group.

### 3.3 Not changing
Transactional mail remains outside preferences. `scope: 'all'` still blocks
everything. The circuit breaker (INVARIANT 6) still keys on kind, not category.

---

## 4. Part B — Contact policy

### 4.1 Problem
Flows, broadcasts and Programs each decide to send independently. Nothing prevents
three marketing emails to one person before lunch. Caps per system don't fix it.

### 4.2 Design
One stage in the dispatch pipeline, after suppression and before provider call, that
reads `mailer_sends` for the recipient and decides **send / defer / drop**.

```ts
contactPolicy: {
  marketing: {
    minGapHours: 20,                // between any two marketing sends to one recipient
    maxPerRollingDays: { days: 7, count: 3 },
    quietHours: { start: '21:00', end: '08:00' },   // recipient tz → account tz → UTC
    deferral: { maxHours: 72 },     // past this, drop (with reason) instead of sending stale
  },
  sourcePriority: ['transactional', 'flow', 'broadcast', 'program'],
}
```

- Rolling windows, not calendar days (calendar days allow two sends two hours apart).
- Transactional bypasses caps and quiet hours, but is still written to `mailer_sends`
  and counts toward *nothing* (it is not marketing).
- **Defer, don't drop.** A send blocked by policy gets `status: 'deferred'`,
  `notBefore`, and a delayed re-dispatch. On re-dispatch, suppression, subscription,
  **and the originating system's own guard** run again (§5.6 for Programs; flow
  condition for Flows). Past `deferral.maxHours` the send is dropped with
  `exitReason: 'policy_expired'`.
- When two sources contend for the same slot, lower `sourcePriority` defers.
- Default: `contactPolicy` unset → stage is a no-op. Existing behaviour exactly.
- Admin: "deferred" status visible on sends list and contact page with the reason.

### 4.3 Interaction with Programs
A deferred or dropped Program send does **not** consume an attempt (§5.5). The Program
decision records `reason: 'policy-silence'` and the run's `nextTickAt` moves to the
deferral time.

---

## 5. Part C — Programs

### 5.1 Definition

```ts
interface Program {
  slug: string
  name: string
  version: number                       // draft/publish + versions, like flows
  enabled: boolean
  category: string                      // must be a declared category
  subject: 'account'                    // v1 only value; field exists for 'contact' later
  recipients: 'owners' | 'admins' | 'all_members' | { adapter: string }
  entry: { eventName: string }          // e.g. 'Created' (account-scoped event)
  exit: {
    eventNames?: string[]               // 'Upgraded', 'Cancelled' → abort run
    onComplete?: { fireEvent: string }  // fired once when no action remains
  }
  policy: {
    minGapDays: number                  // between two Program sends to this subject
    delivery?: DeliveryWindow           // weekdaysOnly, timeOfDay, tz — reused from flows
    suppressIfSessionWithinHours?: number   // they're in the app; checklist is enough
    sunset?: { slowAfter: number; slowFactor: number; askAfter: number; askTemplateSlug: string }
  }
  holdoutPct?: number                   // 0–100, deterministic by subject id
  actions: Action[]
  draft?: { … }                         // same shape as flows
}

interface Action {
  id: string                            // stable, never reused
  version: number                       // bump when eligible/satisfied/copy semantics change
  title: string                         // checklist label
  cta?: { label: string; url: string }  // checklist + template var
  priority: number                      // higher wins
  group?: string; tags?: string[]; value?: number   // reserved ranker inputs, unused in v1
  eligible?: Predicate                  // relevant now? default: always
  satisfied: Predicate                  // done? state, not event
  requires?: string[]                   // action ids; DAG, validated acyclic at publish
  attempts: Attempt[]
  onExhaust: 'skip' | 'hold'            // hold = nothing lower-priority may send
  cooldownDays?: number                 // after exhaust, before fresh ladder
}

interface Attempt {
  deliveries: Array<{ channel: 'email'; templateSlug: string }>   // exactly one in v1
  minGapDays?: number                   // overrides program minGap for this attempt
}
```

Predicates gain one leaf: `{ fact: string; equals?: unknown; gte?: number; lte?: number; in?: unknown[]; exists?: boolean }`.
Existing predicates (`hasFiredEvent`, `hasTag`, …) remain usable in `eligible`.

### 5.2 Facts adapter (host code)

```ts
factsAdapter: {
  declare: {
    shopify_connected:  { type: 'boolean' },
    ga4_connected:      { type: 'boolean' },
    business_type:      { type: 'enum', values: ['ecommerce', 'saas', 'local', 'agency'] },
    business_context_complete: { type: 'boolean' },
    agent_connected:    { type: 'boolean' },
    playbooks_run:      { type: 'number' },
    last_session_at:    { type: 'date' },
  },
  resolve: async (subjectId) => ({ shopify_connected: …, … }),
  recipients: async (subjectId, rule) => Contact[],   // owners/admins/all_members
}
```

- `declare` powers admin typeahead and publish-time validation of `fact` predicates.
- `resolve` runs once per tick. The snapshot (or its hash + stored copy when small) is
  written on the decision row.
- Facts are **host state only**. A fact must not be computed from `mailer_*`
  collections. This is INVARIANT 20.
- Maxed note: for connection actions, `satisfied` should probably be "first data
  landed", not "account id present" — Windsor sync lag otherwise makes "connect
  Shopify" satisfied while the user still sees an empty dashboard. Decide in the
  adapter, not the engine.

### 5.3 Collections

**`mailer_programs`**, **`mailer_program_versions`** — as flows.

**`mailer_program_runs`** — one per (program, subject):

```ts
{
  programSlug, programVersion, subjectId,
  status: 'active' | 'dormant' | 'completed' | 'exited' | 'sunset',
  arm: 'treatment' | 'holdout',
  actions: {
    [actionId]: {
      status: 'pending' | 'satisfied' | 'exhausted' | 'cooldown' | 'blocked',
      attempts: number, lastSentAt?, completedAt?,         // completedAt is monotonic
      exhaustedAt?, cooldownUntil?,
    }
  },
  unansweredAttempts: number, lastEngagementAt?, sunsetStage: 0 | 1 | 2,
  nextTickAt: Date, lease?: { until: Date; worker: string },
  enteredAt, exitedAt?, exitReason?,
}
// indexes: {programSlug, subjectId} unique; {nextTickAt} partial status active
```

**`mailer_program_decisions`** — one per tick, including silent ticks:

```ts
{
  runId, programSlug, subjectId, at,
  factsHash, facts?,                          // inline when < 4 KB, else hash only
  candidates: [{
    actionId, actionVersion, priority,
    eligible: boolean, satisfied: boolean,
    blockedBy: null | 'satisfied' | 'ineligible' | `requires:${id}` | 'exhausted' | 'cooldown' | 'hold' | 'policy',
    rank?: number,
  }],
  chosen: actionId | null, attempt?: number,
  reason: 'highest-rank' | 'none-eligible' | 'policy-silence' | 'session-suppressed' | 'sunset' | 'holdout',
  ranker: { name: 'priority', version: 1 },
  selectionProb: 1, explore: false,           // reserved; constant in v1
  sendId?: ObjectId,
}
// indexes: {runId, at: -1}; {programSlug, at: -1}; TTL optional per host (default none)
```

**`mailer_sends.program`** subdocument (no new collection for interactions):

```ts
program?: { slug, subjectId, actionId, actionVersion, attempt, variantId: 'default',
            decisionId, templateVersion, holdout: boolean }
```

Holdout "would-have-sent" rows are written to `mailer_sends` with `status: 'holdout'`
and no provider call, so the control denominator exists.

### 5.4 Tick

Triggered by `nextTickAt` (scheduler scan, like flow waits) **or** by a host-fired
fact-change event (`mailer.fire('Facts Changed', subjectId)` → immediate tick, bounded
by `minGapDays`).

```
1. lease run (findOneAndUpdate; skip if leased)            — no double ticks
2. facts = resolve(subjectId); write snapshot
3. exit check: exit.eventNames fired since enteredAt → exit run
4. engagement: last_session_at / click / fact progress → reset unansweredAttempts
5. sunset: apply stage (slow cadence / ask / suppress)
6. session rule: last_session_at within suppressIfSessionWithinHours → reason session-suppressed
7. for each action in priority order:
     satisfied(facts)            → mark satisfied (completedAt once), blockedBy satisfied
     requires any not satisfied  → blockedBy requires:<id>   (exhausted prereq still blocks)
     !eligible(facts)            → blockedBy ineligible
     cooldownUntil > now         → blockedBy cooldown
     attempts >= attempts.length → mark exhausted; onExhaust=hold → stop loop, blockedBy hold for rest
     else candidate
8. chosen = first candidate; none → reason none-eligible
     all actions satisfied/exhausted(skip) → status completed; fire exit.onComplete; stop
9. arm = holdout → write holdout send row, reason holdout, no provider; else enqueue send
10. send passes suppression → contact policy → provider. Attempt counter increments
    ONLY when the send is accepted (status queued/sent). Deferred/dropped → unchanged.
11. nextTickAt = max(lastAcceptedSendAt + minGapDays, next delivery window slot)
12. release lease; write decision row
```

### 5.5 Attempt accounting
`attempts` increments on acceptance, never on evaluation. A tick that is suppressed by
contact policy, quiet hours, session rule, sunset or holdout leaves action state
unchanged. INVARIANT 18.

### 5.6 Re-verify at dispatch
Every Program send, including deferred ones, re-runs `satisfied` and `eligible` against
fresh facts immediately before the provider call. Satisfied → cancel send, mark action
satisfied, `exitReason: 'satisfied_before_send'`. Reuses the dispatch-time guard built
for FLOW_ABORT. INVARIANT 19.

### 5.7 Monotonic completion
`completedAt` is set once. A later fact regression does not clear it; the action stays
satisfied and the checklist stays ticked. A regression that warrants a nudge is a
separate action (`reconnect-shopify`) with its own copy and `eligible: { fact:
'shopify_was_connected' }`-style facts. INVARIANT 21.

### 5.8 Sunset
`unansweredAttempts` counts accepted sends since `lastEngagementAt` (session, human
click, or any action newly satisfied). Stage 0: normal. Stage 1 (`slowAfter`
reached): `minGapDays *= slowFactor`. Stage 2 (`askAfter`): send `askTemplateSlug`
once ("still want these?"), then `status: 'sunset'`; resume on next engagement event
or preference opt-in. Open rate is never an engagement signal.

### 5.9 Holdout
`hash(programSlug, subjectId) % 100 < holdoutPct` → `arm: 'holdout'`, fixed for the
run's life. Decisions are made and logged identically; sends are recorded as
`status: 'holdout'` without a provider call. Admin shows conversion per action for
treatment vs holdout. No exploration/randomised ranking in v1; `selectionProb` and
`explore` exist so a later ranker needs no migration.

### 5.10 Exit and chaining
- `exit.eventNames` → `mailer.abortProgram(slug, subjectId, { reason })` semantics,
  same as `abortFlow`: immediate, cancels queued sends, no-op if inactive.
- Completion fires `exit.onComplete.fireEvent` once (dedupe key
  `program:${slug}:${subjectId}:complete`), so a following Program or Flow can enter.
- No fallback action. "Nothing eligible" is success or silence, never a generic email.

### 5.11 Checklist read API
`GET /api/programs/:slug/state?subject=<id>` (admin router) and
`mailer.getProgramState(slug, subjectId)` (public API) return
`[{ actionId, title, cta, status, isNext, attempts }]` computed from the current run,
so the host's in-app checklist renders from the same definition the emails use.
Completion is read from `completedAt`, never recomputed from facts, so UI and email
agree.

### 5.12 Template vars
Program sends expose `{{program.slug}}`, `{{action.id}}`, `{{action.title}}`,
`{{action.cta.url}}`, `{{attempt.n}}`, `{{attempt.total}}`, `{{attempt.isLast}}`,
`{{attempt.daysSinceFirst}}`, `{{facts.*}}`. `varsAdapter.resolve` receives
`info.program` and `info.subjectId`.

### 5.13 Admin UI
Programs list / detail (actions as a table with priority, eligible/satisfied summary,
attempt count). Run view per subject: action grid, decision timeline ("why did / didn't
this send"), sunset stage, arm. Per-action funnel: evaluated → eligible → sent →
satisfied, treatment vs holdout. JSON editor + draft/publish like flows.

### 5.14 Agent/admin API
`GET/POST/PATCH /programs`, `/programs/:slug/publish`, `/programs/:slug/runs`,
`/programs/:slug/runs/:subjectId` (run + decisions), `/programs/:slug/stats`,
`POST /programs/:slug/runs/:subjectId/tick` (force), `/abort`.

---

## 6. Host integration (maxed sketch)

```ts
factsAdapter.resolve = async (accountId) => {
  const acct = await ClientAccount.findById(accountId)
  const conns = await ConnectedAccount.find({ accountId })
  return {
    shopify_connected: conns.some(c => c.platform === 'shopify' && c.firstImportAt),
    ga4_connected:     conns.some(c => c.platform === 'googleanalytics4' && c.firstImportAt),
    business_type:     acct.businessType ?? null,
    business_context_complete: (await getOnboardingStatus(accountId))?.businessSetupCompleted ?? false,
    agent_connected:   !!acct.mcpConnectedAt,
    playbooks_run:     await PlaybookRun.countDocuments({ accountId }),
    last_session_at:   acct.lastSeenAt ?? null,
  }
}
```

Entry: `fireTrialStarted`-style helper fires `Created` with `subjectId = accountId`.
Fact changes: `mailer.fire('Facts Changed', accountId)` from the connection-complete
and business-setup handlers. Exit: `syncFromStripeSubscription` already calls
`abortTrialFlows`; add `abortProgram('activation', …)` on cancel/delete.

Playbook actions can be generated from `PLAYBOOK_PLATFORMS`: one action per playbook,
`eligible` = its required platform facts true, `satisfied` = run count for that
playbook ≥ 1, `requires: ['agent-connected']`.

---

## 7. Configuration additions

```ts
categories?: CategoryDef[]
contactPolicy?: ContactPolicy
factsAdapter?: FactsAdapter
programs?: { tickIntervalMs?: number; leaseMs?: number; decisionRetentionDays?: number | null }
```

All optional. Absent → behaviour identical to 0.20.

---

## 8. Events
Program subjects are accounts, but `mailer_events` are keyed by `externalId`
(contact). Program entry/exit/fact-change events use `externalId = subjectId` with
`properties.subjectType: 'account'`. Flows ignore them unless a flow trigger names
them. Document this in events.md.

---

## 9. New invariants (appended to INVARIANTS.md)
18. A Program attempt is consumed only by an accepted send.
19. Program sends re-verify `satisfied`/`eligible` at dispatch, after any deferral.
20. Facts are host state; never derived from `mailer_*` collections.
21. Action completion is monotonic.
22. Category unsubscribe never blocks transactional mail or another category.
23. Every Program tick writes a decision row, including silent ticks.

---

## 10. Testing

Unit (vitest, memory adapter, recording provider):
- Blocking matrix for every (kind, category, scope) combination — INVARIANT 22.
- Token round-trip: old token → marketing scope; new token → category.
- Preference page writes journaled; one-click POST durable before 200 (extend existing
  INVARIANT 8 tests).
- Contact policy: rolling window maths, tz fallback chain, defer vs drop at
  `maxHours`, source priority contention, transactional bypass.
- Tick: every `blockedBy` branch; `hold` vs `skip`; exhausted prerequisite blocks
  dependents; cooldown re-opens a fresh ladder; `completedAt` monotonic under fact
  regression; holdout writes no provider call but writes a send row; silent tick
  writes a decision.
- Attempt accounting under policy deferral, session suppression, sunset, holdout.
- Dispatch re-verify cancels a satisfied send.
- Lease: two concurrent ticks produce one send.
- Scheduling: `nextTickAt` from gap + delivery window; fact-change event ticks early
  but not inside `minGapDays`.
- Upgrade: a 0.20-seeded database with no categories, no policy, no programs behaves
  byte-for-byte as before (snapshot the existing e2e suite's outputs).

Integration (drive harness + playwright): preference page flows; admin program editor
publish/draft; run view decision timeline.

Real-stack (maxed harness from handoff-trial-emails.md): seed one account, time-travel
through connect-Shopify → connect-GA4 → agent → playbook, verify one email per gap,
attempts escalate, Shopify connection flips the action satisfied and the next tick
moves on, upgrade aborts, holdout account receives nothing but logs everything.

---

## 11. Release and migration

**Version**: 0.21.0, one release. Pre-1.0 minor; additive.

**No forced data migration.** Every new field is optional; every new collection is
created by `syncIndexes()` on init; every new config key defaults to "off".

**One semantic shift, opt-in**: assigning a category to a template changes that
template's unsubscribe link from "all marketing" to "this category". Uncategorised
templates are unchanged.

**`mailery doctor`** (new CLI command): connects with the host's config and reports
mailery version, marketing templates without a category, declared vs used categories,
whether `contactPolicy` / `factsAdapter` / programs are configured, index status for
new collections, suppression rows with unknown scopes, and program runs with stale
leases. Exit code non-zero on anything that would make a Program tick fail.

**Per-host checklist** (CHANGELOG "check before upgrading"):
1. Bump. Run `doctor`. Deploy. Behaviour unchanged.
2. Declare categories in config; set `category` on marketing templates (script
   provided: `mailery-backfill-categories --map slug=category`). Preference page
   goes live.
3. Set `contactPolicy`. Watch deferred counts in admin for a week.
4. Only hosts using Programs: add `factsAdapter`, seed the program disabled, preview
   with `POST …/tick` on a test account, enable with `holdoutPct`.

---

## 12. Deferred (explicitly not v1)
Variant config and weights, winner selection, experiment UI (log `variantId` only).
Exploration / randomised ranking. Push and in-app *message* channels (`deliveries[]`
shape reserved). LLM-drafted copy (reserve `send.llm` subdoc). Contact-scoped
Programs (`subject: 'contact'`). Fallback actions. Digest/batching.

---

## 13. Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Release shape | One release | Three hosts, all ours; three upgrade rounds buy nothing |
| Subject | Account | Facts are account-scoped; one ledger row per account avoids emailing every teammate |
| Ranker | Static priority | Rules suffice at this scale; ledger is the investment |
| Holdout | Per-program %, deterministic, at launch | Only way to know nudges cause anything |
| Exploration | None | Costs conversions to collect data that can't train at this N |
| Variants | Field logged, feature deferred | Log is irreversible, config is additive |
| Channels | Email only, shape reserved | In-app surface is a persistent checklist, "unseen" is meaningless |
| Fallback | None | Becomes the most-sent email |
| Completion | Monotonic | UI and email must agree; regressions are new actions |
| Attempts | Accepted sends only | Capped-but-advanced burns ladders silently (Braze failure mode) |
| Categories | Before/with Programs, not after | Nudges are the emails most likely to trigger an unsubscribe |
| Interactions | On `mailer_sends` | One ledger shared with Flows; contact policy reads one collection |
| Scheduling | next-eligible-at + fact-change wakeup | Fixed polling has cadence jitter |

---

## 14. Open items
- `decisionRetentionDays` default: none vs 180. Decide at build.
- Whether `Facts Changed` should carry a `facts` payload to skip a resolve.
- Preference page styling: reuse the existing unsub page shell or new.
- Name: "Programs" vs "Journeys" vs "Nudges" in the admin UI.
