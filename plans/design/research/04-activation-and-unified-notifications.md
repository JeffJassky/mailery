# 04 — Activation practice and unified notification infrastructure

Legend: [V] verified against a fetched/searched source this session; [K] from background knowledge, not re-verified; [?] unverified/inferred.

## 1. Takeaway

Good activation messaging is a *state machine over account facts*, not a drip calendar. The mature pattern: define a small ordered set of **milestones** (each a pure predicate over facts), show them as a checklist, and have every channel (checklist UI, email, push) read the **same milestone definitions** and the **same attempt ledger**. Poignancy comes from specificity (name the thing they did or did not do), one CTA aimed at the single next milestone, timing keyed to the user's last session, and hard stopping rules (max attempts, cooldown, sunset). Notification vendors (Knock, Novu, Courier) converge on one model: a *workflow* = ordered steps (channel steps, delay, batch/digest, throttle, condition) + per-recipient preferences + trigger-level idempotency. The vendors' weakest area is exactly what Programs need: they are event-triggered, not fact-polling "pick the next-best action" engines. Mailery's Program should be a **selector over milestones** that emits an *intent* ("nudge user toward milestone X"), with channel choice, preference checks and frequency policy applied downstream in one shared pipeline.

## 2. Part A — Activation practice

### A1. Defining the aha / activation milestone
- Standard practice [K]: find the behavior most correlated with week-N retention, then treat the shortest path to it as onboarding. Canonical (often-cited, unverified here) examples: Slack ~2,000 team messages; Dropbox first file in a synced folder; Facebook 7 friends in 10 days. Treat the numbers as folklore [?]; the method (retention-correlated threshold) is the lesson.
- Per-product guess for maxmarketing.ai [?]: activation = *a data source connected AND first insight/report delivered*; "agent connected (MCP)" and "playbook run" are depth milestones, "business context added" is a quality-of-output enabler.

### A2. Company notes (all [K] unless marked)
- **Duolingo**: notification system is the most documented. KDD 2020 paper "A Sleeping, Recovering Bandit Algorithm for Optimizing Recurring Notifications" (Yancey & Settles) [V]: each notification *template* is an arm; arms are "sleeping" (eligibility criteria per user) and "recovering" (reward decays when a template was sent recently, novelty/fatigue); reported +0.5% DAU and +2% new-user retention [V]. Secondary write-ups say they refuse to raise send volume without strong justification ("protect the channel") [V, third-party]; job listing mentions an "omnichannel" unified messaging system [V, via search summary]. Lessons: eligibility predicate per template; recency-aware suppression of the *same* message; measure by retention, not opens.
- **Noom** [K]: heavily behavioral; in-app task cards + push/email keyed to logged meals/weigh-ins; streak and "you're X% through" progress framing.
- **Slack/Notion/Dropbox/Linear** [K]: in-product checklist/"getting started" + a few lifecycle emails; emails reference concrete team state ("3 teammates haven't joined"), CTA deep-links to the exact unfinished step. Dropbox's classic checklist-with-storage-reward is the origin of "progress + reward" framing.
- **Grammarly/Superhuman** [K]: Superhuman uses high-touch onboarding + a "tips" cadence tied to usage; Grammarly sends weekly *personal insight* emails (their own stats) — poignancy via the user's own data. Directly applicable: maxmarketing could send "your data says X" once connected.
- **Calendly/Stripe/Shopify** [K]: Stripe and Shopify gate on setup checklists (verify account, add product, first payment); emails fire on *incomplete setup step* and name it. Calendly nudges "share your link" after calendar connect.

### A3. What makes nudges poignant vs spammy
1. **Behavioral trigger, not elapsed time**: send because a predicate holds ("source connected, no business context") not "day 3".
2. **One CTA, one milestone**, deep-linked; email body names the exact unfinished thing.
3. **Specific + progress-framed**: "2 of 4 done; one step left unlocks X".
4. **Timing relative to last session**: not within minutes of an active session (in-app is enough), and not days stale; send in recipient-local waking hours.
5. **Stopping rules**: per-milestone max attempts (e.g. 3), exponential cooldown, stop when predicate flips true, global cap, and **sunset**: after N unanswered attempts with no opens/sessions, drop to a monthly low-frequency track, then stop (sunset practice: ~90–180 days inactivity then re-engage then suppress [V, generic blogs]; slowing cadence before suppressing [V, Klaviyo community]).
6. **Rotate copy** for repeated asks (Duolingo's recovery effect).

### A4. Sketch: milestone + attempt ledger
```jsonc
// milestone = pure predicate over facts
{ "id": "connect_source", "order": 1, "done": {"fact":"sources.connectedCount","gte":1}, "weight": 10 }
{ "id": "add_context",   "order": 2, "requires": ["connect_source"], "done": {"fact":"context.completeness","gte":0.6} }
// attempt ledger (one row per send/show)
{ "program":"activation","subject":"acct_1","milestone":"add_context","channel":"email",
  "seq":2,"at":"2026-10-07T14:00Z","outcome":"sent|opened|clicked|completed|suppressed" }
```

## 3. Part B — Notification infrastructure

### B1. Knock [V via docs search]
- Workflow = ordered **steps**: channel steps (email, in-app feed, push, SMS, chat) and **functions** (delay, batch, throttle, fetch, branch, wait-for-event).
- Every step may carry **conditions**, evaluated at run time; false = skip to next. Trigger-level conditions halt the whole run. Conditions can read message status, so "email only if the in-app message was not read/seen" is native. Delay supports fixed, dynamic, relative-timestamp. Batch groups triggers by a batch key over a window (e.g. 1h of comments → one email; returns counts for all but detail for only 10 items). Throttle limits runs per recipient per window. Preferences: recipient sets per channel type, per workflow, per category.
- https://docs.knock.app/designing-workflows/step-conditions , /throttle-function , /delay-function , /wait-for-event-function
```jsonc
{ "key":"activation-nudge","categories":["lifecycle"],
  "steps":[
   {"type":"throttle","key":"user","window":"3d","limit":1},
   {"type":"in_app_feed","template":"nudge"},
   {"type":"delay","duration":{"unit":"hours","value":24}},
   {"type":"email","template":"nudge","conditions":[{"if":"message.in_app.not_seen"}]} ] }
```

### B2. Novu [V]
- Workflow with steps in_app / email / push / sms / chat / **delay** / **digest** / custom. Documented fallback: in-app → delay 24h → condition "in-app unread" → email (https://docs.novu.co/guides/use-cases/multi-channel-fallback). Digest: one digest step per workflow; collects events per subscriber and fires downstream once per window. Preferences: subscriber channel opt-outs applied automatically; workflow `readOnly` hides toggles; `critical` (reported via a third-party skill file [?]) bypasses prefs/digest/delays.
- https://docs.novu.co/platform/workflow/delay
- Gotcha [V]: if a delay step fails the workflow stops.

### B3. Courier, MagicBell, OneSignal, Customer.io [K, not re-verified]
- **Courier**: "Automations" (send, delay, fetch, branch, throttle, cancel by key) separate from "Notifications" (templates); **routing** object: `method: "single" | "all"`, ordered `channels` → "single" tries channels in order until one succeeds (delivery-level fallback, not engagement-level). Preferences by "topic/subscription topic" with status OPTED_IN/OPTED_OUT/REQUIRED and default channels.
- **MagicBell**: inbox-first; per-category channel preferences; fallback-to-email if inbox unread via delayed channel config; digests.
- **OneSignal Journeys**: visual graph; wait, wait-until-event, conditional split, send; exit criteria; per-journey re-entry rule.
- **Customer.io**: campaigns with trigger (event/segment), **exit conditions**, **goals** (conversion event stops the campaign), frequency caps / "do not send more than N per period", suppression lists, subscription topics, quiet hours ("delivery window"). Goals + exit conditions are the closest match to Program "stop when milestone done".

### B4. Cross-vendor data model (distilled)
```jsonc
{ "definition": {                      // ONE definition
    "key":"activation.nudge","category":"lifecycle","critical":false,
    "content":{"title":"…","body":"…","cta":{"label":"…","url":"…"},"channelOverrides":{"email":{"subject":"…"}}},
    "routing":{"strategy":"escalate","steps":[{"channel":"in_app"},{"channel":"email","after":"24h","if":"!seen"}]},
    "policy":{"throttle":{"window":"3d","limit":1},"quietHours":"recipient-local 21:00–08:00","digest":null},
    "idempotencyKey":"{subject}:{milestone}:{seq}" },
  "preferences": {"subject":"user_1","categories":{"lifecycle":{"email":true,"in_app":true,"push":false}},"globalUnsub":false} }
```
Key points: idempotency is by trigger key per recipient (Knock/Novu accept a transaction/trigger id [K]); templates are per channel under one definition; preferences resolve at *send time*, not enqueue time.

## 4. Part C — In-app checklist vendors

- **Appcues** [V]: checklist items complete on conditions; an Event condition requires the user to have fired that tracked event (`Appcues.track()`); troubleshooting guide says check Events Explorer. Account-level completion (any teammate completes for all) is not native — workaround sets a group property [V; native support unconfirmed]. `checklist_completed` analytics event exists. https://docs.appcues.com/checklists/troubleshooting-checklists , https://docs.appcues.com/create-checklist-items-that-can-be-completed-by-any-accoun
- **Userpilot, Chameleon, Pendo, Intercom** [K]: same pattern — item completes by (a) clicking the item, (b) a tracked event, or (c) a segment/property condition; Intercom/Pendo can trigger email via a "checklist item not completed after N days" audience. Userpilot/Chameleon support "auto-complete if condition already true" (no re-showing finished steps).
- The vendors' tension: checklist completion lives in the UX tool, email lives in the ESP, so two "is it done?" truths drift. Mailery can avoid this by making *facts → milestone predicate* the single truth and letting the checklist UI be a read-only renderer.
```jsonc
// shared definition
{ "program":"activation","items":[
  {"id":"connect_source","title":"Connect a data source","done":{"fact":"sources.connectedCount","gte":1},"cta":"/settings/sources",
   "nudge":{"email":{"template":"connect-source","maxAttempts":3,"cooldown":"3d"},"in_app":{"surface":"checklist"}}} ]}
// checklist API = GET /programs/activation/state?subject=acct_1 → [{id,done,nextAction:bool,attempts}]
```

## 5. Design implications for mailery Programs

1. **Channel-on-attempt vs channel-on-action.** Recommend modelling the Program tick as producing an *Attempt intent* ({milestone, seq}) and a **channel plan** attached to the attempt (in_app now; email if still not seen after X). The decision "which channel" is made at attempt time from policy + preferences + presence (active session ⇒ in-app only). Per-*action* channels (e.g. a milestone permanently tied to email) should be an override, not default. Escalation reuses the same attempt id (one attempt, multiple deliveries) so counts toward `maxAttempts` once, not per channel. Knock/Novu model this as steps with message-status conditions; for mailery, store `deliveries[]` under the attempt.
2. **Preferences and unsubscribe scoping.** Scope unsubscribe at *category* × channel (e.g. `lifecycle.onboarding` email), plus a global-per-channel off and a global-off. Programs declare `category`; transactional/critical categories ignore prefs (but not legal one-click unsub on marketing). Resolve at send time. A "stop onboarding tips" link should set category-level opt-out, not global. Persist preference changes with source (link, UI, complaint).
3. **Sunsetting.** Track `unansweredAttempts` (attempts since last engagement signal: any session, click, or milestone progress) per subject per program. Ladder: normal cadence → slowed cadence after K unanswered → single "should we stop?" message → suppress program for subject until a new engagement event (re-entry on session or fact change). Sunset is a Program-level policy field with a global default.
4. **Shared definition for checklist + email.** One `milestones[]` list keyed by id with `done` predicate over facts; checklist renders from it; the email selector picks the first not-done milestone whose `requires` are satisfied and whose attempt budget remains. Emit a `milestone.completed` event once (idempotent by subject+milestone) so exit conditions/goals fire everywhere. Completion is derived, never stored as the only truth (store a monotonic `completedAt` cache so a later regression of a fact does not un-complete UI).
5. **Quiet hours and frequency across all programs.** Put frequency policy outside any single Program: a central pipeline stage with (a) per-recipient per-channel caps (e.g. ≤1 lifecycle email/day, ≤3/week), (b) quiet hours in recipient timezone (fall back to account tz, then default send window), (c) priority ordering so a billing/security message wins and an activation nudge defers rather than drops. Deferral needs a `notBefore` + expiry (don't send a stale "connect your source" tomorrow if now done—re-evaluate predicate at send time).
6. **Idempotency.** Key = `program:subject:milestone:seq`; re-evaluating on each tick must not double-send; unique index in Mongo on that key.
7. **Eligibility ≠ priority.** Follow Duolingo: per-template eligibility predicates plus recency penalty; start with deterministic first-incomplete-milestone, leave a hook for a scorer.

## 6. Pitfalls
- Two sources of truth for "done" (UI vs email) → nagging users about finished steps. Re-check predicate immediately before send.
- Cadence calendars in disguise: "wait 3 days" steps ignore behavior.
- Counting attempts per channel instead of per intent → effective frequency multiplies.
- Preferences resolved at enqueue; user unsubscribes during a delay and still gets mail.
- Digest/batch semantic mismatch: Novu allows one digest step per workflow [V]; a delay failure halts the workflow [V]; design failure policy (skip vs halt) explicitly.
- Account vs user scope: B2B checklists complete at account level (Appcues has no native support [V-ish]); decide subject (account) vs recipient (user) early; avoid emailing 5 teammates the same nudge.
- Open-rate as engagement signal for sunsetting is unreliable (Apple MPP) [K]; prefer clicks/sessions/fact changes.
- Timezone/DST math for quiet hours; store IANA tz.
- Optimizing sends for opens rather than retention (Duolingo measured DAU/retention [V]).
- Over-reaching generalisation: vendor details in B3 are from memory and should be re-checked before copying field names.

## Sources
- https://research.duolingo.com/papers/yancey.kdd20.pdf
- https://paperswithcode.com/paper/a-sleeping-recovering-bandit-algorithm-for
- https://vicki.substack.com/p/duo-the-push-and-the-bandits (third-party)
- https://docs.knock.app/designing-workflows/step-conditions
- https://docs.knock.app/designing-workflows/throttle-function
- https://docs.knock.app/designing-workflows/delay-function
- https://docs.knock.app/designing-workflows/wait-for-event-function
- https://docs.novu.co/guides/use-cases/multi-channel-fallback
- https://docs.novu.co/platform/workflow/delay
- https://docs.appcues.com/checklists/troubleshooting-checklists
- https://docs.appcues.com/create-checklist-items-that-can-be-completed-by-any-accoun
- https://help.klaviyo.com/hc/en-us/articles/360017518492-How-to-create-a-sunset-flow
