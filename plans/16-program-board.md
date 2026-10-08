# 16 — Program board (QC view for Programs)

Status: contract written (frontier). Implementation: Sonnet, two work packages.
Tests are the contract: `test/board/*`, `test/integration/board-api.test.ts`.

## 1. Purpose and audience

AI agents write program definitions (through `saveProgramDraft` → publish).
Humans use the board to **check** them: see a whole program at once, zoom
into one email, see what one real account will get next and why, and fix
small things. It is a quality-control surface, not an authoring tool.

**Design rule (from the product owner): incredibly simple and clean.**
- Icons with tooltips instead of words for settings, states and statuses.
- No explanatory paragraphs on screen. No jargon labels. No JSON on the board.
- Nothing shown that does not help answer "is this program right?".
- Use the existing admin styles (`styles.css` tokens, `.btn`, `.pill`,
  `.card`, `.table`). No new UI library. No new npm dependency.
- When in doubt, leave it out.

## 2. Shape of the screen

`program-detail` keeps its header and gets these tabs: **Board** (default),
**Runs**, **Stats**, **JSON**. The old Actions table is removed (the board
replaces it). Runs/Stats/JSON are the existing Runs, Funnel and Definition
editor, unchanged.

### 2.1 Header (existing, tightened)
Name · `v3` pill · enabled toggle · draft dot (amber, tooltip "Unpublished
changes") · **Publish** button only when a draft exists · Edit toggle (pencil
icon, tooltip "Edit", WP-C).

### 2.2 Toolbar (one row, above the board)
Left: policy chips. Right: source switch + lens.

**Policy chips** — icon + short value, tooltip carries the label and the full
value. Only show a chip when the setting is set.

| Icon | Value shown | Tooltip |
|---|---|---|
| clock | `3d` | Min gap between emails: 3 days |
| calendar | `Wkdays 10:00` / `10:00` | Delivery window: weekdays at 10:00 America/New_York |
| moon | `12h` | Quiet for 12 h after a session |
| sunset | `3 · 6` | Slows after 3 unanswered (×2), asks after 6 |
| split | `10%` | Holdout: 10% get nothing |
| users | `Owners` | Recipients |
| log-in | entry event name | Enters on "Account Created" |
| log-out | count | Exits on: Account Upgraded, Account Cancelled |
| flag | event name | Fires "Activated" on completion |

**Source switch** — only when a draft exists: segmented `Published | Draft`.
Default Draft (that is what QC reviews). In Draft, changed rows/cells carry
a small amber dot (tooltip lists changed fields) and removed actions show as
struck-through ghost rows at their old position.

**Lens** — a compact input with a user icon, placeholder "Account id", plus a
beaker icon button (tooltip "Simulate facts") that opens the facts panel.
Lens off = plain board. Clear with an × in the input.

### 2.3 Board
One row per action, in evaluation order (priority desc, ties by definition
order). The sunset ask, if configured, is a final row with a sunset icon.

Row = `[status] [title + icon strip] [attempt cells…]`

- **Status column** (lens on only): one icon per action from the simulation
  candidate. `check` satisfied (green) · `arrow-right` next (accent) ·
  `circle` pending · `ban` exhausted · `refresh` cooldown (tooltip "until
  <date>") · `lock` blocked by requires (tooltip "Waiting for <title>") ·
  `filter-off` not eligible · `pause` held. Tooltip always says the state in
  words.
- **Title** — action title (one line, ellipsis). Muted priority number before
  it in mono, small.
- **Icon strip** under the title, only icons that apply:
  - `filter` — has `eligible`; tooltip "Sent only if …" as an outline
    (`outlinePredicate`): one condition per line in plain words
    ("access lapsed: no"), nested "one of:" / "none of:" groups indented.
  - `check-circle` — `satisfied`; tooltip "Done when …", same outline.
  - `link` — `requires`; tooltip "After: <titles>"
  - `refresh` — `cooldownDays`; tooltip "Retries after 30 days"
  - `pause` — `onExhaust: 'hold'`; tooltip "Blocks lower actions until done"
  - `external-link` — CTA; tooltip "<label> → <url>"
  - `alert-triangle` (red for error / amber for warning) — lint issues for
    this action without an attempt; tooltip lists messages.
- **Attempt cells** — one per attempt, left to right, equal width; the grid
  has as many columns as the longest ladder. A cell shows the template's
  subject line (raw, one line, ellipsis) and nothing else. Tooltip: template
  slug and, if set, the per-attempt gap. Cell states:
  - lint error on that attempt → red dashed border, alert icon
  - lint warning → amber alert icon in the corner
  - lens: sent → green tint + `check` (tooltip "Sent <date>")
  - lens: next → accent 2px border + `clock` icon (tooltip "<reason in
    words> · <date>"; see §2.5)
  - lens: projected → small numbered circle (1, 2, 3 …) = position in
    `sequence`, tooltip date. Cells not in the projection and not sent are
    muted.
- Click a cell → **drawer** (§2.4).

Above the rows, when the lens is on, one quiet summary line:
`<status icon> Next: <action title> · email <n> · <date>` and an info icon
whose tooltip says "Projection assumes facts stay the same and no engagement.
Contact policy and suppressions can still delay a send." When nothing will
send, the line says why in two to five words (reason table §2.5).

### 2.4 Cell drawer (right side panel, not a modal)
- Rendered email in an iframe (`srcdoc`), subject line above it, from
  `api.previewProgramEmail` with the lens's facts (or none).
- Small meta row of icon chips: template slug (copy on click), attempt
  `2 / 3`, gap, published state.
- Link icon to open the template editor.
- Lint messages for that cell, if any, as a short list.
- WP-C adds edit controls here (§2.6).
- Esc closes. Arrow keys move to the neighbouring cell.

### 2.5 Reasons in words (lens summary and tooltips)
| reason | words |
|---|---|
| send | Sends now |
| holdout | Holdout: logged, not sent |
| min-gap | Waiting for the gap |
| delivery-window | Waiting for the window |
| session-suppressed | Recently active |
| in-flight | Previous email in flight |
| none-eligible | Nothing to send |
| no-recipients | No one to email |
| completed | Done |
| exited | Exited |
| sunset | Sunset |
Append `detail` when present (e.g. a missing template).

### 2.6 Facts panel (beaker)
A right drawer listing `facts` declarations (from `GET /programs/:slug`),
one compact row each: fact name (mono) and a control by type —
boolean: three-state segmented `—|yes|no`; number: number input; date:
date-time input; enum: select with an empty option; string: text input. A
row is "set" only when its control is not empty. Prefilled with the lens
account's resolved facts when a lens account is set (from the simulation's
`facts`). A reset icon clears overrides. Changes re-run the simulation
(debounced 300 ms). With no account, the simulation runs in fresh mode.

### 2.7 Edit mode (WP-C)
Pencil toggles edit mode. Edits change a local copy of the **draft**
(created from published when there is no draft). A sticky footer appears
only when the local copy differs: `Discard` and `Save draft`. Publish stays
in the header. Server validation issues (422 / 400 with `issues`) map back to
rows and cells the same way lint does.

Edits allowed (small fixes only):
- Reorder rows by drag handle (grip icon at row start) or ↑/↓ keyboard on a
  focused handle. The moved action gets a priority strictly between its new
  neighbours (integer midpoint); when no integer fits, renumber all actions
  100, 90, 80 … in the new order.
- Row overflow menu (`dots` icon): toggle hold/skip, set cooldown days (empty
  removes), edit title, edit CTA label/url, edit eligible/satisfied as JSON
  in a small textarea with a live `describePredicate` preview under it and a
  parse error inline.
- Drawer: template picker (select of marketing templates in the program's
  category, from the existing templates list API), per-attempt gap override
  (empty removes), remove attempt (trash icon; disabled with tooltip when it
  is the only one).
- A `+` ghost cell at the end of each ladder adds an attempt (picker opens).
- Policy chips become clickable; each opens a tiny popover with one or two
  inputs for that setting.
No adding or deleting actions, no editing ids or versions. Bump nothing
automatically.

## 3. Simulation semantics (`simulateProgram`)

Read-only. Mirrors the tick (§5.4 of plans/15) step for step, using the same
`evaluateCandidates` (extracted from tick.ts into `rank.ts`; the tick calls
it — no behaviour change, the existing suites must stay green).

Inputs: see `ProgramSimulationInput`. Validation → `invalid_input`:
`source` ∉ {published, draft}; `subjectId` not a string of 1–256 chars;
`horizonDays` not an integer 1–365; `now` not a valid date; `facts` not a
plain object. Unknown slug → `not_found`. Chosen source has no definition
→ `no_definition`. No facts adapter → `no_facts_adapter`. Works whether or
not the program is enabled.

Facts: subject mode = `factsAdapter.resolve(subjectId)` merged under
`input.facts`; fresh mode = `input.facts ?? {}`. Event predicates read
events for `subjectId` (fresh mode: subjectId `''`, nothing fires).

Run state: the subject's run (if any) — its `actions`, `lastSentAt`,
`unansweredAttempts`, `sunsetStage`, `sunsetAskSent`, `status`, `arm`,
`inFlight`, `entryEventAt`. Otherwise a fresh run: no action state, nothing
sent, stage 0, arm = `holdoutArm(slug, subjectId, holdoutPct)` (fresh mode:
'treatment').

`next` — one tick at `now`, in tick order:
1. run status completed / exited → that reason; sunset (status) → `sunset`
   (unless engagement would wake it — ignore engagement; report `sunset`).
2. exit event after `entryEventAt` (subject with a run) → `exited`.
3. candidates (`evaluateCandidates`). done → `completed`.
4. sunset ask choice exactly as the tick (stage 2 and not asked →
   `$sunset-ask`, attempt 1, template `askTemplateSlug`).
5. no ranked candidate → `none-eligible`, `at` = earliest future
   `cooldownUntil` among candidates, or null.
6. in-flight: run.inFlight with any send still in flight (`sendIsInFlight`)
   → `in-flight`.
7. session → `session-suppressed`; gap → `min-gap`; window →
   `delivery-window`. The reason is the first gate that blocks, in that
   order. `at` = `computeDeliveryTime(max(now, sessionUntil, gapUntil),
   window, tz)` (no window: the max).
8. subject mode only: recipients after suppression; none → `no-recipients`.
9. template drift (missing / not marketing / wrong category) → `none-eligible`
   with `detail` "template \"<slug>\" is missing" (or the tick's wording), and
   the chosen candidate's `blockedBy` becomes `ineligible` (rank kept), as the
   tick does.
10. else `send` (treatment) or `holdout` (holdout arm), `at = now`. This
    includes the sunset ask (actionId `$sunset-ask`).
`actionId`/`attempt`/`templateSlug` are the chosen candidate's for every
reason from step 4 on (null before).

`candidates` mirror the decision row's candidates (same order, blockedBy,
rank) plus `title`, `status`, `attempts`, `ladder`, `cooldownUntil` from the
working state **before** any simulated send.

`sequence` — projection from the same starting state, assuming facts fixed,
no engagement, every send accepted, recipients present. Loop with `t = now`:
evaluate candidates at `t` (event predicates as of `t`); `done` → end
`completed`; run status sunset → end `sunset`; exit event → no steps, end
`exited`; no ranked → jump `t` to the earliest future `cooldownUntil` (if
any; else end `none-eligible`); choose like the tick (sunset ask
included); send time = `computeDeliveryTime(max(t, lastSent + gap(stage),
sessionUntil), window, tz)`; if send time > `now + horizonDays` → end
`horizon`; if send time > `t` set `t` = send time and re-evaluate (loop);
template drift → end `none-eligible`; otherwise record a step (`sunsetStage`
= stage at choice), then apply acceptance exactly as `countAcceptedSend`
does (attempts+1, lastSentAt, unanswered+1, stage =
`sunsetStageFor`; ask → askSent, status sunset). Stop at
`SIMULATION_MAX_STEPS` → `max-steps`. Holdout arm projects the same steps.

## 4. Lint (`lintProgram`)

Errors: every `validateProgramDefinition` issue, code `invalid`, same path and
message, in validation order. Warnings (only when the definition parses), in
definition order: per action `priority-tie` (a later action with the same
priority as an earlier one; path `actions.i.priority`), `no-cta` (`actions.i.cta`),
then per delivery `template-unpublished` (exists, no validation issue on that
path, `published: false`), `template-reused` (second and later uses; message
names the first use's slug location); then the sunset ask template (same two
checks) and `sunset-early` (`askAfter` < the longest ladder; path
`policy.sunset.askAfter`). `actionId`/`attempt` derive from the path
(`actions.<i>` → that action's id; `attempts.<j>` → j+1;
`policy.sunset.askTemplateSlug` → `$sunset-ask`). On a definition that fails
to parse, map `actions.<i>` from the raw input when it has an id there.

`Mailer.lintProgram(slug, source?)` builds the context from config
categories, `factsAdapter.declare` and the templates collection (published =
has `body.html`).

## 5. Predicate text
`describePredicate` — pinned by `test/board/predicate-text.test.ts`.

## 6. Diff
`diffProgramDefinitions` — pinned by `test/board/diff.test.ts`. Compare with
`stableJson` from `runner/programs/common.ts` semantics (key order free) —
but the shared module must not import server code: reimplement a tiny stable
stringify in `shared/`.

## 7. Render vars
`buildProgramRenderVars` holds the body of `programRenderVars` minus I/O;
`programRenderVars` calls it. Template preview accepts
`program: { slug, source?, actionId, attempt (int ≥ 1), facts?, subjectId? }`:
400 `validation_failed` when malformed, 404 `program_not_found` when the
program or the chosen source's definition is missing; facts = `facts` ??
resolved facts of `subjectId` ?? `{}`; `daysSinceFirst` 0. Program vars are
merged after the host vars (they win), as at send time.

## 8. HTTP
- `GET /programs/:slug` adds `facts` (declare or null) and `templates`
  (`ProgramTemplateInfo[]`, every existing template referenced by the
  published or draft definition, sorted by slug).
- `POST /programs/:slug/simulate` body `ProgramSimulationInput` →
  `ProgramSimulation` JSON. Errors: 400 `validation_failed`, 404
  `not_found`, 409 `no_definition` / `no_facts_adapter`. Not audited.
- `GET /programs/:slug/lint?source=` → `{ source, issues }`. 400 bad source,
  404 unknown program, 409 `no_definition`.
- Agent discovery lists both new routes.

## 9. Work packages
- **WP-A (server)**: rank.ts extraction, simulate, lint, shared helpers,
  render vars, preview option, routes, facade, discovery, e2e harness seed
  (`MAILERY_E2E_PROGRAM=1` seeds an activation-like program with facts,
  templates and a few runs in various states). Green: all of `test/`.
- **WP-B (client board + lens + facts panel)** then **WP-C (edit mode)**.
  Green: `yarn typecheck`, `yarn build`.
- End review (frontier): visual QA in the browser against the seeded harness,
  plus one code review of the whole diff.
