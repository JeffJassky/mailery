# Research 02: Next-Best-Action / decisioning systems

Scope: how NBA engines model an action and its eligibility, rank, enforce contact policy, log outcomes, and handle "nothing eligible". Tags: **[V]** read in a fetched/searched source this session; **[I]** my inference; **[U]** unverified (vendor marketing, forum, or from memory; check before relying).

## 1. Takeaway

Every serious NBA system is the same pipeline: **candidate set -> filter (eligibility/applicability/suitability + contact policy/caps) -> score and rank (priority, optionally propensity x value x context x levers) -> pick top N -> log the decision and the outcome to an interaction-history ledger -> fall back to a default or stay silent if the filtered set is empty.** The differences are in the ranking step. Rules-first systems rank by a static integer priority. ML systems multiply a learned propensity by business value and weights. Duolingo-style bandits learn a per-arm score and keep the same eligibility filter in front. Three things make a rules-first system upgradeable without migration: (a) the **ledger records the whole eligible set and ranking inputs at decision time, not just the winner**; (b) every send carries an **outcome and a measurement window**; (c) the **ranking is a function slot** (`priority` today, `score()` later) and the **filter is a separate step** that never moves. For a few thousand accounts, rules are enough. There is not enough data per arm for a learned model to beat a sane priority order, but the logging for it is cheap to add now.

## 2. Per-system notes

### 2.1 Pega Customer Decision Hub (the reference architecture)

**Action model [V, partly I].** Actions live in a hierarchy: Issue > Group > Action (Pega Academy U+ Bank exercise: "Credit Cards" group containing four cards). Policies attach at group level (inherited) or at action level. Sources: https://academy.pega.com/challenge/exploring-decisions-customer-decision-hub/v6 and https://academy.pega.com/node/101921

**Three engagement-policy types [V on examples, definitions I].** The exercise shows: *eligibility* (group-wide: age >= 18), *applicability* (group-wide: excludes customers who already hold a credit card), *suitability* (premium tiers only; for example an action-level eligibility of "tenure <= 90 days"). Pega's own page doesn't define the terms; my reading: eligibility = may this customer be offered this at all (legal/product); applicability = is it relevant to their current state (satisfied-style check); suitability = is it appropriate (for example vulnerability, affordability).

**Ranking [V partly].** "Arbitration" computes final priority. Sources agree propensity is one input; versions differ on the rest (propensity and context weighting in one version). Commonly cited formula is propensity x context weight x business value x business levers **[U: from general knowledge, not confirmed in fetched pages]**. Business levers are a tunable multiplier by action, group, or situation. Propensity comes from adaptive models per action (online-learning Bayesian/logistic) **[U]**.

**Contact policy / fatigue [V partly].** The "Next-Best-Action Designer" has a *Constraints* area. Documented examples: cap messages per channel per period ("no more than two emails in a week"), and suppress an action after N exposures for D days ("pause an offer for seven days after five views"). Also "limit the number of actions" per interaction. Sources: https://docs-previous.pega.com/node/2410981, https://docs-previous.pega.com/node/2411146 (these URLs redirect to an archive index now; I read them only as search snippets).

**Ledger [V].** *Interaction History* (IH), one row per (customer, action, channel, decision time) with outcome, rank, and propensity. Report columns seen: Subject ID, Issue, Group, Proposition name, Channel, Offered on, Outcome, Rank. Standard outcomes: `Pending` (default for outbound email/SMS/push when sent), `Impression` (inbound: presented; outbound: email opened), `Clicked` (self-service digital), `Accepted` (assisted channel), `Rejected`, `NoResponse` (after a response timeout). Outcomes are mapped to *positive/negative* classes for model learning. Custom outcomes are added via the Contact policy and Update Status shapes. Source: https://docs-previous.pega.com/node/2638601, https://docs-previous.pega.com/node/2309421.

```jsonc
// IH row, as I understand it
{ "subjectId":"cust1", "issue":"Sales", "group":"CreditCards", "action":"RewardsCard",
  "channel":"Email", "decisionTime":"...", "rank":1, "outcome":"Pending",
  "propensity":0.031, "priority":0.031 }
```

**Nothing eligible [U].** Pega strategies typically end with a default/"placeholder" or empty result; this is configured per channel. Not confirmed in sources read.

### 2.2 Salesforce Next Best Action (Sales/Service Cloud; Marketing Cloud not found)

I found no Marketing Cloud-specific NBA documentation. Only Einstein NBA on the core platform surfaced, so any Marketing Cloud claim here is **[U]**. Sources: https://trailhead.salesforce.com/content/learn/modules/einstein-next-best-action/understand-how-einstein-next-best-action-works, https://unofficialsf.com/next-best-action-home/

- **Action model [V]:** a *Recommendation* record (name, description, image, accept/reject flow, active flag). Candidates load into a **Strategy** (Strategy Builder canvas, or a Recommendation Strategy flow). Node types: Load (recommendations), Filter, Sort, Branch/If, Map, Union, Prediction (inject an Einstein Prediction Builder score), "Recommendation Limit".
- **Ranking [V]:** Sort nodes over any field (static priority or a prediction score). Branching can apply different rules by score.
- **Fatigue [V partly]:** Strategy Builder (not Flow) supports limiting repeated showing of a recommendation; a "Recommendation Limit" node caps count per surface.
- **Ledger [I]:** accept/reject responses stored as `RecommendationReaction` records **[U on object name]**. They're read back into strategy to filter out already-rejected items.
- **Empty [V partly]:** the component simply renders nothing / a configured "no recommendations" message **[U]**.

### 2.3 Adobe Journey Optimizer (AJO) decisioning

Sources: https://experienceleague.adobe.com/en/docs/journey-optimizer/using/decisioning/experience-decisioning/decision-items/items, https://experienceleague.adobe.com/en/docs/journey-optimizer/using/decisioning/experience-decisioning/decisioning-guardrails, legacy offer docs at https://experienceleague.adobe.com/en/docs/journey-optimizer/using/offer-decisioning/create-manage-activities/create-offer-activities

**Action model [V].** An *offer* / *decision item* has content representations per *placement*, an **eligibility rule** or audience (default: everyone eligible), **capping constraints** (up to 10 per item, global or per profile, counting decision events by default, or impressions/clicks/custom events), and a validity window. A *decision* (policy) binds a *placement* to one or more *evaluation criteria*: each criterion = a collection/filter of eligible items + a **ranking method**, and has a **fallback offer**.

```jsonc
{ "decision": { "placement":"email-hero",
    "criteria":[ { "collection":"nbaActions", "rank":{"type":"formula|aiModel|priority"} } ],
    "fallbackOffer":"generic-welcome" },
  "item": { "id":"connect-ga4", "priority":50, "eligibility":"<rule/audience>",
    "capping":[{"event":"decision","scope":"profile","max":3,"window":"7d"}],
    "validity":{"from":"...","to":"..."} } }
```

**Ranking [V].** Three: static item `priority`; a **ranking formula** (PQL expressions, may use profile or context data; stack ranks across criteria); or an **AI model** ranking on likelihood of engagement (open/click/convert). Criteria are evaluated in sequence or together; if the first criterion yields too few eligible, the engine moves on to the next, then fallback.

**Fatigue [V].** Caps are per item, not across items; cross-item fatigue is handled by journey-level frequency rules in AJO **[U]**.

**Ledger [I].** Decisioning writes *decision events* to AEP datasets (decision event, impression, click via experience-event schemas). Note the caveat in the docs: capping counters can lag up to ~3 s and only decision events auto-feed back reliably (the docs say feedback for other events "may not" be automatically collected).

**Nothing eligible [V].** One fallback per decision, which must cover every placement in the decision. Fallback shows when the profile is not eligible for any personalized item.

### 2.4 Braze (BrazeAI Decisioning Studio, formerly OfferFit; "Intelligent Selection" is a separate, simpler feature)

Sources: https://braze.com/docs/user_guide/brazeai/decisioning_studio/ (my search returned only non-English variants; I did not find "Intelligent Selection" docs, so what I say about it is **[U]**: from memory it is a variant-selection A/B test that shifts traffic to winners).

Decisioning Studio **[V on shape]**: an *agent* is configured with a **success metric**, an audience, **dimensions** (send time, subject, frequency, offer, channel), a list of **options per dimension**, **constraints**, and **control groups** (random, BAU, holdout). It does 1:1 RL-style selection over the option cross-product, with the control arms to prove lift. Model internals aren't public. Takeaway for us: the vendor ships *explicit holdout/random-control groups* as first-class config.

### 2.5 Optimove

Searches returned only a 2020 press release (Self-Optimizing Journeys) **[V, vendor claim]**: for each customer it checks which campaigns they are eligible for, then estimates response likelihood and effect on lifetime value, and picks one. Their claims of beating manually prioritized campaigns are self-reported and unverified. Source: https://europeangaming.eu/portal/latest-news/2020/08/07/75629/optimove-announces-general-availability-of-self-optimizing-journeys/. Conceptually the same pipeline; "uplift" rather than propensity as the rank signal **[I]**.

### 2.6 Duolingo (published: KDD 2020, Yancey and Settles)

Sources: https://research.duolingo.com/papers/yancey.kdd20.pdf (read), https://blog.duolingo.com/hi-its-duo-the-ai-behind-the-meme/

**Action model [V].** A *template* in a pool, each with **eligibility criteria** (">= 3-day streak", "has streak wager", "travel motivation set"). Exactly one template is chosen per user per day.

**Ranking [V].** "Recovering Difference Softmax": the score of an arm is the *relative difference* between average reward when it was chosen and average reward when it was **eligible but not chosen**. That corrects for arms eligible only for highly active users. Softmax over scores, with a **recency (recovering) decay** so recently shown templates are less likely, since fresh copy performs better. Reward is binary: lesson completed within two hours of the push. Results: +0.5% DAU, +2% new-user retention vs strong baseline.

**Why this matters to us [I]:** the estimator *requires the ledger to record which arms were eligible-but-not-chosen at each decision*. If you only log the winner you cannot compute this and have to migrate or re-simulate.

### 2.7 Netflix, Spotify, Pinterest (limited)

No Spotify or Netflix engineering-blog notification post found **[U]**. Netflix conference slides (MESA, Data Council SF 2020) describe a contextual bandit with fixed-probability epsilon exploration and a "no-harm" test for exploration, and the causal question "did they watch because of the message?" Source: https://www.datacouncil.ai/hubfs/Data%20Council/slides/SF20/MESA%20-%20Building%20a%20Personalized%20Messaging%20System%20at%20Netflix%20%7C%20Netflix%20%7C%20Data%20Council%20SF%2020.pdf. Pinterest's volume optimization (offline RL; treats volume as a penalty/guardrail) is the best analogue for cross-action fatigue: https://arxiv.org/pdf/2207.03029 and https://medium.com/pinterest-engineering/user-state-based-notification-volume-optimization-7764118f73ff. Practitioner survey: https://arxiv.org/pdf/2302.01223 (Practical Bandits).

### 2.8 Academic framing

- **Contextual bandit:** context x (facts), arms a (eligible actions), reward r (outcome). Needs the *propensity of the logging policy* (`P(a|x)`) to do unbiased off-policy evaluation (inverse propensity scoring). A deterministic rules policy has P = 1, which makes IPS degenerate; this is why you add a small epsilon of randomization early **[I, standard result]**.
- **Sleeping bandits** = arms not always available (our `eligible`); **recovering bandits** = arm reward depends on time since last shown (our escalating attempts and cooldowns). Duolingo's paper covers both.
- **Constraint-based ranking** = hard constraints (caps, cooldowns, DAG `requires`) as filters; soft objectives as the score.

## 3. Rules-based vs ML-ranked NBA, and when rules suffice

| | Rules (priority + eligibility + suppression) | ML-ranked |
|---|---|---|
| Ranking | static ordinal per action | propensity x value x context x levers, or bandit |
| Data needed | none | hundreds to thousands of exposures **per action** with outcomes |
| Debuggability | "why this email?" is one line | needs score decomposition logging |
| Failure mode | stale priorities | feedback loops, novelty bias, cold start |

Few thousand accounts, a dozen actions, outcomes that are slow (connected an integration within days), and sparse (low single-digit conversion): a learned ranker would see maybe tens of positives per arm per month. **Rules suffice**; the right investment is logging, holdouts, and per-action funnel reporting **[I]**. Pega itself is largely a rules/policy engine with a learned propensity as one multiplier; the engine isn't the hard part, the ledger is.

## 4. Rules-first path that grows into ranking (proposal)

Principle: the decision is a pure function `decide(facts, ledger, now) -> Decision`, and the **Decision itself is persisted**, not just the send.

### 4.1 Action definition (today)

```jsonc
{
  "key": "connect-ga4",             // stable id, never reused
  "version": 3,                     // bump when eligibility/copy semantics change
  "group": "integrations",          // for group-level caps/policies (Pega Group)
  "priority": 50,                   // static rank today
  "value": 1,                       // business value weight, default 1 (future multiplier)
  "eligible": "<fn(facts)>",        // filter step
  "satisfied": "<fn(facts)>",
  "requires": ["connect-shopify"],  // DAG
  "attempts": [ { "templateId": "t1", "variant": "a" }, ... ],
  "cooldown": "5d",
  "onExhaust": "skip",
  "contact": { "maxPerWindow": 3, "window": "30d" },   // per-action cap (AJO-style)
  "tags": ["activation"]            // for group suppression/reporting
}
```

Reserve now, even if unused: `value`, `group`, `tags`, `version`. All are cheap, optional, and later become ranker inputs or policy hooks.

### 4.2 Ledger: two collections

**`decisions`** (one row per evaluation tick per account, including ones that send nothing):

```jsonc
{
  "_id": "...", "programKey": "onboarding", "accountId": "a1", "at": "...",
  "factsSnapshot": { /* or hash + ref to the exact facts used; small */ },
  "factsHash": "…",
  "candidates": [                    // ALL actions considered, not just the winner
    { "action":"connect-ga4", "actionVersion":3, "eligible":true, "satisfied":false,
      "blockedBy": null,             // "requires:connect-shopify" | "cooldown" | "cap" | "ineligible" | "exhausted"
      "priority":50, "score":50, "scoreParts":{"priority":50,"value":1}, "rank":1 }
  ],
  "chosen": "connect-ga4",           // or null
  "reason": "highest-rank|fallback|none-eligible|policy-silence",
  "policy": { "name":"rules-v1", "version":1 },     // ranker identity
  "selectionProb": 1.0,              // P(chosen | candidates) under the logging policy
  "explore": false,                  // true if chosen by randomization
  "arm": "treatment|holdout"         // holdout = decision made but send suppressed
}
```

**`interactions`** (one row per send, linked to a decision):

```jsonc
{
  "decisionId":"...", "accountId":"a1", "action":"connect-ga4", "actionVersion":3,
  "attempt": 2, "templateId":"t2", "variant":"b", "channel":"email",
  "sentAt":"...", "messageId":"provider-id",
  "outcome": "pending",   // pending|delivered|opened|clicked|satisfied|bounced|complained|unsub|no_response
  "outcomes": [ { "type":"clicked","at":"..." }, { "type":"satisfied","at":"..." } ],  // append-only
  "attributionWindow": "7d", "closedAt": null
}
```

Why this layout:
- `candidates[]` with `blockedBy` gives Duolingo's "eligible but not chosen" comparison group (section 2.6) and lets you answer "why didn't they get X?" today.
- `selectionProb` + `explore` + `policy` enable inverse-propensity off-policy evaluation later. Today it is always 1.0; once you add epsilon-greedy it becomes real, with no schema change.
- `scoreParts` is the Pega/AJO arbitration decomposition. A later ML ranker fills `score` from `propensity x value` and leaves `priority` as a tie-break.
- `factsSnapshot` is the feature vector. Without it, training data must be reconstructed from mutable current facts and will leak the future.
- Append-only `outcomes[]` with an explicit attribution window follows Pega's Pending -> Impression/Clicked/Accepted/Rejected/NoResponse. Closing a window to `no_response` is what produces negative labels.
- `arm: holdout` (Braze's control groups): hold out e.g. 5% of accounts from sends but still log the decision, so lift is measurable and the baseline survives later.

### 4.3 Ranking as a slot

```ts
type Ranker = (candidates: Candidate[], ctx: Ctx) => Candidate[]   // returns scored, sorted
const priorityRanker: Ranker = c => sortBy(c, x => -(x.priority))  // today
// later: scoreRanker (propensity * value), epsilonGreedy(wrap), softmaxRecency (Duolingo)
```

Filter pipeline stays fixed and ordered: `requires` -> `satisfied` -> `eligible` -> per-action cap/cooldown -> program/account-level fatigue -> rank -> pick -> fallback/silence.

### 4.4 Program-level contact policy (cross-action)

Per-action caps alone (AJO's model) don't stop 5 different actions firing in one week. Put a policy at program (and optionally account-global) level: `maxSendsPerWindow`, `minGapBetweenSends`, quiet hours, suppression after `unsub|complaint|bounce`, and "last N days of any marketing send". Evaluate it as a filter producing `reason: "policy-silence"` with the decision still logged. Pega does this with channel-level constraints; Pinterest treats volume as a modeled budget **[V/I]**.

### 4.5 Empty set

Three distinct outcomes, kept distinct in `reason`: `none-eligible` (all satisfied or blocked: success state, usually stay silent), `policy-silence` (eligible but suppressed by fatigue/quiet hours: retry next tick), `fallback` (optional generic/"digest" action marked `isFallback`, AJO-style, one per program). Default to silence for lifecycle programs; a fallback is only worth having if it has real value.

## 5. Pitfalls

1. **Logging only the winner.** The most expensive mistake: no counterfactual, no off-policy eval, no "why not" debugging. Fix: `candidates[]`.
2. **Rows only on send.** Ticks that choose nothing are also data (and the only way to see fatigue/silence working).
3. **Deterministic policy + later learning = confounded data.** If priority 1 always wins, you never observe others. Add a small `explore` fraction and holdout before you need them; they are hard to retrofit.
4. **Attribution ambiguity.** Account connects GA4 two days after a different email. Define satisfaction as a fact change, record `lastSendBefore` per action, and don't claim causality without a holdout. (Netflix's causal question, 2.7.)
5. **Satisfaction is not an engagement.** Optimize for fact-change (connected), not opens; Apple MPP inflates opens **[U]**. Pega separates Impression/Click/Accepted for this reason.
6. **Mutating action semantics in place.** Changing `eligible` or copy without a `version` poisons per-action stats. Version actions and templates.
7. **Escalation as copy only.** Attempts that vary in tone but not reason teach nothing; store `attempt` and `templateId` so per-attempt conversion is reportable.
8. **Per-action caps without a global cap** (see 4.4); and caps that count `decision` rather than `sent` events (AJO's default) can burn budget on non-sends **[I]**. Count actual sends.
9. **Fallback spam.** A generic fallback with no cap becomes the most-sent email.
10. **Cooldown clock.** Use ledger `sentAt`, not facts, as cooldown source; facts can be rewritten by re-syncs.
11. **Premature ML.** At a few thousand accounts, report per-action funnels and holdout lift first; only add scoring when an action has hundreds of exposures and outcomes.
12. **Source gaps.** Pega/Adobe doc URLs partially redirect to archives; Optimove, Braze Intelligent Selection, Spotify, and Marketing Cloud NBA internals were not verified here. Treat those sections as orientation, not specification.
