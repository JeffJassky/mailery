# 17 — Cadence and timing controls

Extends [`15-programs.md`](./15-programs.md) (Programs, contact policy, preference page)
and [`16-program-board.md`](./16-program-board.md). Drafted 2026-10-08. Branch
`release/0.21`, same worktree as the rest of 0.21.

## 0. Why

Programs already have: a program gap, per-attempt gaps, a delivery window, quiet time
after a session, slow-down and a sunset ask after unanswered emails, retry cooldowns and a
holdout. The contact policy adds a cross-system gap, a rolling cap, quiet hours and
source priority. What is missing is control over *where in the subject's life* an email
lands and letting the subject set the pace. Five additions, chosen from what Noom,
Duolingo, Braze and Iterable do:

| # | Feature | One line |
|---|---|---|
| F1 | Relative-time conditions | "signed up at least 3 days ago", "in the first 7 days of the program" |
| F2 | Send at the subject's usual hour | Delivery window takes the hour from a host fact, falls back to `timeOfDay` |
| F3 | Pause | Recipient pauses all marketing email for 1 week / 2 weeks / 1 month from the preference page |
| F4 | Momentum | A shorter gap for the email that follows progress (an action completed, a human click) |
| F5 | Blackout dates | Mailer-wide calendar ranges with no marketing sends; programs, flows and broadcasts defer |

Already true, no work: engagement (a session, a human click, an action newly satisfied)
resets the sunset stage to 0, so a slowed-down run returns to the normal gap as soon as
the subject re-engages (`test/programs/sunset.test.ts` "engagement resets").

## 1. Contracts

Every type below is written in PR 1 and is not changed by implementation PRs.

### F1 Relative-time conditions

`src/shared/types.ts`

```ts
export interface FactPredicate {
  fact: string
  equals?: string | number | boolean | null
  gte?: number | string
  lte?: number | string
  in?: Array<string | number | boolean | null>
  exists?: boolean
  /** Date facts only. True when the fact is at least this many days before `now`. Unset / null fact → false. */
  minAgeDays?: number
  /** Date facts only. True when the fact is less than this many days before `now`. Unset / null fact → false. */
  maxAgeDays?: number
}

/** Program predicates only: days since the run entered (`run.enteredAt`). */
export interface SinceEntryPredicate {
  sinceEntry: {
    /** True once at least this many days have passed since entry. */
    minDays?: number
    /** True while fewer than this many days have passed since entry. */
    maxDays?: number
  }
}
// Predicate union gains `| SinceEntryPredicate` (program-only, like FactPredicate).
```

Semantics, with `age = (now − fact) / 86 400 000` and `days = (now − enteredAt) / 86 400 000`
as real numbers (not rounded):

- `minAgeDays: n` → `age >= n`. `maxAgeDays: n` → `age < n`. Both set → both hold.
- A fact that is `undefined`, `null`, not a date and not an ISO string / epoch number → both
  operators false (unknown date is not "old enough" and not "recent").
- A fact in the future has a negative age: `minAgeDays` false, `maxAgeDays` true.
- `sinceEntry.minDays: n` → `days >= n`; `maxDays: n` → `days < n`.
- Other operators on the same `fact` leaf still AND with these.
- In a facts-only simulation (no run) `enteredAt = now`.

`src/shared/schemas.ts` — `programPredicateSchema`:

- fact leaf gains `minAgeDays` and `maxAgeDays`: `z.number().min(0).max(3650).optional()`.
- new member `{ sinceEntry: { minDays?, maxDays? } }`, strict, same bounds, refined so at
  least one of the two keys is present (message `sinceEntry needs minDays or maxDays`).
- The flow `predicateSchema` is untouched; `sinceEntry` is program-only.

`src/server/programs/validate.ts` — `checkPredicateFacts`: `minAgeDays` / `maxAgeDays` on a
fact whose declared type is not `date` → issue at `${path}.minAgeDays` (or `.maxAgeDays`)
with message `` `minAgeDays needs a date fact; "<fact>" is <type>` ``. A `sinceEntry` leaf
needs no fact check.

`src/server/runner/programs/predicate.ts`

```ts
export function evaluateFactPredicate(leaf: FactPredicate, facts: Facts, now: Date = new Date()): boolean
export interface ProgramPredicateContext { facts: Facts; subjectId: string; collections: Collections; now: Date; enteredAt: Date }
export async function evaluateProgramPredicate(pred: Predicate, ctx: ProgramPredicateContext): Promise<boolean>
/**
 * The earliest instant strictly after `after` at which a time-based leaf in `pred`
 * (minAgeDays, maxAgeDays, sinceEntry.minDays, sinceEntry.maxDays) changes value, or
 * null when there is none. Pure. Event leaves (`withinDays`) are ignored.
 */
export function nextPredicateFlipAt(pred: Predicate, facts: Facts, enteredAt: Date, after: Date): Date | null
```

`enteredAt` is required in the context: `rank.ts` passes it through; the tick passes
`run.enteredAt`; the guard in `hooks.ts` passes `run.enteredAt`; the simulator passes
`run?.enteredAt ?? now`.

Wake-ups: when a tick ends `none-eligible`, `nextTickAt = min(now + minGapDays,
flip)` where `flip = min over every action of nextPredicateFlipAt(eligible)` and
`nextPredicateFlipAt(satisfied)` (skip satisfied actions). The simulator: `next.at`
for `none-eligible` is `min(earliestCooldown, flip)` (null when neither exists — not
capped by `minGapDays`, which is a scheduling artefact); the projection advances `t` to
that instant and ends `none-eligible` only when there is nothing to wait for.

Board text (`src/shared/program-board.ts`, both `describePredicate` and
`outlinePredicate`). For the age phrases the fact name is humanised (underscores and
hyphens → spaces) and a trailing ` at`, ` date` or ` on` is dropped (`signed_up_at` →
"signed up") — in `describePredicate` too, whose other phrases keep the raw name:

| Leaf | Text | Negated |
|---|---|---|
| `{fact:'signed_up_at', minAgeDays:3}` | signed up at least 3 days ago | signed up less than 3 days ago |
| `{fact:'signed_up_at', maxAgeDays:7}` | signed up in the last 7 days | signed up 7 or more days ago |
| both (3, 7) | signed up between 3 and 7 days ago | signed up not between 3 and 7 days ago |
| `{sinceEntry:{minDays:3}}` | at least 3 days into the program | less than 3 days into the program |
| `{sinceEntry:{maxDays:7}}` | in the first 7 days of the program | after the first 7 days of the program |
| both (3, 7) | between 3 and 7 days into the program | not between 3 and 7 days into the program |

Singular where n = 1: "at least 1 day ago", "in the last day", "at least 1 day into the
program", "in the first day of the program". Other operators on the same leaf: in
`describePredicate` the age phrase joins last with " and " (`{fact:'signed_up_at',
exists:true, minAgeDays:3}` → "signed_up_at is set and signed up at least 3 days ago");
in `outlinePredicate` the leaf becomes an "all of" group with one line per operator
("signed up at is set", "signed up at least 3 days ago"). Exact strings:
`test/board/predicate-text.test.ts` and `predicate-outline.test.ts`.

### F2 Send at the subject's usual hour

Reserved fact `usual_session_hour_utc` (type `number`, integer 0–23): the UTC hour of day
in which the subject is most often active. Recorded by the host in UTC so it needs no
timezone knowledge; mailery converts it to the window's zone on the day of sending.

`src/shared/types.ts` — `DeliveryWindow`:

```ts
export interface DeliveryWindow {
  weekdaysOnly?: boolean
  timeOfDay?: string
  useContactTimezone?: boolean
  timezone?: string
  /** Programs only. Replace `timeOfDay` with the subject's `usual_session_hour_utc` fact when it is a valid hour. `timeOfDay` is the fallback. */
  useSessionHour?: boolean
  /** Programs only. Minutes added to the usual hour (negative = earlier). Default 0. */
  sessionHourOffsetMinutes?: number
}
```

`src/shared/schemas.ts` — the program `deliveryWindowSchema` gains
`useSessionHour: z.boolean().optional()` and
`sessionHourOffsetMinutes: z.number().int().min(-720).max(720).optional()`. The flow send
step's inline delivery schema is untouched.

`src/server/programs/validate.ts`: `policy.delivery.useSessionHour === true` requires a
declared fact `usual_session_hour_utc` of type `number`; issue path
`policy.delivery.useSessionHour`, message `requires a declared number fact "usual_session_hour_utc"`.

`src/server/programs/lint.ts`: new warning code `session-hour-fallback` at path
`policy.delivery.timeOfDay` when `useSessionHour` is true and `timeOfDay` is unset:
`no timeOfDay fallback: subjects without a usual hour are sent as soon as the gap allows`.
`ProgramLintCode` (program-board.ts) gains `'session-hour-fallback' | 'progress-gap-not-shorter'`.

`src/server/runner/programs/window.ts` (new):

```ts
/** The window the tick actually uses for `facts`: `timeOfDay` from the usual-hour fact when asked and valid. Pure. */
export function programDeliveryWindow(window: DeliveryWindow, facts: Facts, now: Date): DeliveryWindow
/**
 * Earliest instant ≥ `from` at which a program send may go out: delivery window
 * (`programDeliveryWindow`) and the mailer-wide blackout dates, applied until stable
 * (≤ 50 passes). `gate` says which rule moved the time last; null when `at` equals `from`.
 */
export function programSendTime(
  from: Date,
  def: ProgramDefinition,
  facts: Facts,
  contactPolicy: ContactPolicy | undefined,
): { at: Date; gate: 'delivery-window' | 'blackout' | null }
```

`programDeliveryWindow`: when `useSessionHour` and `facts.usual_session_hour_utc` is an
integer 0–23: take today's date in the window's resolved zone (`pickTimezone` logic:
the `timezone` fact when `useContactTimezone` and it is a valid zone, else
`window.timezone`, else UTC), build `Date.UTC(y, mo−1, d, hour, 0)`, add
`sessionHourOffsetMinutes`, read that instant's local `HH:mm` in the zone, and return a
copy `{ ...window, timeOfDay: 'HH:mm' }` (never mutate). Otherwise return `window`
unchanged. `programSendTime` loop: `t = from`; repeat ≤ 50 times { `at =
computeDeliveryTime(t, programDeliveryWindow(window, facts, t), tz)` (or `t` with no
window); `end = blackoutEnd(at, dates, zone)`; if `end` is null break else `t = end` }.
`gate` is `'blackout'` when any blackout moved the time, else `'delivery-window'` when the
window did, else null. The zone for the blackout is
`resolvePolicyTimezone(null, timezoneFact(facts), contactPolicy?.marketing?.defaultTimezone)`.
The tick (step 12) and `simulate.ts` `sendTimeFor` both call `programSendTime` and the
tick's silent reason is the gate; neither calls `computeDeliveryTime` directly any more.

Board (`policy-format.ts`, `edit.ts`): `windowChip` value is `Usual hr` in place of the
time (so `Wkdays Usual hr`) when `useSessionHour`; the "when" part of the tip reads
`at the subject's usual hour (fallback 10:00, -30 min)` — the parenthesis lists the
`timeOfDay` fallback when set and the offset when non-zero as `-30 min` / `+45 min`
(ASCII sign), and is omitted when both are absent. Full tips in
`test/client/board/cadence-chips.test.ts`. `chipFields('window')` appends a bool field
`useSessionHour` (label "At the subject's usual hour") and a number field
`sessionHourOffsetMinutes` (label "Offset from usual hour (minutes)"); `applyChipEdit`
sets/deletes the two keys, rejecting a non-integer or |offset| > 720 (returns `def`).

### F3 Pause

A pause is a suppression row with a new scope, so every send path honours it with no new
lookups and expiry is already implemented.

`src/shared/enums.ts` (done in PR 1): `SuppressionScope` gains `'marketing_pause'`;
`UnsubscribeScope = Exclude<SuppressionScope, 'marketing_pause'>` is what tokens and the
unsubscribe API carry; `SuppressionReason` gains `'paused'`. `blockingScopes('marketing', …)`
includes `'marketing_pause'` in both marketing lists; transactional lists are unchanged.
The unsubscribe and resubscribe input schemas do **not** accept the new scope.

Row shape: `{ email, emailHash, scope: 'marketing_pause', reason: 'paused', source,
notes: null, addedAt: now, expiresAt: now + days × 1 day }`. One row per address (the
`(email, scope)` unique index); pausing again replaces `addedAt`/`expiresAt`/`source`.

`src/shared/types.ts`:

```ts
export interface PreferenceState {
  marketing: boolean
  categories: Record<string, boolean>
  /** A live `marketing_pause` row's expiry; null when not paused. */
  pausedUntil: Date | null
}
export interface PreferencesConfig {
  /** Pause lengths offered on the preference page, in days. Default [7, 14, 30]; [] hides the control. Each 1–365. */
  pauseDays?: number[]
}
// MailerConfig gains `preferences?: PreferencesConfig`.
```

`src/server/config.ts`: `PREFERENCES_DEFAULTS = { pauseDays: [7, 14, 30] }`;
`assertValidPreferences(config.preferences)` throws `MailerConfig.preferences is invalid:`
listing every bad entry — `pauseDays must be an array`, `pauseDays[i] must be an integer
from 1 to 365`, `pauseDays[i] … is listed twice` — called from `Mailer.init` beside the
other 0.21 checks (already wired in PR 1).

`src/server/preferences.ts` (stubs in PR 1):

```ts
export async function pauseMarketing(collections, email, opts: { days: number; source: string; now?: Date }): Promise<{ pausedUntil: Date }>
export async function resumeMarketing(collections, email): Promise<{ resumed: boolean }>  // deletes marketing_pause rows by email or emailHash
// getPreferences fills pausedUntil from a live marketing_pause row (expiresAt > now); a pause never makes `marketing` false.
```

`pauseMarketing` lower-cases the address and upserts on `{ email, scope: 'marketing_pause' }`
with `$set: { reason: 'paused', source, addedAt: now, expiresAt, notes: null }` and
`$setOnInsert: { emailHash }`. `resumeMarketing` deletes `{ scope: 'marketing_pause', $or:
[{ email }, { emailHash }] }`; `resumed` is `deletedCount > 0`.

`Mailer` (`src/server/mailer.ts`): `pauseMarketing(email, { days, source })` and
`resumeMarketing(email, { source })`; `days` must be an integer 1–365 or the method throws
(`pauseMarketing: days must be an integer from 1 to 365`). Audit rows like `setPreferences`
writes them, actions `contact.pause` and `contact.resume`.

`src/server/runner/suppression.ts`: `SuppressionResult` gains `expiresAt?: Date | null`
(the matching row's expiry).

Preference page (`src/server/api/public.ts`, mounted only when categories are declared,
as today). Dates render as `toLocaleDateString('en-US', { month: 'long', day: 'numeric',
year: 'numeric', timeZone: 'UTC' })` → "October 22, 2026".

- GET, not paused, `pauseDays` non-empty: a "Take a break" section inside the form with
  one `<button type="submit" name="pause" value="14">Pause for 2 weeks</button>` per
  length. Labels: 7 → "1 week", 14 → "2 weeks", 30 → "1 month", anything else → "N days".
- GET while paused: `<p class="notice"><strong>Paused until October 22, 2026.</strong>
  You'll get no marketing email until then.</p>` and
  `<button type="submit" name="action" value="resume">Resume now</button>`; no pause
  buttons. When the address is unsubscribed from all marketing, that notice is shown
  instead and neither pause nor resume controls appear.
- POST with a `pause` field: the value must be one of the configured `pauseDays` (an
  empty list accepts nothing) else 400 `Unknown pause length.` Writes the row with
  `source: 'preferences'`; 200 done page `Paused until October 22, 2026. You'll get no
  marketing email until then.`; on a Mongo failure 503 + `Retry-After: 60` (a pause
  cannot be journaled — the opt-in rule).
- POST `action=resume`: deletes the row; 200 `Your emails will resume.`

Programs: in the tick's step 13, when no recipient remains and at least one was removed by
a suppression with `expiresAt > now`, `nextTickAt = min(now + minGapDays, earliest such expiresAt)`.
Reason stays `no-recipients`. `simulate.ts` returns `detail: 'all recipients paused until YYYY-MM-DD'`
(the UTC date of that earliest expiry) on the `no-recipients` reason when every
recipient was removed and at least one removal had an expiry; no detail otherwise. Flows and broadcasts: a send that
reaches dispatch while the address is paused takes the existing suppressed path (the
email is skipped, not deferred) — documented, not changed.

Admin: `contact-detail.tsx` shows a `Paused until <date>` pill beside "All marketing" when
`preferences.pausedUntil` is set.

### F4 Momentum

`src/shared/types.ts` — `ProgramPolicy`:

```ts
/** Gap before the next send when the subject made progress since the last one (an action completed, or a human click on a program email). Used instead of `minGapDays` and any attempt gap when shorter. */
progressGapDays?: number
```

Schema: `z.number().positive().max(365).optional()`. Lint warning
`progress-gap-not-shorter` at `policy.progressGapDays` when `progressGapDays >= minGapDays`:
`progressGapDays (N) is not shorter than minGapDays (M), so it never applies`.

Engine, `src/server/runner/programs/sunset.ts`:

```ts
export function gapMs(def, action, attemptIndex, stage, progress = false): number
// progress && def.policy.progressGapDays !== undefined → min(normal gap × factor, progressGapDays × DAY_MS)
```

"Progress since the last send" (tick step 11, only when `run.lastSentAt` is set):
some action state has `completedAt > run.lastSentAt`, or `hasHumanClick(ctx, runId, run.lastSentAt)`.
The simulator uses the `completedAt` test only (it assumes no engagement) at the first
decision; projected sends never have progress. `nextTickAfterSend` in `hooks.ts` is unchanged.

Wake on click: in the click-tracking handler (`src/server/api/public.ts`), after a
non-bot click is recorded on a send with `send.program`, update the run:
`programRuns.updateOne({ _id: runId, status: { $in: ['active','sunset'] } }, { $min: { nextTickAt: now } })`.
Best effort (errors logged, redirect unaffected). This is what lets a click shorten the
gap and reset sunset without waiting for the scheduled tick.

Board: `progressChip(days)` → `{ key: 'progress', icon: 'Rocket', value: '1d', tip: 'Gap
after progress: 1 day' }` (plural "days"; null when unset), placed right after the gap
chip in `policyChips`; in `EDITABLE_CHIPS`; `chipFields('progress')` →
`[{ name: 'days', kind: 'number', value, label: 'Gap after progress (days)' }]`;
`applyChipEdit`: a positive number sets it, empty or 0 deletes the key, negative or
non-numeric returns `def`. `ChipKey`/`ChipIcon` already carry `progress`/`Rocket`.

### F5 Blackout dates

`src/shared/types.ts` — `ContactPolicy.marketing`:

```ts
/** Local calendar ranges (inclusive, 'YYYY-MM-DD') with no marketing sends. Recipient zone chain as quiet hours. Deferral past a blackout never expires. */
blackoutDates?: Array<{ from: string; to: string; label?: string }>
```

`src/server/config.ts` `assertValidContactPolicy`, messages: `marketing.blackoutDates must
be an array`, `marketing.blackoutDates has at most 50 entries`, `marketing.blackoutDates[i].from
must be YYYY-MM-DD` (regex and a real calendar date), same for `.to`,
`marketing.blackoutDates[i]: from must not be after to`, `marketing.blackoutDates[i].label
must be at most 64 characters`. Every problem listed at once, as the other checks do.

`src/server/models/index.ts`: `ContactPolicyReason` gains `'blackout'`.

`src/server/runner/contact-policy.ts`:

```ts
/** If the local date of `at` in `timezone` falls inside any range, the local midnight after the last consecutive range; else null. Pure. */
export function blackoutEnd(at: Date, dates: Array<{ from: string; to: string }> | undefined, timezone: string): Date | null
```

`decideContactPolicy`, after the existing expiry check (which keeps its current inputs, so
a blackout can never turn a defer into a drop): if `blackoutEnd(t)` is non-null, `t` = that
end, then re-apply quiet hours to `t`; `reason = 'blackout'` whichever of the two moved it
last. A policy whose `marketing` object holds only `blackoutDates` still makes
`contactPolicyApplies` true and `applyContactPolicy` run (history lookback stays 0).

Programs: `programSendTime` (F2) applies `blackoutEnd` as described there.
`ProgramDecisionReason` and `ProgramNextReason` gain `'blackout'` (done in PR 1); the
tick writes it with `nextTickAt = at` when the gate is `blackout`; the client
`REASON_WORDS.blackout = 'Blackout dates'` and `blackout` is in the lens `WAITS` set (done
in PR 1). The projection advances `t` to `at` as for the window.

Flows and broadcasts need no change: their sends defer at dispatch with
`policyDeferral.reason: 'blackout'` and `notBefore` = the blackout end, and the origin's
guard re-runs on release (§4.2). The flow step's own delivery-window check is unchanged.

### Documentation to update (every PR touches its own section)

- `docs/guide/programs.md` — Predicates (F1), The tick (F1 wake, F4, F5), the facts
  adapter reserved facts (F2), Sunset (note on momentum), a new "Cadence controls" section
  listing every knob in one table.
- `docs/guide/contact-policy.md` — blackout dates (F5).
- `docs/guide/suppression.md` and `docs/reference/public-endpoints.md` and
  `docs/reference/mailer.md` — pause (F3).
- `docs/reference/agent-api.md` — `blackout` reason, `pausedUntil` on contact detail.
- `plans/15-programs.md` §5.4 tick list: steps 12 (window + blackout), 13 (pause wake),
  11 (progress gap), 4 (`enteredAt` in the predicate context). Append to §14.
- `CHANGELOG.md` 0.21.0 Added: one bullet per feature.
- `plans/16-program-board.md` §2: new chips and words.

## 2. Work breakdown

| PR | Who | Scope |
|---|---|---|
| 1 | Fable | Contract: types, schemas, enums, lint/reason codes, config types; the test suite below. |
| A | Sonnet | F1 relative-time conditions. |
| B | Sonnet | F2 + F4 + F5: program send time, momentum, blackout (contact policy + programs). |
| C | Sonnet | F3 pause. |
| D | Sonnet (maxed repo) | `usual_session_hour_utc` fact and the activation program's window. After A–C merge and build. |
| R | Fable | Two area reviews on the integrated branch: (1) suppression/pause + blackout deferral, (2) tick ↔ simulate parity and `nextTickAt`. |

A, B and C run in parallel worktrees off `release/0.21`. They touch `tick.ts` and
`simulate.ts` at different steps (A: step 4 context and the none-eligible wake; B: steps
11–12; C: step 13); merge order A → B → C, conflicts resolved by the merger.

Rules for every implementation agent: never `git stash`; set work aside with a WIP
commit. Do not change a contract type, schema or test; if one looks wrong, stop and
report. Make the named tests green without weakening them; add tests freely. Run
`yarn typecheck`, the named suites, then the full `yarn test` once before finishing.
Update the docs listed for the PR.

### PR 1 — Contract and tests (Fable)

Files: `src/shared/types.ts`, `src/shared/schemas.ts`, `src/shared/enums.ts`,
`src/shared/program-board.ts` (types and constants only), `src/server/models/index.ts`
(`ContactPolicyReason`), `src/server/config.ts` (`PreferencesConfig` on `MailerConfig`,
`PREFERENCES_DEFAULTS`), `src/server/runner/suppression.ts` (`SuppressionResult.expiresAt`
type only), stubs so the tree type-checks (`enteredAt` in the predicate context,
`nextPredicateFlipAt`, `programDeliveryWindow`, `programSendTime`, `blackoutEnd`,
`pauseMarketing`, `resumeMarketing` may throw `not implemented`).

Tests (red until implemented):

- `test/programs/relative-time.test.ts` — F1 vectors, tick wake, guard, publish
  validation, simulate projection.
- `test/board/predicate-text.test.ts`, `test/board/predicate-outline.test.ts` — F1 wording
  rows added.
- `test/programs/session-hour.test.ts` — F2 `programDeliveryWindow` vectors, tick,
  fallback, validation, lint, simulate parity, board chip text.
- `test/programs/momentum.test.ts` — F4 gap after progress, click wake, lint, simulate.
- `test/policy/blackout.test.ts` — F5 `blackoutEnd` and `decideContactPolicy` vectors,
  config validation, dispatch deferral, program tick and simulate.
- `test/categories/pause.test.ts` — F3 API, suppression matrix, expiry, page GET/POST,
  config, program tick wake, simulate detail, admin contact detail.
- `test/programs/predicate.test.ts` — context gains `enteredAt`.
- `test/client/board/lens.test.ts` — `REASON_WORDS.blackout`.

### PR A — Relative-time conditions (Sonnet)

- **Files**: `src/server/runner/programs/predicate.ts`, `rank.ts`, `hooks.ts` (context
  only), `tick.ts` (predicate context; the `none-eligible` wake), `simulate.ts` (context;
  the no-choice wake), `src/server/programs/validate.ts`, `src/shared/program-board.ts`
  (`describePredicate`, `outlinePredicate` bodies), `docs/guide/programs.md`,
  `plans/15-programs.md` §5.4 and §14, `CHANGELOG.md`.
- **Contract**: §1 F1.
- **Tests to make green**: `test/programs/relative-time.test.ts`,
  `test/board/predicate-text.test.ts`, `test/board/predicate-outline.test.ts`,
  `test/programs/predicate.test.ts`; `test/programs/*`, `test/board/*` stay green.
- **Invariants**: 20 (facts are host state — `enteredAt` is run state, not a fact), 21,
  23.
- **Non-goals**: no new predicate leaves beyond the two; no flow predicate changes; no
  event-leaf flip times.

### PR B — Program send time: usual hour, momentum, blackout (Sonnet)

- **Files**: `src/server/runner/programs/window.ts` (new), `sunset.ts` (`gapMs`),
  `tick.ts` (steps 11–12 only), `simulate.ts` (`sendTimeFor` only), `hooks.ts`
  (nothing unless a type forces it), `src/server/runner/contact-policy.ts`,
  `src/server/config.ts` (`assertValidContactPolicy`), `src/server/programs/validate.ts`
  (usual-hour fact check), `src/server/programs/lint.ts` (two warnings),
  `src/server/api/public.ts` (click wake only), `src/server/runner/programs/index.ts`
  (exports), `src/client/screens/program-board/{policy-format.ts,edit.ts,lens.ts}`,
  `docs/guide/programs.md`, `docs/guide/contact-policy.md`, `docs/reference/agent-api.md`,
  `plans/15-programs.md` §5.4 and §14, `plans/16-program-board.md` §2, `CHANGELOG.md`.
- **Contract**: §1 F2, F4, F5.
- **Tests to make green**: `test/programs/session-hour.test.ts`,
  `test/programs/momentum.test.ts`, `test/policy/blackout.test.ts`,
  `test/client/board/lens.test.ts`; `test/policy/*`, `test/programs/*`, `test/board/*`,
  `test/unit/delivery-window.test.ts`, `test/matrix/*`, `test/upgrade/*` stay green.
- **Invariants**: 18 (a deferred send consumes no attempt), 19, 23; §4.2 "defer, don't
  drop" — a blackout never produces a drop.
- **Non-goals**: no flow-step blackout check (dispatch handles it); no admin screen for
  the contact policy; no per-program blackout; `computeDeliveryTime` itself unchanged.

### PR C — Pause (Sonnet)

- **Files**: `src/shared/enums.ts` (nothing — contract), `src/server/runner/suppression.ts`
  (`blockingScopes`, `expiresAt` on results), `src/server/preferences.ts`,
  `src/server/mailer.ts` (two methods + audit), `src/server/config.ts`
  (`assertValidPreferences` + init call), `src/server/api/public.ts` (page + handlers),
  `src/server/runner/programs/tick.ts` (step 13 only), `simulate.ts` (`hasRecipient` /
  `decideNext` detail only), `src/client/screens/contact-detail.tsx`, `src/client/lib/api.ts`
  (type), `docs/guide/suppression.md`, `docs/reference/public-endpoints.md`,
  `docs/reference/mailer.md`, `docs/reference/agent-api.md`, `plans/15-programs.md` §3.2
  and §14, `CHANGELOG.md`.
- **Contract**: §1 F3.
- **Tests to make green**: `test/categories/pause.test.ts`; `test/categories/*`,
  `test/policy/*`, `test/programs/*`, `test/board/*`, `test/upgrade/*` stay green.
- **Invariants**: 3 (suppression re-checked at send time), 4/22 (scope table), 8 (a pause
  is not an unsubscribe: it is never journaled and never answers 200 on a failed write),
  9 (hash lookup finds the row).
- **Non-goals**: no pause for transactional mail; no agent/admin pause endpoints beyond
  what `getPreferences` already exposes; no deferral of flow sends across a pause; the
  unsubscribe/resubscribe input schemas do not learn the new scope.

### PR D — maxed: usual hour fact (Sonnet, `Amplify11/MaxMarketing-activation`)

- **Files**: `src/server/models/User.ts` (`sessionHoursUtc?: Record<string, number>`,
  24 counters keyed `'0'`…`'23'`), `src/server/auth/middleware.ts` (`touchLastSeen` also
  `$inc`s `sessionHoursUtc.<getUTCHours()>` in the same throttled write),
  `src/server/services/mailerFacts.ts` (declare `usual_session_hour_utc: { type: 'number' }`;
  resolve: sum the owners' histograms, return the mode hour (ties → the earliest hour) when
  the total is ≥ 5, else `null`), `src/server/services/mailerActivationProgram.ts`
  (`delivery: { weekdaysOnly: true, timeOfDay: '10:00', timezone: 'America/New_York', useSessionHour: true }`),
  `src/server/privacy/registry.ts` (the new field is behavioural data, deleted with the
  user), tests beside each file.
- **Contract**: §1 F2 fact definition.
- **Tests**: histogram increments once per throttle window; resolve returns null under 5
  samples, the mode otherwise, ties → earliest; the seeded program definition passes
  `validateProgramDefinition` with the declared facts.
- **Non-goals**: no decay or reset of the histogram; no per-account timezone fact; no
  change to the 10:00 fallback.

### Area reviews (Fable, after A–C merge)

1. Suppression and deferral surfaces: pause scope in every blocking path, hashed lookup,
   unsubscribe-while-paused, page durability rules; blackout deferral never dropping,
   `notBefore` correctness across DST and consecutive ranges.
2. Tick ↔ simulate parity: `programSendTime` used identically; `nextTickAt` always > now;
   the none-eligible wake; momentum only after a real send; `enteredAt` in every predicate
   context, including the dispatch guard.

## 3. Decisions taken

- **Usual hour is a host fact in UTC**, not learned by mailery from decision rows. Hosts
  know sessions; UTC needs no timezone knowledge; mailery converts on the day. Learning
  from `mailer_*` data would be mailer-derived state (INVARIANT 20 spirit) and sparse.
- **Pause is a suppression scope**, not a new collection: every dispatch path already
  checks suppressions with expiry; one row per address; the `(email, scope)` unique index
  keeps it apart from an unsubscribe row so unsubscribing while paused still writes.
- **Blackout lives in the contact policy**, mailer-wide: it is a calendar fact about the
  business, and the contact policy already is the cross-system marketing layer with the
  timezone chain and defer semantics. Programs also check it in the tick so the board shows
  the true next send.
- **Momentum counts progress and clicks, not sessions.** A login already triggers the
  session quiet period; speeding up after a mere login would fight that rule.
- **Relative-time leaves are program-only.** Flows have `wait` steps.

## 4. Not in scope

Digest emails (several due actions in one email). Per-program blackout dates. Pause for
flows as a deferral. Learning send-time from clicks. A visual condition editor.
