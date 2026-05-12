# Direct DB Cookbook

Advanced reference: configuring mailer by reading and writing MongoDB documents directly. Useful when you want to script a flow change, manage templates from infrastructure-as-code, or wire mailer into a deploy pipeline. For day-to-day use, the admin UI (`09-admin-ui.md`) and public API (`10-public-api.md`) are easier.

This file is self-contained — point any operator or script at it and it has what they need.

---

## What mailer is

Mailer is an embedded email automation library running inside a host SaaS app. It uses MongoDB collections for all of its state. Configuring mailer can mean three things:

- Calling `mailer.fire()` and friends from host code (`10-public-api.md`)
- Clicking through the admin UI (`09-admin-ui.md`)
- Reading and writing MongoDB documents directly — this file

The third path is the lowest-level. Mailer's data model is small and documented (`02-data-model.md`), so direct writes are a legitimate way to manage flows and templates from migration scripts, deploy hooks, or one-off operator commands.

---

## Your toolkit

Read and write access to MongoDB collections prefixed `mailer_`. The host app's `users` collection is typically also available — treat it as read-only (host owns user identity; mailer reads through an adapter; follow the same convention from scripts).

Write to the audit log to mark direct-DB actions so a human reviewer can see what happened.

---

## The collections (cheat sheet)

| Collection | Purpose | You commonly do |
|---|---|---|
| `mailer_subscriptions` | Consent / list membership per externalId | **Read** to check if a contact is subscribed |
| `mailer_events` | Behavioral event history | **Read** to understand a contact's journey or build segments |
| `mailer_flows` | Flow definitions | **Read** + **Write** — your main configuration target |
| `mailer_flow_versions` | Append-only snapshots of published flow versions | **Read** only (system-managed) |
| `mailer_flow_runs` | Active state for each contact's journey | **Read** for diagnostics — don't write |
| `mailer_templates` | Email templates | **Read** + **Write** — your main content target |
| `mailer_template_versions` | Append-only snapshots | **Read** only |
| `mailer_sends` | Every send + lifecycle | **Read** for analytics — never write |
| `mailer_suppressions` | Do-not-send list | **Read** to understand; **write** sparingly + audit |
| `mailer_broadcasts` | One-off campaigns | **Read** + **Write** — schedule, edit drafts |
| `mailer_leads` | Pre-user signups | **Read** for reporting |
| `mailer_audit_log` | Every mutation | **Read** to see history; **write** when you mutate |
| `mailer_health` | Circuit breaker state | **Read** — never write (use admin UI) |
| `mailer_outbox` / `mailer_webhook_events` | Operational | **Never touch** |
| `mailer_contact_tags` | Tag values (fallback only — see Tags section) | Routed via `mailer.tag()`; don't direct-write |

The host's `users` collection is what `Contact` data ultimately comes from. **Read-only.**

---

## Core operations

### Read a contact's full state

```js
// Given an email or externalId, gather everything mailer knows.
const email = 'user@example.com'

const sub = await db.collection('mailer_subscriptions').findOne({
  emailAtSubscribe: email,
})
const externalId = sub?.externalId

const events = await db.collection('mailer_events')
  .find({ externalId }).sort({ occurredAt: -1 }).limit(50).toArray()

const sends = await db.collection('mailer_sends')
  .find({ externalId }).sort({ sentAt: -1 }).limit(50).toArray()

const flowRuns = await db.collection('mailer_flow_runs')
  .find({ externalId }).sort({ enteredAt: -1 }).toArray()

const suppressions = await db.collection('mailer_suppressions')
  .find({ email }).toArray()

// Contact identity / fields — read through the adapter's source collection (usually 'users')
const user = await db.collection('users').findOne({ email })
```

Use this pattern when answering "what happened to this contact?" or "why did/didn't they get email X?"

### List all flows

```js
const flows = await db.collection('mailer_flows')
  .find({})
  .project({ slug: 1, name: 1, enabled: 1, trigger: 1, goal: 1, version: 1, 'stats.activeRuns': 1 })
  .toArray()
```

### Read a specific flow's full definition (current + draft)

```js
const flow = await db.collection('mailer_flows').findOne({ slug: 'activation-rescue' })
console.log(flow.steps)        // currently live
console.log(flow.draft?.steps) // working draft (may be null)
```

### Edit a flow draft

```js
const flow = await db.collection('mailer_flows').findOne({ slug: 'activation-rescue' })

// Start from current live steps (or existing draft)
const newSteps = [
  ...(flow.draft?.steps ?? flow.steps),
]

// Insert a new send step after step 2
newSteps.splice(3, 0, {
  type: 'send',
  templateSlug: 'activation-rescue-day-4',
})

await db.collection('mailer_flows').updateOne(
  { slug: 'activation-rescue' },
  {
    $set: {
      'draft.steps': newSteps,
      'draft.lastModifiedBy': 'script:operator',
      'draft.lastModifiedAt': new Date(),
      'draft.notes': 'Added a day-4 follow-up step',
      updatedAt: new Date(),
    },
  },
)

// IMPORTANT: also audit
await db.collection('mailer_audit_log').insertOne({
  actor: 'script:operator',
  action: 'flow.draft.update',
  resource: { collection: 'mailer_flows', id: flow._id, slug: 'activation-rescue' },
  before: { steps: flow.draft?.steps ?? flow.steps },
  after: { steps: newSteps },
  diffSummary: 'Inserted activation-rescue-day-4 send at index 3',
  occurredAt: new Date(),
})
```

Edits **always** go into `draft.*`. Never write directly to `flow.steps`. The draft is your working copy; publishing promotes it.

### Publish a flow draft

```js
const flow = await db.collection('mailer_flows').findOne({ slug: 'activation-rescue' })
if (!flow.draft?.steps) throw new Error('no draft to publish')

const nextVersion = flow.version + 1
const now = new Date()

// 1. Snapshot the about-to-be-published version
await db.collection('mailer_flow_versions').insertOne({
  flowId: flow._id,
  version: nextVersion,
  steps: flow.draft.steps,
  trigger: flow.trigger,
  publishedAt: now,
  publishedBy: 'script:operator',
})

// 2. Promote draft to live
await db.collection('mailer_flows').updateOne(
  { _id: flow._id },
  {
    $set: {
      steps: flow.draft.steps,
      version: nextVersion,
      publishedAt: now,
      publishedBy: 'script:operator',
      draft: null,
      updatedAt: now,
    },
  },
)

// 3. Audit
await db.collection('mailer_audit_log').insertOne({
  actor: 'script:operator',
  action: 'flow.publish',
  resource: { collection: 'mailer_flows', id: flow._id, slug: flow.slug },
  diffSummary: `Published v${nextVersion}`,
  occurredAt: now,
})
```

This sequence is atomic for newly-entering contacts (they get the new version) but in-flight runs continue on their pinned `flowVersion` from `mailer_flow_versions`.

### Edit a template draft

```js
const tmpl = await db.collection('mailer_templates').findOne({ slug: 'activation-rescue-day-1' })

await db.collection('mailer_templates').updateOne(
  { slug: tmpl.slug },
  {
    $set: {
      'draft.subject': 'Quick check: did StoryFolder install OK?',
      'draft.preheader': '30-second walkthrough if anything got stuck.',
      'draft.mjml': `<mjml>
        <mj-body>
          <mj-section>
            <mj-column>
              <mj-text>Hi {{contact.fields.firstName}},</mj-text>
              <mj-text>I saw you downloaded StoryFolder yesterday but haven't connected your account yet...</mj-text>
              <mj-button href="https://storyfolder.com/help/getting-started/connect-account">
                Open the walkthrough
              </mj-button>
              <mj-text>
                — Jeff<br/>
                <a href="{{unsubscribeUrl}}">Unsubscribe</a>
              </mj-text>
            </mj-column>
          </mj-section>
        </mj-body>
      </mjml>`,
      'draft.notes': 'Tightened the opening line, replaced two-paragraph intro with one.',
      'draft.lastModifiedBy': 'script:operator',
      'draft.lastModifiedAt': new Date(),
      updatedAt: new Date(),
    },
  },
)

await db.collection('mailer_audit_log').insertOne({
  actor: 'script:operator',
  action: 'template.draft.update',
  resource: { collection: 'mailer_templates', id: tmpl._id, slug: tmpl.slug },
  diffSummary: 'Tightened subject + intro paragraph',
  occurredAt: new Date(),
})
```

Template MJML doesn't compile until publish. If your MJML is invalid, the publish operation will fail. Test by issuing a send-test through the admin UI before publishing, or by validating the MJML offline.

### Publish a template draft

```js
const tmpl = await db.collection('mailer_templates').findOne({ slug: 'activation-rescue-day-1' })
if (!tmpl.draft?.mjml) throw new Error('no draft to publish')

// You can't compile MJML yourself from this side. Two options:
// A) Call the library's helper: mailer.templates.publish(slug)
//    — this handles compilation + plain-text derivation + audit
// B) If you have direct DB access only, leave draft in place and ask a human to publish via admin UI.

// Option A is preferred. Wrap it in your deploy script:
await mailer.templates.publish('activation-rescue-day-1')
```

The library's `templates.publish()` is the safest path. Direct DB write requires you to compile MJML to HTML and derive plain text yourself — error-prone.

### Create a new flow

```js
const slug = 'commercial-creator-onboarding'

await db.collection('mailer_flows').insertOne({
  slug,
  name: 'Commercial Creator Onboarding',
  description: 'Tailored 3-email sequence for new signups whose customerType is in the commercial bucket.',
  trigger: {
    type: 'event',
    eventName: 'Created',
    once: true,
  },
  enabled: false,  // start disabled; enable after review
  steps: [],
  version: 0,
  draft: {
    steps: [
      // First, gate on customerType so this flow only applies to the target audience
      {
        type: 'condition',
        test: {
          fieldIn: {
            field: 'customerType',
            value: ['commercials & ads', 'social content', 'corporate videos'],
          },
        },
        ifFalse: 'exit',
      },
      { type: 'send', templateSlug: 'commercial-welcome' },
      { type: 'wait', value: 3, unit: 'days' },
      { type: 'send', templateSlug: 'commercial-pro-features' },
      { type: 'wait', value: 4, unit: 'days' },
      { type: 'send', templateSlug: 'commercial-case-study' },
    ],
    notes: 'Initial draft. Audience-gated via customerType field.',
    lastModifiedBy: 'script:operator',
    lastModifiedAt: new Date(),
  },
  goal: 'activation',
  audience: 'New signups whose customerType is commercial, social, or corporate video.',
  expectedVolumePerWeek: 30,
  stats: { activeRuns: 0, completedRuns: 0, sendsTotal: 0, sendsLast7Days: 0 },
  publishedAt: null,
  publishedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
})

await db.collection('mailer_audit_log').insertOne({
  actor: 'script:operator',
  action: 'flow.create',
  resource: { collection: 'mailer_flows', slug },
  diffSummary: 'Created new flow (disabled, draft only)',
  occurredAt: new Date(),
})
```

Common mistakes to avoid:
- Don't enable a new flow on creation. Always start `enabled: false`, then review, then enable separately.
- Don't write directly to `steps`. Use `draft.steps` and publish to promote.
- Make sure all `templateSlug` references point to templates that exist.

### Build a segment definition

Used by broadcasts and `segment_enter` flow triggers.

```js
// "Customers in commercial buckets who haven't viewed a storyboard in 30 days"
const segment = {
  filters: [
    { kind: 'subscriptionStatus', equals: 'subscribed' },
    { kind: 'hasTag', tag: 'Customer' },
    { kind: 'fieldIn', field: 'customerType', values: ['commercials & ads', 'social content', 'corporate videos'] },
    { kind: 'notFiredEvent', eventName: 'Viewed Storyboard', withinDays: 30 },
  ],
}

// Validate by counting:
const count = await mailer.segments.count(segment)
console.log(`segment size: ${count}`)
```

### Schedule a broadcast

```js
// Recommended path: programmatic API
await mailer.scheduleBroadcast({
  templateSlug: 'monthly-newsletter',
  segmentDefinition: { filters: [{ kind: 'subscriptionStatus', equals: 'subscribed' }] },
  scheduledAt: new Date('2026-06-01T15:00:00Z'),
  name: 'June Newsletter — Commercial Creator Edition',
  createdBy: 'script:operator',
})
```

If you're working from direct DB only and have to write to `mailer_broadcasts` manually:

```js
await db.collection('mailer_broadcasts').insertOne({
  slug: 'june-newsletter-commercial',
  name: 'June Newsletter — Commercial Creator Edition',
  templateSlug: 'monthly-newsletter',
  segmentDefinition: { /* ... */ },
  status: 'draft',     // not 'scheduled' until human approval
  scheduledAt: new Date('2026-06-01T15:00:00Z'),
  startedAt: null,
  completedAt: null,
  confirmationRequired: true,
  confirmedCount: null,
  confirmedAt: null,
  confirmedBy: null,
  recipientCount: null,
  stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
  createdAt: new Date(),
  createdBy: 'script:operator',
  updatedAt: new Date(),
})

await db.collection('mailer_audit_log').insertOne({
  actor: 'script:operator',
  action: 'broadcast.draft.create',
  resource: { collection: 'mailer_broadcasts', slug: 'june-newsletter-commercial' },
  occurredAt: new Date(),
})
```

**Always leave broadcasts in `status: 'draft'` for human review.** Don't set `status: 'scheduled'` programmatically — that triggers the send.

### Diagnose: why didn't this contact get an email?

Most common diagnostic question. Walk through this checklist:

1. **Are they subscribed?**
   ```js
   const sub = await db.collection('mailer_subscriptions').findOne({ externalId })
   // status should be 'subscribed' for marketing
   ```

2. **Are they suppressed?**
   ```js
   const supp = await db.collection('mailer_suppressions').find({ email }).toArray()
   // any active row blocks sends matching its scope
   ```

3. **Did the triggering event fire?**
   ```js
   const evt = await db.collection('mailer_events').findOne({ externalId, name: 'Downloaded app' })
   // if null, the flow can't have entered
   ```

4. **Was a flow_run created?**
   ```js
   const run = await db.collection('mailer_flow_runs').findOne({ externalId, flowSlug: 'activation-rescue' })
   // if null, either flow is disabled or the contact was already in it
   ```

5. **Where is the flow_run?**
   ```js
   console.log(run.status)                  // 'active' | 'exited' | 'completed' | 'failed'
   console.log(run.currentStepIndex)        // which step it's on
   console.log(run.nextActionAt)            // when it will next be processed
   console.log(run.history)                 // step-by-step audit
   console.log(run.exitReason)              // if exited
   ```

6. **Did any sends happen?**
   ```js
   const sends = await db.collection('mailer_sends').find({ flowRunId: run._id }).toArray()
   // for each: check status, errorMessage
   ```

This pipeline covers 95% of "why no email" questions.

---

## Tags: the right way

You can see `contact.tags` everywhere through the adapter. **Do not write to `user.tags` (or wherever tags live) directly, even if you can.**

Instead, use the library:

```js
await mailer.tag(externalId, 'commercial-creator')
await mailer.untag(externalId, 'cold')
```

The library routes through the adapter (if it has `addTags` / `removeTags`) or to mailer's own `mailer_contact_tags` collection (if it doesn't). Storage is swappable; the API is stable.

Within a flow:

```js
{ type: 'tag', addTags: ['onboarded'], removeTags: ['new-signup'] }
```

---

## Suppression: handle with care

Adding to `mailer_suppressions` is irreversible from the user's perspective (within reason). Be very careful with `scope: 'all'` — that includes transactional, so they won't get password resets.

Common safe additions:
- `scope: 'marketing'` when a user has expressed they don't want marketing
- `scope: 'all'` only when you have direct evidence (e.g. they emailed support saying "stop everything")

Prefer the API helper:

```js
await mailer.suppress('user@example.com', {
  scope: 'marketing',
  reason: 'manual',
  source: 'support:ticket-456',
  notes: 'User replied to a marketing email asking to be removed',
})
```

This handles edge cases (existing entries, audit log, subscription status update).

---

## Things you should never do

| Don't | Why |
|---|---|
| Write directly to `mailer_sends` | This is the send log — only the runner / webhook handler should write here |
| Edit `mailer_flow_runs` | Active state; manual changes can cause double-sends or stuck runs |
| Set a flow's `enabled: true` without human review on first run | Could send to thousands of contacts unexpectedly |
| Set a broadcast's `status: 'scheduled'` without confirmation | Same — triggers the send |
| Delete from `mailer_audit_log` | Append-only by convention; deletion looks like cover-up |
| Modify `mailer_subscriptions.status` directly to 'subscribed' | Bypass consent tracking; use `mailer.upsertSubscription()` |
| Write to the host's `users` collection | Not your data; use `mailer.tag()` for the one acceptable case |
| Touch `mailer_outbox`, `mailer_webhook_events`, `mailer_health` | Operational state; mailer manages these |
| Branch a flow on `hasOpened` or `hasClicked` | Open/click signals are too noisy (Apple MPP, bots). See INVARIANTS.md rule 7 |
| Skip the `dedupeKey` on `fire()` | Required for idempotency. The library will refuse |
| Bypass the broadcast confirmation gate for large sends | Don't set scheduled programmatically; leave as draft for human |

---

## Common configuration recipes

### Add a new email to an existing flow

```js
// 1. Read the flow
const flow = await db.collection('mailer_flows').findOne({ slug: 'pro-welcome' })

// 2. Create the new template first (so the reference is valid)
await db.collection('mailer_templates').insertOne({
  slug: 'pro-welcome-day-21',
  name: 'Pro Welcome — Day 21 — Power user check-in',
  description: 'Three weeks in, ask how they\'re finding the Pro features.',
  kind: 'marketing',
  fromName: 'Jeff Jassky',
  fromEmail: 'jeff@yourdomain.com',
  subject: 'How\'s your first three weeks with Pro?',
  preheader: 'Quick check-in. Reply with anything.',
  body: { mjml: '', html: '', plainText: '', compiledAt: null },
  draft: {
    subject: 'How\'s your first three weeks with Pro?',
    preheader: 'Quick check-in. Reply with anything.',
    mjml: `<mjml>...</mjml>`,
    notes: 'Founder check-in, plain voice. No CTA — replies are the goal.',
    lastModifiedBy: 'script:operator',
    lastModifiedAt: new Date(),
  },
  variablesSchema: {},
  trackOpens: true,
  trackClicks: true,
  tags: ['pro-welcome', 'check-in'],
  stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, lastSentAt: null },
  publishedAt: null,
  publishedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
})

// 3. Publish the template (call library helper)
await mailer.templates.publish('pro-welcome-day-21')

// 4. Update the flow draft to insert the new step
const newSteps = [
  ...flow.steps,
  { type: 'wait', value: 7, unit: 'days' },   // 7 days after the previous Day-14 send → day 21
  { type: 'send', templateSlug: 'pro-welcome-day-21' },
]

await db.collection('mailer_flows').updateOne(
  { _id: flow._id },
  {
    $set: {
      'draft.steps': newSteps,
      'draft.notes': 'Added day-21 check-in step',
      'draft.lastModifiedBy': 'script:operator',
      'draft.lastModifiedAt': new Date(),
      updatedAt: new Date(),
    },
  },
)

// 5. Audit
await db.collection('mailer_audit_log').insertOne({
  actor: 'script:operator',
  action: 'flow.draft.update',
  resource: { collection: 'mailer_flows', slug: flow.slug },
  diffSummary: 'Added day-21 check-in step (template pro-welcome-day-21)',
  occurredAt: new Date(),
})

// Done. A human reviews via the admin UI and publishes the flow draft to make it live.
```

### Analyze a flow's performance

```js
const flow = await db.collection('mailer_flows').findOne({ slug: 'activation-rescue' })

const sends = await db.collection('mailer_sends').aggregate([
  { $match: { templateSlug: { $in: flow.steps.filter(s => s.type === 'send').map(s => s.templateSlug) } } },
  {
    $group: {
      _id: '$templateSlug',
      total: { $sum: 1 },
      delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
      bounced: { $sum: { $cond: [{ $eq: ['$status', 'bounced'] }, 1, 0] } },
      opened: { $sum: { $cond: [{ $ne: ['$openedAt', null] }, 1, 0] } },
      clicked: { $sum: { $cond: [{ $ne: ['$firstClickAt', null] }, 1, 0] } },
    },
  },
]).toArray()
```

### Find users to A/B test against

Two-arm A/B by inserting a branch step. The branch step's predicate can use any field — typically you'd add a field like `vars.abVariant` and randomize at flow entry. For V1, since flows don't ship A/B-test infrastructure natively, the simplest pattern is:

1. Fire a synthetic event with `properties.variant: 'A' | 'B'` on contact entry
2. Branch on `hasFiredEvent: 'flow-entry'` with that property

Or:

1. Use a `tag` step to apply `ab:variant-a` to 50% of entrants (via the predicate `{ random: 0.5 }` — note this isn't in the spec yet, V2 candidate)

For V1, A/B testing is manual: create two flows, randomly assign new entrants by writing tags or by fire-time logic in the host app.

---

## Acting safely

A few patterns to internalize:

1. **Write to drafts, never to live.** All your flow + template edits go in `draft.*`. Publication is a separate, explicit action.

2. **Audit everything you do.** A `mailer_audit_log` row per mutation. It's not enforced, but it's the difference between "we can review what the script did" and "we have to git-bisect production."

3. **Read before you write.** Always re-read the document and check whether someone else has already changed something. Use the `updatedAt` field as a soft optimistic-concurrency hint.

4. **Prefer the API helpers over direct writes when available.** `mailer.tag()`, `mailer.suppress()`, `mailer.templates.publish()`, `mailer.scheduleBroadcast()` are the library's safe paths. They handle audit, validation, side-effects.

5. **Leave broadcasts in draft.** Even if you've designed the whole campaign, the final scheduled-status flip should be human.

6. **Never disable a flow that's actively sending.** Use the admin UI's "Pause" — that stops new entrants but doesn't yank in-flight runs. Setting `enabled: false` directly has the same effect, but the audit trail is cleaner via the UI.

7. **Use `mailer.audit()` for direct DB writes.** It's the conventional way to flag your activity for human review.

---

## Reading the schema

The full data model lives in `02-data-model.md`. Read it once. Re-read the section for any collection before you write to it.

The most common reference patterns:

- Building a flow → `02-data-model.md` § Flows + `FlowStep` types
- Writing a template → `02-data-model.md` § Templates + `06-templates.md` for MJML conventions
- Building a segment → `02-data-model.md` § `SegmentDefinition`
- Querying engagement → `02-data-model.md` § Sends

## Reading the invariants

`INVARIANTS.md` is short (15 rules). Read it before you do anything mutating. The rules exist because each one represents a category of bug that ate someone's afternoon at some point. They're not arbitrary.

Most important when writing direct-DB scripts:

- Rule 1: `dedupeKey` is required on `fire()`. Use `mailer.registerEvent(name, { dedupePolicy })` to auto-derive, or pass an explicit key.
- Rule 7: `hasOpened`/`hasClicked` predicates exist but are labeled noisy. Prefer `hasOpenedExcludingBots` or real product events for branching.
- Rule 9: GDPR forget leaves a hashed suppression forever. Don't try to "clean up" old suppressions.
- Rule 10: Audit log is append-only. No deletes. Ever.
- Rule 11: Broadcasts > threshold need typed-count confirmation. Don't bypass.

---

## When in doubt

- Propose, don't act. Leave changes in drafts. Let a human publish.
- Audit your reasoning in `mailer_audit_log` with a clear `diffSummary`. Future-you (or the next script) will thank you.
- Ask if you're unsure. The admin UI has a `proposals` view for human review.
- If something's broken in production, prefer reading-only diagnostics until you understand the cause. The wrong "fix" can compound.
