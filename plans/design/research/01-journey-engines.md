# 01 - How lifecycle/journey engines model "next best action" arbitration

Research date 2026-10-07. Sourcing note: several vendor doc pages 404'd or redirected to the fetcher, so most claims come from search-result excerpts of official docs. Anything not seen in an official page is marked **(unverified)** or **(secondary)**.

## 1. Takeaway

Every mainstream engine is a **graph-of-steps (journey) model whose unit of state is "a user's membership in one journey"**. Arbitration between concurrent eligibility is almost never solved inside the graph. It is pushed to a layer outside the graph: (a) global frequency caps that *drop* sends rather than choose among them (Braze, Iterable, Klaviyo Smart Sending), (b) "don't enter if already in another journey" gates (Iterable journey entry limits), (c) exit-on-goal and re-entry windows, and (d) humans hand-writing mutually exclusive audiences. None has a first-class "pick the single best eligible message" primitive; the closest are Braze Intelligent Selection (picks among *variants* of one message, not among *different* messages) and Braze Action Paths with Ranked Order (priority within one node). Mailery's Program (facts, eligibility, priority, `requires`, per-action attempt ladder, one send per tick) is therefore a **policy/priority model**, which the vendors lack. Vendors confirm the failure modes that a policy engine has to design out: capped sends silently skipped while the user still advances, entry evaluated once while eligibility changes later, goals defined by events rather than state, and re-entry windows that interact badly with in-flight journeys.

## 2. Per-vendor

### 2.1 Braze (Canvas)

**Model.** Journey graph. Canvas = entry config + steps (Message, Delay, Action Paths, Decision Split, Audience Paths, Experiment Paths, Audience Sync, Canvas Context/Variants). Per-user state = position in the graph, per Canvas.

```json
{
  "canvas": {
    "entry": { "type": "scheduled|action_based|api",
               "audience": "<segment+filters>",
               "reeligibility": { "allow": true, "windowSeconds": 259200 } },
    "exitCriteria": [ { "event": "purchase" } ],
    "frequencyCapping": "inherit|ignore",
    "rateLimit": { "perMinute": 10000 },
    "variants": [ { "name": "A", "steps": [] } ],
    "conversionEvents": [ { "event": "purchase", "window": "7d" } ]
  }
}
```

- **Entry:** users must match the target audience *before* the trigger is evaluated (except change-in-attribute triggers) - a trigger alone does not guarantee entry. Entry caps (max entries) exist.
- **Re-eligibility:** off by default (one entry per user ever). Tied to *entry*, not receipt. Window shorter than Canvas duration permits overlapping journeys; window 0 permits re-entry without exiting. Braze separately names "re-entry" (concurrent path while inside) vs "re-eligibility" (after exit). Source: braze.com/docs/user_guide/messaging/messaging_fundamentals/re_eligibility
- **Exit criteria:** event/audience conditions that eject a user at any step. Docs warn about entry and exit on the same event ("Matching entry and exit criteria", troubleshooting page).
- **Branching:** Decision Split = binary, mutually exclusive. Action Paths = wait up to an evaluation window (default 1 day, max 31) for actions; with Ranked Order off, first event wins, else "Everyone Else" after the window. Audience Paths = segment-based groups plus "Everybody Else". Source: braze.com/docs/user_guide/messaging/canvas/canvas_components
- **Frequency capping:** global and per-channel rules (push/email/SMS/webhook; not in-app or Content Cards). Counted by **calendar day in the user's timezone**, not rolling 24h. **A user over the cap at a Message step does not receive that send but still advances to the next step.** Control-group members do not count toward caps. Canvas-level *delivery-speed* rate limit applies to the whole Canvas, not per step. Source: braze.com/docs/user_guide/messaging/messaging_fundamentals/frequency_capping and .../rate-limiting
- **Intelligent Selection:** bandit over *variants of one message/step*; requires a conversion event; stops when it is 95% confident more testing can't lift conversion >1% relative ("regret"); winner then gets 100%. Not allowed with re-eligibility <24h; re-entering users may get a different variant. Source: braze.com/docs/user_guide/brazeai/intelligence_suite/intelligent_selection
- **Intelligent Timing:** per-user send-time model **(unverified, not fetched)**.
- **Arbitration:** none first-class. Cross-Canvas priority does not exist as far as I could verify **(unverified)**; capping is the only cross-Canvas lever, and it is first-come-first-served.

### 2.2 Customer.io (Campaigns / Journeys)

**Model.** Campaign = trigger + workflow graph; trigger is event OR segment membership (entering a segment). Segments are data-driven (auto-updating) or manual (static).

```json
{
  "campaign": {
    "trigger": { "type": "segment|event|date", "segmentId": 12, "filters": [] },
    "frequency": { "reenter": "once|every_time|after", "intervalDays": 7 },
    "goal": { "event": "connected_shopify" },
    "exitCriteria": "stop_matching|goal_met|goal_or_stop_matching|never",
    "steps": []
  }
}
```

- Exit options (from a third-party help page quoting the UI; **secondary**): default is *exit when person stops matching the trigger segment/filters*; alternatives are exit on goal, goal OR stop-matching, never. The same source warns "goal OR stop matching" is unpredictable for event-triggered campaigns since the event condition never un-matches.
- **Goals** are optional and are primarily a *measurement* concept that can double as an exit condition. Source: docs.customer.io/journeys/campaigns-in-customerio/ and docs.customer.io/journeys/campaign-triggers/
- Re-entry: configured per campaign (once / repeat with interval). Customer.io's own blog notes re-entry is a deliberate choice (leave and rejoin a segment can re-trigger).
- Throttling/cross-campaign suppression: not verified from official pages **(unverified)**; I recall per-message "don't send if sent in last N" style checks and subscription topics, not a global arbiter.
- Key idea worth stealing: **segment-as-state trigger with "exit when no longer matching."** That is closest to Program semantics, because the condition is state, not an event.

### 2.3 Iterable (Journeys)

**Model.** Journey canvas of tiles (trigger, filter/split, wait, email/push/SMS, update user, exit). Entry by list/segment/event/API.

- **Journey entry limits** (community product update): control entry when the user is already in another journey: allow regardless / block if in *any* other journey / block if in *selected* journeys. This is the only vendor feature I found that is explicit cross-journey mutual exclusion, and it is coarse (binary, no priority). Source: community.iterable.com/product-updates/new-options-for-journey-entry-limits-1204
- **Frequency Management:** caps per channel/message type per period; resets in project timezone; transactional exempt; per-campaign bypass; **Frequency Optimization** is an AI add-on that sets per-user volume from engagement history (needs CSM) (support.iterable.com/hc/articles/15342990564372, iterable.com/blog/winter-release-2024-ai-insights/).
- **Send Time Optimization:** per-tile, window 6-24h from tile arrival; user waits in the tile; with thin history, sends immediately. Disabling a journey does **not** cancel queued STO sends (support.iterable.com/hc/articles/5737633468564).
- **Experiments:** A/B on campaigns with holdout and optional multi-armed bandit to maximise opens/clicks/conversions (support.iterable.com/hc/en-us/articles/205480325).
- **Brand Affinity:** Winter 2024 AI feature scoring user-brand affinity from engagement **(unverified detail)**.
- Goals/exit-on-goal in Iterable journeys: not verified **(unverified)**.

### 2.4 Klaviyo (Flows)

**Model.** Trigger (metric / list / segment / date property) + trigger filters + profile (flow) filters + graph of actions.

```json
{
  "flow": {
    "trigger": { "type": "metric|list|segment|date", "filters": [] },
    "reentry": "none|always|after_period",
    "profileFilters": [ "evaluated at entry AND before every email" ],
    "smartSending": { "perChannelWindowHours": "N (unverified)" }
  }
}
```

- **Profile filters run at entry and again before each email**: stops sending to people who no longer qualify. This is the single best "re-check eligibility at send time" pattern in the set. Source: help.klaviyo.com/hc/en-us/articles/115002779051
- Re-entry is a first-class trigger setting (one-time / whenever re-qualify / after min period); list and segment flows default to no re-entry and only fire on *organic membership change*. Replaced older "has not been in flow in X days" filters (secondary: ecommercebadassery Jan 2026 roundup).
- **Smart Sending:** per-channel window that suppresses a send if the profile got another message recently, across flows and campaigns. Skip semantics and window lengths **unverified**.
- Overlap between flows is solved by community convention (conditional split on "has received email X") i.e. manual, not by the platform (community.klaviyo.com ... multiple flows fire on the same person).

### 2.5 Intercom (Series)

**Model.** Series = entry rules + canvas of rule blocks / wait / message blocks / exit rules. All sources here are community posts (**secondary**).

- Entry rules checked on login/visit, else hourly; mid-path rule blocks evaluated about every 15 min. Wait block after entry to delay the first message.
- Ordering between messages is by arrows ("if matched" chains, "if not matched" skips) or by pointing several messages at the entry rule so they fire in any order.
- Exit rules exist; a goal in Series was not found **(unverified)**. A ~1 min minimum between outgoing messages to a user was reported **(secondary, possibly outdated)**.
- Lesson: a Series is a **per-user checklist of messages gated by rules**, closer to Program than the others, but ordering is manual.

### 2.6 Others (brief)

- **Treasure Data / Hightouch / OneSignal / Simon (secondary):** Re-entry as an explicit 3-way enum: never / allow unless goal met / allow even if goal met (Treasure Data). Hightouch/Simon: entry-count caps combined with re-entry cooldown. Good vocabulary for a Program's "attempt" and "satisfied" semantics. Sources: docs.treasure.ai ... creating-a-real-time-journey; docs.simondata.com/docs/journey-settings-entry-criteria; hightouch.com/docs/customer-studio/journeys/create.
- **HubSpot, Vero, Loops, Encharge, Userlist:** not researched in this pass **(unverified)**. From memory only: Loops/Userlist/Encharge are event-triggered linear graphs with per-contact "enroll once" flags; HubSpot workflows add "suppression lists" and re-enrollment triggers. Treat as unconfirmed.

## 3. Comparison

| Engine | Core model | Entry | Goal / exit | Re-entry | Over-messaging control | Cross-journey arbitration |
|---|---|---|---|---|---|---|
| Braze Canvas | graph | audience + trigger | exit criteria events; conversion events for optimisation | off by default; window | global/channel caps (calendar day, user TZ); capped step skipped but user advances | none first-class; cap = first come |
| Customer.io | graph + segments | segment/event trigger | goal; exit on stop-match / goal / both / never | per-campaign interval | per-message checks (unverified) | unverified |
| Iterable | graph | list/segment/event | unverified | entry limits | project caps, Frequency Optimization (AI), STO | "block if in other journey" (binary) |
| Klaviyo | graph + filters | trigger + trigger filters | profile filters re-checked per email | enum in trigger | Smart Sending (per-channel window) | manual conditional splits |
| Intercom Series | graph of rule blocks | entry rules, hourly | exit rules; goal unverified | unverified | ~1 min cooldown (secondary) | none; manual ordering |
| Treasure Data | graph | segment | goal | never / unless goal met / always | n/a | n/a |
| **Mailery Program** | **policy over facts** | cadence tick | per-action `satisfiedWhen`, exhaustion | per-action | one send per tick, global cap | **built in: priority + requires** |

## 4. What this means for mailery Programs

**Graph vs policy.** Graph models break when a user is eligible for many things: you either build N journeys and hope caps sort it out, or one mega-canvas of Audience Paths ordered by hand. Policy models break when logic is order-dependent in time ("send A, then 3 days later B") and when you need non-obvious per-user copy sequencing. Hence: keep Flows for event-driven timelines, Program for "what next, given state."

**Recommendations**

1. **Evaluate state at send time, not at entry.** Klaviyo's profile filters (entry and pre-send) and Braze's "audience before trigger" show the pattern. A Program tick should: load facts, compute eligible set, pick one, then *re-verify* the chosen action's `satisfied`/`eligible` immediately before the actual send call (after rendering, before enqueue) to close the race with a slow job queue.
2. **Satisfaction is a state predicate, not an event.** Customer.io's "exit when stop matching" works; event-based goals break on missed events (webhook failed, user connected Shopify before the program existed). Define `satisfied(facts)` so it is true retroactively; an action satisfied on first evaluation records `skipped:already_satisfied`, not an attempt.
3. **Capped means "not chosen", never "silently advanced".** Braze's behavior (capped user still advances to the next step) would, in a Program, burn an attempt or exhaust the ladder without any email going out. Attempts must increment only on an actual accepted send, and cap/quiet-hour suppression must leave Program state unchanged (decision logged, retry next tick).
4. **One global arbiter per recipient, shared with Flows.** The vendor gap is that caps are the only cross-journey lever. Provide a per-recipient send ledger (collection with `recipient, channel, sentAt, source: {flow|program}, priority`) that the Program reads for: min gap since last marketing send, N per rolling window, quiet hours (recipient TZ), and "a Flow transactional/lifecycle send was recent". Decide explicitly whether Program yields to Flows or vice versa; Iterable's binary "block if in another journey" is the cautionary simple option. Prefer rolling windows to Braze's calendar-day counting, which allows two sends 2 hours apart across midnight.
5. **Arbitration = deterministic total order.** Sort eligible by `(priority desc, requiresDepth, lastAttemptAt asc, id)`; persist the *explanation* (considered, rejected-with-reason, chosen) per tick. Every vendor made "why didn't this user get X" a support burden (Braze has a whole troubleshooting page for it). The decision log is cheap and is the debuggability feature.
6. **Attempt ladder with exhaustion + cooldown.** Per `(account, action)` record `{attempts, lastSentAt, variantIndex, state: pending|satisfied|exhausted|snoozed, exhaustedAt}`. `exhausted` should expire or be resettable (Braze re-eligibility, Klaviyo "after period"): offer `cooldownDays` before the action can resurface with a fresh ladder, otherwise "exhausted" is permanent and unrecoverable. Escalating copy = variant index by attempt number, **not** random/bandit; Braze Intelligent Selection explicitly breaks on repeat entries (variant may change, <24h re-eligibility disallowed) so keep variant assignment deterministic and stored.
7. **`requires` is a DAG over actions; handle three states.** A dependency can be satisfied, exhausted, or pending. Decide whether an *exhausted* prerequisite blocks dependents forever (probably yes unless `requires: { any: [...] }` or `allowExhausted`). Validate acyclicity at definition time. Vendors have no equivalent, so there is no prior art to copy; treat this as a design risk.
8. **Idempotency and concurrent ticks.** Use an atomic Mongo claim per `(account, program, tickWindow)` (`findOneAndUpdate` on a lease field) so overlapping workers cannot double-send. Iterable's "disabling a journey doesn't cancel queued sends" is the same class of bug: define what happens to queued sends when an action becomes satisfied or the program is paused (re-check at dispatch).
9. **Measure conversion without a holdout? Don't.** Braze/Iterable both build control/holdout groups into optimisation. Add an optional `holdout: 0.05` per program (deterministic hash of account id) that evaluates and logs but never sends; otherwise you cannot tell whether nudges cause connections.
10. **Stop conditions at the account level.** Unsubscribe/suppression/bounce; "account churned/inactive"; and a program-level `maxSendsPerAccount` or `maxDurationDays`. Vendors have exit criteria on every canvas for exactly this.

**Pitfalls we would miss**

- Entry-time evaluation drift (condition true at entry, false at send) - handled by item 1.
- Same-event entry/exit loops (Braze docs warn) - in policy form: an action whose own send changes a fact it reads.
- Re-eligibility windows shorter than the cycle causing overlap (Braze) - Program has one state per action, so overlap cannot occur; do not add "parallel attempts".
- Timezone: caps and quiet hours must use recipient TZ, with fallback account TZ when unknown. Braze uses user TZ for caps; Iterable uses project TZ - pick one and document it.
- Cadence jitter: tick interval vs min-gap interplay - a user who fits the gap rule 1 minute after a tick waits a full cadence. Consider "next eligible at" scheduling rather than fixed polling.
- Fact staleness: facts come from integrations (Shopify/GA4 connect state). Stamp `factsAsOf` and refuse to send "connect Shopify" if the fact is older than a threshold.
- "Nothing eligible" is a normal outcome and should be recorded, not an error.
- Transactional/system mail must bypass Program caps (Iterable exempts transactional) but still be written to the ledger.

## 5. Sources

- Braze re-eligibility: https://www.braze.com/docs/user_guide/messaging/messaging_fundamentals/re_eligibility
- Braze frequency capping / rate limiting: https://www.braze.com/docs/user_guide/messaging/messaging_fundamentals/frequency_capping ; https://braze.com/docs/user_guide/engagement_tools/campaigns/building_campaigns/rate-limiting
- Braze Canvas components: https://www.braze.com/docs/user_guide/messaging/canvas/canvas_components
- Braze Intelligent Selection: https://braze.com/docs/user_guide/brazeai/intelligence_suite/intelligent_selection
- Braze troubleshooting: https://braze.com/docs/user_guide/messaging/canvas/troubleshooting/
- Customer.io: https://docs.customer.io/journeys/campaigns-in-customerio/ ; https://docs.customer.io/journeys/campaign-triggers/ ; (secondary) https://help.union.fit/en/articles/12160711-exit-conditions-in-customer-io
- Iterable: https://support.iterable.com/hc/articles/5737633468564 (STO) ; https://support.iterable.com/hc/en-us/articles/205480325 (experiments) ; https://community.iterable.com/product-updates/new-options-for-journey-entry-limits-1204 ; https://iterable.com/blog/winter-release-2024-ai-insights/
- Klaviyo: https://help.klaviyo.com/hc/en-us/articles/115002779051 ; https://help.klaviyo.com/hc/en-us/articles/360003040052
- Intercom (community, secondary): https://community.intercom.com/messages-series-11/why-there-isn-t-a-wait-time-on-the-entry-rule-block-of-a-series-2518
- Treasure Data: https://docs.treasure.ai/products/customer-data-platform/journey-orchestration/realtime/creating-a-real-time-journey
- Simon: https://docs.simondata.com/docs/journey-settings-entry-criteria
