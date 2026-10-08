# 03 - Copy variation, A/B testing and experimentation in lifecycle messaging

Status: desk research written from background knowledge. No live web fetches were made in this pass. Every vendor-specific claim is marked **[recall]** (from memory, plausible, not re-verified) or **[verified]** (none are; do not treat any as verified). Source URLs are the doc landing pages to check before relying on a detail.

## 1. Takeaway

At hundreds to low thousands of accounts, most email A/B tests cannot detect anything except very large effects. So the Attempt model should do two things. First, make *escalating sequential copy* (attempt 1 = ask, attempt 2 = reminder, attempt 3 = last call) the primary, well-supported mechanism: it is a deterministic ladder, not an experiment. Second, record enough at send time (variant id, assignment, holdout flag, template version, goal event) that experiments can be analyzed later without a rewrite. Do not build a stats engine, bandits or auto-winner selection now. Build the data model: `variants[]` on the Attempt with weights, sticky assignment stored on the ledger, an exposure record per send, and a named goal event. Use clicks and downstream product conversions as metrics; never opens. Where the numbers are too small, say so in the report ("directional only") rather than declaring winners. LLM-generated copy complements this: it is a *source of variants* (human-approved), not a replacement for measurement.

## 2. How the vendors model it

### Common vocabulary
Every tool reduces to: **experiment** (a scoped test) -> **variants/arms** (copy/template alternatives, one possibly "control") -> **allocation** (percent weights summing to 100) -> **assignment** (unit -> arm, ideally sticky) -> **exposure** (the logged fact that the unit actually saw the arm) -> **goal metric** (event + attribution window) -> **decision** (winner selection, manual or automatic).

### Braze **[recall]**
- Canvas has a *Variant* concept at the Canvas level (whole-journey variants) and Canvas **Experiment Paths** at step level; message steps can have multiple message variants with percentage splits. A **Control Group** is a variant that receives no message, and conversion is compared against it. Campaigns support multivariate tests with a control and *Winning Variant* auto-roll-out to the rest of the audience after a test cohort.
- **Intelligent Selection** is a bandit-like allocator: it periodically re-weights variants toward better performers on the chosen conversion event. Braze documents a minimum audience size and warns that it needs enough volume to learn **[recall]**.
- **Personalized Variant** (newer) picks a variant per user using predicted response **[recall]**.
- Assignment is by random bucket on user, held stable for the life of the Canvas; "Global Control Group" holds out a percentage of all users from all (or tagged) messaging to measure total lift, with reporting separate from campaign-level control **[recall]**.
- Sketch:
```json
{ "canvas": "onboarding", "step": "reminder-1",
  "variants": [{"id":"A","weight":45},{"id":"B","weight":45},{"id":"control","weight":10,"send":false}],
  "conversionEvent": "shopify_connected", "window": "7d", "winner": "auto|manual|intelligent" }
```
- Docs: https://www.braze.com/docs/user_guide/engagement_tools/canvas/ , https://www.braze.com/docs/user_guide/engagement_tools/testing/multivariant_testing/ , https://www.braze.com/docs/user_guide/engagement_tools/campaigns/ideas_and_strategies/ab_testing/ (check current paths).

### Iterable **[recall]**
- **Experiments** on blast campaigns and workflow *Experiment* nodes: up to a handful of variants (commonly 8 on campaigns; fewer in journeys) with percentage allocation; for campaigns, a test pool then a winner selection on opens, clicks, unsubscribes, or custom conversion, with the winner sent to the remainder. In journeys, an experiment node splits a user into branches that persist (each user walks one branch).
- **Send Time Optimization** and **Brand Affinity** (AI add-ons) are model-driven per-recipient decisions rather than classical tests. STO picks a send hour per user; Brand Affinity scores users for content/product affinity.
- Sketch: `{ "experimentId": "e1", "templates":[{templateId, weight}], "winnerMetric":"uniqueEmailClicks", "testPct": 20, "winnerAfterHours": 24 }`.
- Docs: https://support.iterable.com/hc/en-us/articles/ (search "Experiments", "Send Time Optimization", "Brand Affinity").

### Customer.io **[recall]**
- Campaigns/Journeys include a **Split** (random A/B branch with percentages) and a **Multi-split branch**; each branch can hold a different message. Newer "Experiments" in campaigns and broadcasts support winner reporting. Users are placed into branches randomly on entry and stay there for that journey run (sticky per entry, not necessarily across re-entry).
- Goals are first-class: a campaign has a **conversion goal** (event + window) used to measure effectiveness and optionally to exit people from the campaign when achieved (goal-based exit). This maps directly to mailery's "stop the ladder when the user connects Shopify".
- Docs: https://docs.customer.io/journeys/ (see "Split testing", "Goals").

### Klaviyo **[recall]**
- Flow **A/B test**: a split action with two variants (flow splits can be more); a flow email test compares *content/subject* with a percentage split; when a statistical winner emerges Klaviyo can **pause the losing arm** (manual action in some modes). Campaign A/B tests: up to 6 variants, a test portion (e.g. 20-50%) and a winner chosen on open rate, click rate or placed-order revenue after a set window, with the winner automatically sent to the remainder. Since Apple MPP, Klaviyo leans toward click rate or conversion as the default recommendation **[recall]**.
- Docs: https://help.klaviyo.com/hc/en-us/articles/ (search "A/B test flow", "campaign A/B test").

### Mailchimp **[recall]**
- A/B (and multivariate) *campaigns* test subject line, from name, content, or send time, with up to 3 variants (more in multivariate on higher tiers). Winner by opens, clicks, or revenue; test cohort size set as a percentage, then winner sent to remainder after a wait time. Automations (journeys) allow A/B on the email in Standard+ plans, no auto-winner rollout **[recall]**.
- Docs: https://mailchimp.com/help/about-ab-testing-campaigns/

### Intercom **[recall]**
- Outbound **Series**/Messages support A/B-like **split** rules and a **control group** option for measuring lift against no message; reporting ties to goals (event-based). Intercom emphasizes *goal conversion vs control* more than winner picking.
- Docs: https://www.intercom.com/help/en/ (search "Series", "control group", "goals").

### Experimentation platforms (Optimizely, Statsig, GrowthBook, Eppo) **[recall]**
- Model: **feature flag + experiment** keyed on an **assignment unit** (user/account id). Assignment is a *deterministic hash* of `(experimentKey, salt, unitId)` into buckets (0-9999), mapped by allocation ranges to variants. Hash-based assignment is sticky by construction without a database lookup, can be reproduced offline, and survives restarts. An **exposure event** is logged when the unit is actually served the variant (not merely assigned), which is the denominator for analysis. Holdouts are a reserved bucket range, often a global layer excluded from every experiment.
- Statsig and GrowthBook (open source, has a Bayesian default) support sequential testing / CUPED variance reduction; Eppo warehouse-native with sequential and Bayesian modes; Optimizely has Stats Engine (sequential, always-valid p-values) **[recall]**.
- Sketch:
```json
{ "experiment":"reminder-copy-q4", "salt":"7f3a", "unit":"accountId",
  "buckets":[{"variant":"control","range":[0,4999]},{"variant":"urgent","range":[5000,9999]}],
  "exposureEvent":"email.sent", "goal":{"event":"shopify_connected","windowDays":7},
  "holdout":{"range":[9500,9999],"layer":"global"} }
```
- Docs: https://docs.growthbook.io/ (experiments, "Bayesian"), https://docs.statsig.com/ , https://docs.geteppo.com/ , https://docs.developers.optimizely.com/

### Bandits vs fixed horizon
- **Fixed-horizon**: choose N in advance, don't peek, test once. Honest but needs large N.
- **Sequential / always-valid**: peek anytime without inflating false positives; costs some power.
- **Bayesian**: report P(B > A) and expected loss; peeking is less harmful in principle but "stop when P>95%" still inflates error if done optimistically with tiny data **[recall; widely debated]**.
- **Multi-armed bandit** (Thompson sampling): shifts traffic toward the leader; good when *regret* matters (many sends, short-lived campaigns), poor for learning *why* and bad at small N, because early noise locks in a wrong arm. Braze Intelligent Selection and Iterable's winner modes are bandit-ish/winner-roll-out designs. For a reminder ladder that touches each user a few times, bandits mostly add complexity.

## 3. How real teams vary reminder/retry copy

Common ladder patterns (practitioner convention, **[recall]**, not rigorous evidence):
1. **Ask**: clear value, one action, low pressure ("Connect Shopify to see X").
2. **Reminder**: shorter, adds a concrete benefit or outcome, sometimes a different angle (what you're missing), often a new subject line; "Re:"-style fake threading is common but deceptive/risky-do not default to it.
3. **Last call**: explicit deadline or consequence (only if real), shortest, single CTA; may state "last email about this", which also reduces annoyance and unsubscribes.
Levers teams vary: tone (helpful -> direct), social proof ("N stores connected this week"), deadline/scarcity framing (must be true), personalization of a specific number or account fact (strongest and cheapest), subject-line-only changes, send time/day offset. Escalation across attempts is not a test because everyone sees every rung; a test would vary *within a rung* (two last-call variants) or compare ladders (3-step vs 5-step, spacing).

**Subject line vs body:** subject-line-only tests are cheap and clean (one variable, effect on click-through) but opens are corrupted (below), so they need click or downstream conversion as the readout, which dilutes power. Full-body tests change many variables at once; fine for choosing between two complete drafts, not for learning *why*.

## 4. Metrics that are valid
- **Open rate is unreliable**: Apple Mail Privacy Protection (iOS 15+, Sept 2021) prefetches images so opens fire regardless of reading; Gmail image proxying and some security scanners add noise **[recall; widely documented]**. Never pick a winner on opens. Opens also correlate with MPP share, which varies by audience.
- **Bot/scanner clicks**: corporate link scanners can click every link; filter clicks that occur within seconds of delivery or from known scanner ranges, or require a downstream event **[recall]**.
- Best primary metric: **downstream product conversion** (the goal event, e.g. `shopify_connected` within 7 days of send), attributed by `(accountId, variantId)`. Secondary: unique human clicks. Guardrails: unsubscribes, spam complaints, bounces.
- Always compare to a **holdout** (no-send) at least on the program level, else "conversion after email" is mostly people who would have converted anyway.

## 5. Statistics at small N (honest guidance)

Rule-of-thumb arithmetic (standard two-proportion test, 80% power, alpha 0.05, two-sided; computed from the usual formula, **[recall]** for rounded figures):
- Detecting 10% -> 15% (a 50% relative lift) needs about **~680 per arm**.
- 10% -> 12% (20% relative) needs roughly **~3,800 per arm**.
- 3% -> 4.5% needs about **~1,900 per arm**.
So with, say, 1,000 accounts (500 per arm) you can only reliably see lifts of roughly 8-10 percentage points on a ~10% base; with 300 accounts per attempt you basically can't test copy at all.

Practical guidance:
1. **Don't call winners** on a single attempt with < ~500 per arm unless the lift is huge. Report counts, rates and a Wilson/Bayesian interval; label as "directional".
2. **Pool across time and programs**: the same variant concept (e.g. "deadline framing last call") used across many actions accumulates exposures. Tag variants with a `hypothesis` / `tags` field so results can be pooled across Programs.
3. **Prefer big, bold, structurally different variants** (different angle, not a different adjective). Small wording changes are undetectable at this N.
4. **Bayesian with weakly informative priors** gives honest "probability B better" and an expected loss, and tolerates peeking better than naive p-values; it still cannot manufacture information. Beta(1,1) flat priors with n=200 yield wide intervals; say so **[recall]**.
5. **Sequential** designs (always-valid p-values, mSPRT) let you stop early on huge effects and keep running otherwise; useful, but add statistical code you probably don't need in v1.
6. **Bandits not recommended** below several thousand exposures per decision: early luck dominates.
7. Use **within-ladder holdout** instead of A/B when the real question is "does this attempt help at all?": hold 10% back from attempt 2/3. That question is answerable at lower N than a copy comparison because the effect (send vs no send) is bigger.
8. Frame the decision as a *prior-guided choice*, not discovery: ship the ladder that best practice suggests, measure outcomes, revisit when exposures accumulate.

## 6. LLM-personalized copy per recipient

**[recall; vendor-specific details unverified]** Braze, Iterable, Klaviyo, HubSpot, Mailchimp and Intercom all ship "AI copy assist" that is *human-in-the-loop drafting* (generate subject variants, humans pick). Fully autonomous per-recipient generation at send time is rarer and mostly in marketing-automation startups. Patterns that make it safe:
- **Constrained generation**: LLM fills *slots* (a sentence, a subject) within a template, not the whole email; structured output with length and charset limits.
- **Approved claims / grounding**: only facts passed in context (account name, real metrics); a deny-list for pricing, legal, guarantees, deadlines; reject outputs mentioning anything not in the supplied facts.
- **Human review**: pre-generate a *pool* of variants per cohort/segment, review once, then send; or review a sample before each batch. Don't generate-and-send blind.
- **Caching & determinism**: store the rendered output per (template version, recipient, attempt); never re-generate on retry; record model, prompt hash and output for audit. This is also required to analyze the experiment later.
- **Evals**: automated checks (banned phrases, link integrity, length, tone classifier) before send.
- **Complement, not replace, A/B**: generated variants are an input to experiments; measurement still needs a control. Per-recipient uniqueness makes classical A/B impossible (each message is its own "arm"), so compare *policy* (LLM-personalized vs fixed template) as the arm, with the generated text logged.

## 7. Recommended minimal data model (Attempt level)

Keep `templateSlug` as the simple, default case; add optional `variants`. A variant-less Attempt behaves as today.

```ts
interface Attempt {
  n: number                       // 1-based, available as {{attempt.n}}
  delay: Duration                 // from previous attempt or enrollment
  templateSlug?: string           // simple case (implies one variant "default")
  variants?: Variant[]            // optional; if present, templateSlug ignored
  experiment?: {
    key: string                   // stable experiment id, e.g. "shopify-last-call-2026q4"
    salt: string                  // fixed at creation; changing it reshuffles everyone
    unit: 'account' | 'user'
    holdoutPct?: number           // 0-100: no send; assigned like a variant "holdout"
    hypothesis?: string           // free text, for pooling later
  }
  goal?: { event: string; windowDays: number }   // overrides the Program/Action goal
}
interface Variant {
  id: string                      // stable, never reused: "A", "urgent"
  templateSlug: string
  templateVersion?: number        // pin or snapshot at send
  weight: number                  // relative; normalized
  tags?: string[]                 // "deadline", "social-proof" for pooling
}
```

**Assignment**: hash `(experiment.key, salt, unitId)` -> bucket 0..9999 -> variant by cumulative weight (holdout first). Deterministic, so re-computable, sticky across attempts and restarts. **Store the result anyway** on the enrollment/ledger row, because weights and variants will change later and the stored value is the truth:

```json
// ledger / send record (write at send time, never edit)
{ "_id": "...", "programId":"p1", "actionKey":"connect-shopify", "accountId":"a1",
  "attempt": 2, "experimentKey":"shopify-last-call-2026q4",
  "variantId":"urgent", "assignedAt":"...", "bucket":6120,
  "holdout": false, "templateSlug":"connect-shopify-last", "templateVersion":7,
  "subject":"...", "renderedHash":"...",           // what was actually sent
  "sentAt":"...", "messageId":"...",
  "llm": { "model":"...", "promptHash":"...", "approvedBy":"..." }   // only if generated
}
// outcomes (append-only, joined later)
{ "accountId":"a1", "event":"click", "messageId":"...", "ts":"...", "bot": false }
{ "accountId":"a1", "event":"shopify_connected", "ts":"..." }       // goal event
```

**Log NOW (cheap, irreplaceable later):**
1. Per send: `variantId` (even when only "default"), `templateSlug` + `templateVersion`, rendered subject, attempt n, `experimentKey`, bucket, holdout flag, send timestamp, message id.
2. **Exposure for holdouts**: write a ledger row for the would-have-sent attempt with `holdout:true`, `sent:false`. Without it you cannot compute the control denominator.
3. Click events with timestamp delta from send (for scanner filtering); also log opens but mark `unreliable`.
4. Goal event timestamps attributed to the account, and the Program's exit reason (`goal_reached`, `exhausted`, `unsubscribed`, `manual`).
5. Enrollment-level fields: enrollment time, cohort tags (segment, plan, source) for post-hoc slicing.
6. Immutable template versions (or a hash of rendered body) so "variant B" always means the same text.

**Defer**: auto-winner, bandits, significance UI, send-time optimization. Provide an export/query helper that returns per-variant counts (exposed, clicked, converted) and a Wilson interval; that is enough.

## 8. Pitfalls

1. **Declaring winners on opens** (MPP) or on tiny samples. Report intervals, label directional.
2. **Peeking and p-hacking** with fixed-horizon math; if the UI shows a winner badge, people will act on noise.
3. **Non-sticky assignment**: re-randomizing per attempt means a user sees mixed variants and contamination. Hash on the unit and persist.
4. **Unit mismatch**: randomizing by email/user but converting by account (or vice versa); several contacts at one account see different arms. Pick the unit (likely account) and stick with it.
5. **Changing weights or editing a variant's text mid-test** invalidates the comparison; version templates, require new variant id for text changes, treat salt changes as a new experiment.
6. **Sample ratio mismatch**: if realized split deviates from the configured weights (bounces, suppression, send failures affecting arms differently), results are suspect; log intended vs delivered.
7. **Survivorship in ladders**: attempt 3 variants are compared among those who did not convert after 1 and 2 - that's fine if assignment is made at enrollment (sticky) and analysis uses the whole cohort; comparing by-attempt only is biased.
8. **Interference/fatigue**: tests in attempt 1 change who reaches attempt 2. Analyze at the Action (goal) level, not just the attempt level.
9. **No holdout -> attribution illusion**: conversion after email is mostly organic.
10. **Escalation tone as the only variable**: "last call" urgency that isn't true is a compliance and trust problem; the data model should not make fake deadlines easy.
11. **LLM copy without caching**: regenerates differ on retry, can't be audited or analyzed, and can drift into unapproved claims.
12. **Over-building**: a stats engine for hundreds of recipients is wasted; the log is the product.

## 9. Open questions for the design
- Is the unit of randomization account or contact (likely account)?
- Should holdout be per-Program (global control) or per-Attempt?
- Are templates versioned immutably in the library today?
- Who is allowed to author variants, and is LLM drafting in scope for v1?

## Source index (check before relying; all **[recall]** / unverified)
- Braze: https://www.braze.com/docs/
- Iterable: https://support.iterable.com/
- Customer.io: https://docs.customer.io/
- Klaviyo: https://help.klaviyo.com/
- Mailchimp: https://mailchimp.com/help/
- Intercom: https://www.intercom.com/help/
- GrowthBook: https://docs.growthbook.io/ ; Statsig: https://docs.statsig.com/ ; Eppo: https://docs.geteppo.com/ ; Optimizely: https://docs.developers.optimizely.com/
- Apple MPP background: https://support.apple.com/en-us/102447 (Mail Privacy Protection) **[recall of URL]**
