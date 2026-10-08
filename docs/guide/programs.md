# Programs

A Flow is a sequence: event, wait, send, wait, send. A **Program** is a policy: *given everything we know about this account right now, what is the one most valuable thing to ask for?* On a schedule it reads account state from your app, picks the single highest-priority thing the account has not done, emails about it with copy that escalates over a few attempts, then moves on when the account does it, gives up on it, or stops responding.

Programs are off unless you configure a [`factsAdapter`](#the-facts-adapter) and enable one. Without them nothing about mailery changes.

## Concepts

| Term | Meaning |
| --- | --- |
| **Fact** | One piece of account state supplied by your app: `shopify_connected: true`. Never derived from mailer sends or events. |
| **Subject** | What the Program is about. 0.21: the account. Facts and the run are keyed by subject id. |
| **Action** | One thing to nudge toward ("Connect Shopify"). Has `eligible`, `satisfied`, `requires`, ordered `attempts`, a priority. Also the unit your in-app checklist renders. |
| **Attempt** | One email on an action's ladder. Attempt 1 asks, 2 reminds, the last is last call. |
| **Run** | Per (program, subject) state: per-action progress, sunset stage, next tick. One run per subject, ever. |
| **Decision** | One row per tick, silent ticks included: every candidate considered, why each was or was not chosen, and the outcome. |

## Defining a program

```ts
const activation: ProgramDefinition = {
  slug: 'activation',
  name: 'Activation',
  category: 'lifecycle.onboarding',        // a declared category; every template must carry it
  subject: 'account',
  recipients: 'owners',                    // 'owners' | 'admins' | 'all_members' | { adapter: string }
  entry: { eventName: 'Created' },         // fired with externalId = the account id
  exit: {
    eventNames: ['Upgraded', 'Cancelled'], // any of these after entry ends the run
    onComplete: { fireEvent: 'Activated' },
  },
  policy: {
    minGapDays: 3,                         // between two Program sends to one subject
    delivery: { weekdaysOnly: true, timeOfDay: '10:00', useContactTimezone: true, timezone: 'UTC' },
    suppressIfSessionWithinHours: 12,      // they are in the app; the checklist is enough
    sunset: { slowAfter: 2, slowFactor: 2, askAfter: 4, askTemplateSlug: 'still-want-these' },
  },
  holdoutPct: 10,
  actions: [
    {
      id: 'connect-shopify',
      version: 1,
      title: 'Connect Shopify',
      cta: { label: 'Connect', url: 'https://app.example.com/connect/shopify' },
      priority: 100,
      eligible: { fact: 'business_type', equals: 'ecommerce' },
      satisfied: { fact: 'shopify_connected' },
      attempts: [
        { deliveries: [{ channel: 'email', templateSlug: 'connect-shopify-1' }] },
        { deliveries: [{ channel: 'email', templateSlug: 'connect-shopify-2' }], minGapDays: 5 },
        { deliveries: [{ channel: 'email', templateSlug: 'connect-shopify-3' }] },
      ],
      onExhaust: 'skip',                   // 'hold': nothing lower-priority may send
      cooldownDays: 30,                    // after exhaustion, then a fresh ladder
    },
    {
      id: 'run-playbook',
      version: 1,
      title: 'Run a playbook',
      priority: 50,
      requires: ['install-agent'],
      satisfied: { fact: 'playbooks_run', gte: 1 },
      attempts: [{ deliveries: [{ channel: 'email', templateSlug: 'run-playbook-1' }] }],
      onExhaust: 'skip',
    },
  ],
}
```

### Predicates

`eligible` (relevant now? default: always) and `satisfied` (done? state, not event) accept:

| Leaf | Meaning |
| --- | --- |
| `{ fact, equals? , gte?, lte?, in?, exists? }` | Tests one fact. Every operator present must hold. With no operator it is a truthiness test. `gte`/`lte` take a number, or an ISO string / epoch ms for date facts. `exists: true` means neither missing nor `null`. |
| `{ hasFiredEvent: name, withinDays? }` / `{ notHasFiredEvent: name }` | Events fired with `externalId` = the subject id. |
| `{ all }`, `{ any }`, `{ not }` | Combinators. |

Contact-scoped leaves (`hasTag`, `hasOpened`, ...) have no subject to read from: publish rejects them and evaluation throws.

### Completion is monotonic

When `satisfied` first holds, the action's `completedAt` is written. It is never cleared: if the fact regresses, the action stays satisfied and the checklist stays ticked. A regression that deserves a nudge is a separate action (`reconnect-shopify`) with its own copy.

## The facts adapter

```ts
Mailer.init({
  // ...
  categories: [{ id: 'lifecycle.onboarding', label: 'Getting-started tips' }],
  factsAdapter: {
    declare: {
      shopify_connected: { type: 'boolean' },
      business_type: { type: 'enum', values: ['ecommerce', 'saas', 'local', 'agency'] },
      playbooks_run: { type: 'number' },
      last_session_at: { type: 'date' },
      timezone: { type: 'string' },
    },
    async resolve(accountId) {
      return { shopify_connected: await isConnected(accountId), /* ... */ }
    },
    async recipients(accountId, rule) {
      return loadContacts(accountId, rule)          // contacts your ContactAdapter also knows
    },
  },
})
```

- `declare` is what publish checks `fact` predicates against, and what an editor can offer as typeahead.
- `resolve` runs **once per tick** and once more per send at dispatch (the re-verify). Keep it cheap and read-only.
- Facts are **host state only**. Never compute one from `mailer_*` collections: an action whose own email flips a fact it reads is a loop.
- Two names are reserved: `last_session_at` (date) feeds `suppressIfSessionWithinHours` and the sunset engagement check; `timezone` (IANA string) feeds `delivery.useContactTimezone` and the [contact policy](./contact-policy) quiet hours.
- For connection actions, define `satisfied` as "first data landed", not "account id present", or sync lag makes the action satisfied while the user still sees an empty dashboard. Decide that in the adapter, not the engine.

## The tick

A run is ticked when its `nextTickAt` arrives (the mailer tick scans for due runs), on entry, when your app fires `Facts Changed` for the subject, or by `mailer.tickProgram`. One tick is exactly:

1. Skip if the program is missing, unpublished or disabled, or the run is not `active`/`sunset`.
2. Take the run's lease (a crashed worker's lease expires after `programs.leaseMs`).
3. Resolve the facts.
4. **Exit**: an `exit.eventNames` event for the subject after entry ends the run and cancels its unsent mail.
5. **Evaluate actions** in priority order (ties: definition order). Each is satisfied, held, blocked by `requires`, ineligible, cooling down, exhausted, or a candidate.
6. **Complete** the run when every action is satisfied (or exhausted with `onExhaust: 'skip'` and no cooldown); fire `onComplete` once.
7. **Engagement**: a newly satisfied action, a newer `last_session_at`, or a non-bot click on one of the run's emails resets the sunset counters and wakes a `sunset` run. Opens never count.
8. Choose the top candidate, then stay silent if: the run is `sunset`; a previous send is still in flight; the subject was in the app within `suppressIfSessionWithinHours`; `minGapDays` (or the attempt's own `minGapDays`, widened by `slowFactor` once sunset stage 1 is reached) has not elapsed; or the delivery window is closed.
9. Resolve recipients, drop blank addresses and addresses opted out of the program's category, and write one send row per recipient.
10. Write the decision row and schedule the next tick.

Every tick that gets past step 3 writes a decision row, including silent ones. The row lists every candidate with `blockedBy` (`satisfied`, `ineligible`, `requires:<id>`, `exhausted`, `cooldown`, `hold`) so "why didn't they get X" is always answerable.

When the next tick happens: after a send, `lastSentAt` plus the gap for the next attempt; for `min-gap` and `delivery-window`, the instant the constraint lifts; for `session-suppressed`, the session time plus the window; while a send is in flight, an hour; with nothing to do or no recipients, `minGapDays`; when sunset, `minGapDays × slowFactor`; when the contact policy defers the send, its `notBefore`.

## Attempts are consumed by accepted sends only

An attempt is counted when the provider **accepts** the send, once per tick no matter how many recipients it fanned out to. Contact-policy deferral or expiry, suppression, provider failure, the session rule and sunset leave the action's state unchanged, so a capped recipient never burns a ladder without receiving anything. A `failed` send counts as in flight (the queue is still retrying) for an hour, then the next tick tries the same attempt again. This is INVARIANT 18.

## Re-verify at dispatch

Immediately before the provider call, including after a contact-policy deferral, the send's action is re-checked against **fresh** facts. Already satisfied: the send is cancelled (`exitReason: 'satisfied_before_send'`) and the action is marked complete. No longer eligible, or removed from the program: `ineligible_before_send`. Run no longer active, or program disabled: `run_inactive`. A facts adapter that throws fails the send closed: nothing is sent and the queue retries.

## Holdout

`holdoutPct` assigns `hash(slug, subjectId) % 100 < holdoutPct` subjects to the control arm at entry, fixed for the run's life. A holdout subject goes through exactly the same decisions, but its send rows are written with `status: 'holdout'` and no provider is ever called. The holdout row stands in for the accepted send, so the ladder advances exactly as it does for treatment and the two arms' decision logs stay comparable. `mailer_sends.program.holdout` splits the arms for stats.

## Sunset

`unansweredAttempts` counts accepted sends since the last engagement (a session, a human click, or any action newly satisfied). At `slowAfter` the gap is multiplied by `slowFactor`. At `askAfter` one "still want these?" email (`askTemplateSlug`) is sent; once it is accepted the run goes `sunset` and stays silent until the subject engages. The ask is not an attempt of any action. A suppressed ask leaves the run active, and the next tick asks again.

## Templates

Every template a program sends must be `marketing` with the program's `category`, so the unsubscribe link stops the program. Editing a template that a published program sends so it is no longer marketing, or moves it out of that category, is rejected with 409 naming the program. If it drifts anyway (a direct database edit), the tick records the candidate as `ineligible` and sends nothing, and dispatch cancels the send. Program sends add these variables:

| Variable | Value |
| --- | --- |
| `{{program.slug}}` | The program |
| `{{action.id}}`, `{{action.title}}` | The action being nudged |
| `{{action.cta.url}}`, `{{action.cta.label}}` | The action's CTA, when it has one |
| `{{attempt.n}}`, `{{attempt.total}}`, `{{attempt.isLast}}` | Position on the ladder |
| `{{attempt.daysSinceFirst}}` | Days since attempt 1 of this ladder was queued |
| `{{facts.*}}` | The facts the dispatch-time re-verify just read |

These win over a host var of the same name on program sends. `varsAdapter.resolve` receives `info.program` (`{ slug, actionId, attempt }`) and `info.subjectId`.

## Entry, exit and `Facts Changed`

Program events are keyed by the **subject id**, not a contact: fire them with `externalId = accountId`. See [Events](./events#program-events-account-scoped).

```ts
await mailer.fire('Created', accountId, { subjectType: 'account' })      // enters the program
await mailer.fire('Facts Changed', accountId)                            // wakes the run now
await mailer.fire('Upgraded', accountId, { subjectType: 'account' })     // exits it
```

`Facts Changed` carries no payload: the next tick always resolves fresh facts. It wakes the run but never sends inside `minGapDays`. Mailery registers it (dedupe `every-time`) when a `factsAdapter` is configured. For a host-driven stop, call `mailer.abortProgram(slug, accountId, { reason })`.

## Seeding, publishing and enabling

```ts
await mailer.saveProgramDraft(activation, { actor: 'seed-script' })
const res = await mailer.publishProgram('activation', { actor: 'seed-script' })
if (!res.ok) throw new Error(res.issues.map((i) => `${i.path}: ${i.message}`).join('\n'))

await mailer.enterProgram('activation', testAccountId)       // a preview account, no entry event needed
await mailer.setProgramEnabled('activation', true, { actor: 'seed-script' })
```

Publish validates the structure, declared categories and facts, the templates (marketing, the program's category), `requires` cycles and, when `suppressIfSessionWithinHours` is set, a declared date fact `last_session_at`; it returns every issue rather than the first. Enabling moves the entry and Facts Changed watermarks to now: entry events from before enabling are not replayed. Enter existing accounts with `mailer.enterProgram`. A run uses the latest published definition, so a new action appears on the next tick and a removed one stops sending.

A run is one per (program, subject), ever: a completed or exited run is not re-entered.

## Checklist API

```ts
const items = await mailer.getProgramState('activation', accountId)
// [{ actionId, title, cta, status, isNext, attempts, completedAt }]  (null when the account has no run)
```

Actions come in priority order. `status` is `pending`, `satisfied`, `exhausted` or `cooldown`, read from the run (`completedAt` means satisfied), never recomputed from facts, so your in-app checklist and the emails agree. `isNext` is true for at most one action: the latest decision's `chosen` when it is not yet satisfied.

## Erasing an account

Runs and decisions are keyed by your `subjectId`, and decisions keep the facts snapshot. When your host erases an account, call `mailer.forgetSubject(subjectId)` to delete that subject's runs and decisions across every program (audited as `gdpr.forget_subject`), and `mailer.forget(externalId)` for each of its contacts.

## Operations

- `programs.batchSize` (default 200) bounds how many runs one mailer tick processes.
- `programs.decisionRetentionDays` (default keep forever) deletes older decision rows, at most hourly.
- A tick that throws (your `resolve`) is logged, its lease released, and the run retried after 15 minutes.
- Test with `mailery/testing`: `MemoryFactsAdapter`, `buildProgram`, `H.seedProgram`, `tickProgram`, and `H.drain()`, which runs the scheduler.

## Admin UI and API

Operators work with Programs in the admin UI (list, definition editor with draft and publish, funnel by arm, runs, and a per-run decision timeline with Force tick and Abort): see [Programs screens](/guide/admin-ui#programs-screens). The same operations are JSON routes on the admin API and the agent API: see [Admin REST API](/reference/admin-api#programs) and [Agent API](/reference/agent-api#programs).

## Doctor and backfill

```bash
MAILER_MONGODB_URI=... MAILER_MONGODB_DB=... npx mailery doctor --categories lifecycle.onboarding,product.updates
```

`doctor` is read-only. It reports the mailery version; marketing templates with no category; used versus declared categories; Programs and which are enabled; whether the indexes for `mailer_programs`, `program_versions`, `program_runs`, `program_decisions` and `contact_locks` exist; suppression rows whose scope is not `all`, `marketing`, `transactional` or `category:<valid id>`; Program runs whose lease expired more than ten minutes ago (is the scheduler running?); and, for enabled Programs, a definition that no longer parses, a `requires` cycle, or a template that is missing, not marketing, or in a different category than the program. It exits non-zero when anything would make a Program tick fail (missing indexes once Programs exist, an enabled Program that fails the last check). Everything else is a warning.

`MailerConfig` lives in your code, so `doctor` cannot read your declared categories: pass `--categories a,b` to compare, otherwise it lists the categories templates use. It does not inspect `factsAdapter` or `contactPolicy`; `setProgramEnabled` and publish check the adapter where it matters. `--json` prints the report as JSON.

```bash
npx mailery backfill-categories --map welcome-1=lifecycle.onboarding,news-june=product.updates --dry-run
```

`backfill-categories` sets `category` on marketing templates. It refuses transactional templates and malformed ids, will not replace a different existing category unless you pass `--overwrite`, writes an audit row per change (`template.backfill_category`), and is idempotent. It cannot see your declared categories either, so run `doctor --categories` afterwards.
