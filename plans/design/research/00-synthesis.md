# 00 — Synthesis: what the research changes in the Program design

Written 2026-10-07 after reading 01–04. This is my own judgment, not a summary. Where I
disagree with a report I say so. Sourcing caveat carried forward: 03 made no web fetches
at all; 01 and 04 verified only a minority of vendor claims; 02 is the best-sourced.
Treat vendor field names as orientation. The *design* conclusions below do not depend on
any single unverified claim.

## 1. What the research settles

**Programs are a real gap, not a reinvention.** Every mainstream engine is a step graph
with one membership per user per journey. Arbitration between concurrently eligible
messages is pushed outside the graph (caps that *drop*, binary "not if in another
journey", hand-written exclusive audiences). The NBA vendors (Pega, Adobe, Duolingo) are
the ones that have the primitive we want, and they all run the same pipeline:

```
candidates → filter (requires, satisfied, eligible, caps/policy) → rank → pick one
           → log decision + outcome → fall back or stay silent on empty
```

Our tick is that pipeline with a static-priority ranker. Keep it. Rules are enough at a
few thousand accounts; the ledger is the hard part, not the ranker.

## 2. Changes I am making to the design

### 2.1 Subject is the account; recipient is derived
Facts are account-scoped (connections, business context, playbooks). Mailery contacts are
people. So: **one ledger row per (program, accountId)**, and a per-program
`recipients` rule that resolves the account to one or more contacts at send time
(`owners` by default; never "all members" without saying so). Interactions log per
contact. This is the single largest divergence from Flows (which are per contact) and
the main architectural risk. Trial flows already approximate it ("fire per owner member");
Programs make it first-class instead of pushing the loop onto the host.

### 2.2 Decision log records every candidate, every tick
New collection `mailer_program_decisions`, one row per evaluation, including ticks that
send nothing. Each candidate carries `blockedBy` (`requires:<id>` | `satisfied` |
`ineligible` | `exhausted` | `cooldown` | `cap` | `policy`), its rank inputs, and the
tick stores the facts snapshot (or hash + ref), ranker `{name, version}`, chosen action,
and `reason: highest-rank | none-eligible | policy-silence | fallback`. Cheap now,
impossible to backfill, and it is the "why didn't they get X" support tool on day one.

### 2.3 Interactions are `mailer_sends` rows, not a new collection
02 proposes a separate `interactions` collection. Mailery already has `mailer_sends` with
open/click/bounce tracking and a dispatch-time guard. Add a `program` subdocument
(`programSlug, accountId, actionId, actionVersion, attempt, variantId, decisionId,
holdout`) instead. This gives 01's "one send ledger shared with Flows" for free: the
contact-policy stage reads one collection to answer "did anything email this person
this week".

### 2.4 Only an accepted send consumes an attempt
Braze advances past a capped step without sending. In a Program that would exhaust a
ladder silently. Rule: attempt counter increments only when a send is accepted by the
pipeline. Cap, quiet-hours and holdout suppression leave action state unchanged and are
logged on the decision.

### 2.5 Satisfied is state, monotonic, re-checked at dispatch
- `satisfied(facts)` is a predicate, never an event. True on first evaluation →
  `skipped:already_satisfied`, no attempt.
- Completion is **monotonic per action**: store `completedAt`; a later fact regression
  (Shopify disconnected) does not resurrect "connect Shopify". A regression is a
  different action (`reconnect-shopify`) with its own copy. This keeps checklist UI and
  email agreeing and stops the embarrassing re-nag.
- Re-verify `satisfied` and `eligible` at dispatch time, after any delivery-window
  deferral. The existing `send_deferred` + dispatch-time guard from FLOW_ABORT is the
  hook.

### 2.6 Facts never derive from mailer sends
01's "same-event entry/exit loop" in policy form: an action whose own send flips a fact
it reads. Enforce by construction: `factsAdapter` is host code reading host state;
mailer predicates (`hasFiredEvent`, `hasClicked`) are still available but are not facts.

### 2.7 Contact policy is one stage, outside every Program
Shared with Flows and broadcasts. Rolling windows (not Braze's calendar-day), recipient
timezone with account-tz fallback, quiet hours, `minGap`, per-channel caps, and priority
so a transactional/billing send wins and a nudge **defers** rather than drops. Deferral
carries `notBefore` + expiry and re-checks the predicate (2.5). Transactional bypasses
caps but is still written to the ledger.

### 2.8 Scheduling is "next eligible at", not polling
Fixed cadence has jitter (fit the gap rule a minute after a tick, wait a whole cadence).
Compute `nextTickAt = max(lastAcceptedSendAt + minGap, next delivery-window slot)` and
also wake on a host-fired fact-change event, bounded by `minGap`. Replaces
`cadence.everyDays` in the earlier sketch.

### 2.9 Sunset ladder is v1
Per (program, account): `unansweredAttempts`, reset by any engagement signal (session,
human click, fact progress). Policy: normal cadence → slowed after K → one "should we
keep sending these?" message → suppress until a new engagement event. This, plus
suppressing email when the user had a session in the last N hours (they are looking at
the checklist), is most of what makes nudges "well-liked" rather than aggressive. Open
rate is never the signal (Apple MPP).

### 2.10 Holdout yes, exploration no
- **Holdout**: deterministic hash of accountId, 5–10% per program, decision logged with
  `arm: holdout`, send suppressed, a would-have-sent row written. Without it,
  "connected GA4 two days after the email" is indistinguishable from organic.
  Per-program first ("do nudges work at all"), per-attempt later.
- **Exploration** (02 pitfall 3 urges a small epsilon now): I disagree for v1. With a
  dozen actions and a few thousand accounts, randomising priority costs real conversions
  to collect ranking data that 02 itself says cannot train anything at this N. Reserve
  `selectionProb` and `explore` on the decision row (always `1.0` / `false`) so the
  schema needs no migration if that changes.

### 2.11 Variants: log the field, do not ship the feature
03's `variants[]` + `experiment{}` on every Attempt is more surface than v1 needs. Ship:
`variantId` on every send (`"default"`), the deterministic hash-assignment function, and
template version pinned at send (templates are already versioned in
`mailer_template_versions`). Do not ship variant config, weights, winner UI or stats.
Everything 03 says to "log now" is covered by 2.2 and 2.3. Config is additive later;
the log is not.

### 2.12 Channel on the attempt, email-only in v1
04's "in-app first, email if unseen" assumes in-app is a *message* with a seen state. Our
in-app surface is a persistent checklist, so "unseen" is meaningless. Model the attempt
as one intent with `deliveries[]` so escalation across channels counts once against
`maxAttempts`, but v1 has one delivery (`email`). The real cross-channel lever today is
the session-presence rule in 2.9.

### 2.13 Programs chain like flows
On `none-eligible` (every milestone satisfied or exhausted) the Program **exits** and
fires an event (`Activation Complete`), which can enter the next Program (e.g. a
Grammarly-style "your data says X" insights track). No generic fallback action: 02 is
right that a fallback with no cap becomes the most-sent email.

## 3. Mailery-wide changes this surfaces (not Program-local)

| Change | Why | Scope call |
|---|---|---|
| Category-scoped unsubscribe (`lifecycle.onboarding` × channel) | Today scope is `all \| marketing \| transactional`. "Stop onboarding tips" must not be a global unsub. | Mailery-wide. Needed for Programs to be well-liked; could ship as `marketing` initially and add categories in a follow-up. |
| Shared contact-policy stage (2.7) | Flows, broadcasts and Programs must not email the same person the same day. | Mailery-wide. Programs are the forcing function. |
| Subject-scoped (account) ledger | Flows are per contact. | Program-local, but the admin UI gains an "account" view. |

## 4. Revised shape

```ts
interface Program {
  slug: string; version: number; category: string          // 'lifecycle.onboarding'
  subject: 'account'
  recipients: 'owners' | 'admins' | { adapter: string }
  entry: { eventName: string }                              // 'Created'
  exit:  { eventNames?: string[]; onComplete?: { fireEvent: string } }
  policy: { minGapDays: number; delivery?: DeliveryWindow
            suppressIfSessionWithinHours?: number
            sunset?: { slowAfter: number; askAfter: number; slowFactor: number } }
  holdoutPct?: number
  actions: Action[]
}

interface Action {
  id: string; version: number; priority: number
  group?: string; tags?: string[]; value?: number           // reserved ranker inputs
  eligible?: Predicate; satisfied: Predicate
  requires?: string[]                                       // DAG; exhausted prereq blocks
  attempts: Attempt[]
  onExhaust: 'skip' | 'hold'; cooldownDays?: number
}

interface Attempt {
  deliveries: [{ channel: 'email'; templateSlug: string }]  // one in v1
  minGapDays?: number
}

// mailer_program_runs      one per (program, accountId): per-action state, completedAt,
//                          unansweredAttempts, nextTickAt, sunsetStage, holdout arm
// mailer_program_decisions one per tick: factsHash/snapshot, candidates[] w/ blockedBy,
//                          chosen, reason, ranker, selectionProb, explore, arm
// mailer_sends.program     { programSlug, accountId, actionId, actionVersion, attempt,
//                            variantId: 'default', decisionId, templateVersion, holdout }
```

Filter order is fixed: `requires → satisfied → eligible → exhausted/cooldown → contact
policy → rank → pick → re-verify at dispatch`.

## 5. Decisions that remain yours

1. **Subject = account.** Recommended strongly; it is the premise of 2.1. Say no and most
   of this collapses back to per-contact Flows with a selector.
2. **Holdout at launch** (5–10% per program) or after the first copy is proven. I would
   launch with it; it is the only way to learn whether the Program works.
3. **Category unsubscribe in v1** or ship under `marketing` scope first.
4. **Exploration**: my recommendation is none in v1 (2.10). Overrides 02.
5. **LLM copy**: out of v1. Reserve an `llm` subdoc on the send row.

## 6. Pitfalls I would otherwise have missed

- Capped-but-advanced burning attempts (Braze). → 2.4
- Fact regression un-completing a milestone and re-nagging. → 2.5 monotonic
- An action's own send mutating a fact it reads. → 2.6
- Cadence jitter from fixed polling. → 2.8
- Per-action caps with no global cap; caps counting decisions instead of sends (AJO
  default). → 2.7, count accepted sends only
- Counting attempts per channel instead of per intent. → 2.12
- Preferences resolved at enqueue, not at send; user unsubscribes during a deferral.
  → 2.5/2.7 re-check at dispatch
- Fallback becoming the most-sent email. → 2.13 no fallback
- Windsor sync lag: `shopify_connected` true before any data has landed. The
  `satisfied` predicate for connection actions should probably be "first data landed",
  not "account id present". Maxed-specific; decide when writing the facts adapter.
