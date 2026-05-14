# Deliverability roadmap

> **Status:** PR1–PR10 shipped. This doc is preserved as a record of the
> original plan + the deltas where implementation diverged. Items marked
> ✅ shipped, ⚠️ shipped with deviation, ❌ deferred.

Execution plan for the deliverability features chosen from [warming.md §10](./../docs/guide/warming.md). Companion doc, not a replacement.

Volume assumptions: ≤10k marketing sends/day per domain at peak, <100/day automated drips. No dedicated IP expected for most operators.

## Implementation deltas

- **PR1 backfill from sends** ❌ deferred. The per-(domain × kind) buckets populate lazily as new sends record counters; existing rows aren't replayed. Operators starting fresh after the upgrade lose at most one window (default 1h) of historical visibility.
- **PR2 history of DNSBL checks** ❌ deferred. The collection upserts per (target, list), so only the latest verdict is kept. A daily history would need a separate `mailer_dnsbl_check_history` collection.
- **PR2 Composite Blocking List** ❌ not in code. CBL is folded into Spamhaus XBL (which is part of ZEN), so the practical signal is already covered by the default `zen.spamhaus.org` list.
- **PR6 SendGrid Inbound Parse webhook** ⚠️ pivot. Ship is file-upload UI (operator drags `.zip`/`.gz` from their `rua=` mailbox into the admin Health screen). Inbound Parse + IMAP poll modes are still candidates for a future automation pass.
- **PR8 manual sunset button** ❌ deliberate descope. Hygiene screen is visibility-only; sunsetting is done through the existing Suppressions UI / REST endpoint. Tracked as v2.
- **PR10 inline editor squiggles** ⚠️ partial. The lint engine is wired and the editor sidebar renders all issues live; per-line squiggle markers in the MJML view + Maily-node badges are not yet implemented.

## Principles

- Foundation refactors first — multiple later features want the same shape.
- Independent slices ship as separate PRs; no big-bang merges.
- Reuse existing patterns: `setup-status` for health checks, `mailer_webhook_events` style collections, circuit breaker for trip behavior, suppressions for sunset action.
- No mock data anywhere; follow the live-stats convention from recent admin work.

---

## Phase 1 — Foundation + quick wins

### PR1. Per-(sender-domain × kind) health metrics

Refactor `src/server/runner/health.ts` so rates dimension by `senderDomain × kind`. Existing aggregate stays as roll-up.

- Schema: extend the rolling-window aggregate (currently global) with `senderDomain` + `kind` keys. Use existing `mailer_*` collection naming.
- API: `/admin/mailer/api/health` returns array of per-(domain, kind) entries plus an `aggregate` field for backward-compat.
- Circuit breaker: trips per (domain × kind), not globally. `health/resume` endpoint accepts optional `{ senderDomain, kind }`. Without it, resumes all.
- UI: dashboard tile group, one row per sender domain × kind, columns for hardBounce / complaint / combined. Aggregate row at top.
- Backfill: on first boot under new schema, replay last N days from `sends` into the new shape. Idempotent.

**Why first:** DMARC dashboard, Postmaster widget, DNSBL panel all want per-domain filtering. Build the dimension once.

### PR2. DNSBL monitor

Daily DNS resolution of each configured sender domain (and dedicated IP if set) against major blocklists.

- Lists: Spamhaus ZEN, Barracuda, SORBS, SpamCop, Composite Blocking List. Configurable; ship the default list.
- Storage: new `mailer_dnsbl_checks` collection, one doc per (target, list, runAt).
- Runs: nightly cron (reuse existing scheduler) + manual "Recheck now" button.
- Surface: new check in `setup-status.ts`, plus red dashboard banner if any target is listed. Banner deep-links to which list + target.

Small scope (~one day). High visibility. Validates the per-domain tile layout from PR1.

### PR3. Content linter — rule engine + publish gate

Pure-logic rule engine. No UI integration yet — publish endpoint is the only consumer.

- New: `src/server/templates/linter.ts`. Pure function `lintTemplate(template, config) => { errors[], warnings[], infos[] }`.
- Rules (start set):

| Rule | Severity | Trigger |
|------|----------|---------|
| Missing plain-text alternative | error | MJML compiled but no `text/plain` body |
| Image-only body | error | rendered text < 20 chars and ≥1 image |
| URL shortener in link | error | `bit.ly`, `t.co`, `tinyurl`, `goo.gl`, `ow.ly` |
| Bare URL in body | warn | `https?://` not wrapped in anchor |
| Spammy phrases | warn | "FREE", "ACT NOW", "100% guaranteed", `!!!+` |
| All-caps subject | warn | >50% uppercase |
| Missing unsubscribe merge tag | error | kind=marketing + no `{{unsubscribeUrl}}` |
| From-domain mismatch | error | already exists in `senderDomain.ts` — surface through linter too |
| Empty preheader | info | no `<mj-preview>` content |
| Subject >60 chars | warn | mobile truncation |
| >10 links | warn | promotional smell |

- Wire: template publish in `src/server/api/admin.ts` calls linter, returns 422 with issues if any errors. Warnings/infos pass through to UI.
- Tests: one per rule, plus golden templates that should pass clean.

No external deps, no infra. Ships independent of PR1/PR2.

---

## Phase 2 — External reputation feeds

Builds a unified "reputation feed" panel: Postmaster + SNDS + DMARC + DNSBL signals, keyed by sender domain.

### PR4. Google Postmaster Tools puller

- OAuth setup flow surfaced as a setup-status check ("Connect Postmaster Tools").
- Daily cron pulls reputation tiers + spam rate + auth pass rates per registered domain.
- Storage: `mailer_postmaster_snapshots`, one doc per (domain, day).
- Trip the breaker for (domain × kind=marketing) on reputation = `Bad`. `Low` warns but does not trip.
- UI: per-domain dashboard widget with trend sparkline + current tier badge.

### PR5. Microsoft SNDS puller

Similar shape to PR4. No OAuth — SNDS uses access keys per IP.

- Only meaningful if operator configured a dedicated IP. Setup-status check surfaces "not applicable" when no dedicated IP.
- Storage: `mailer_snds_snapshots`.
- JMRP enrollment: doc + setup-status hint, no automated step (Microsoft form is manual).

### PR6. DMARC report ingestion

Highest-scope item in Phase 2.

- Inbound path: SendGrid Inbound Parse webhook → `/admin/mailer/api/dmarc/inbound`. Alternative IMAP-pull mode for operators not using Inbound Parse — feature-flagged.
- RFC 7489 aggregate-report XML parser. RUF forensic reports out of scope (privacy + low value).
- Storage:
  - `mailer_dmarc_reports` — raw report metadata.
  - `mailer_dmarc_failures` — extracted alignment failures, keyed by (sourceIp, domain, day).
- UI: per-domain DMARC tab — sources sending as you, pass/fail counts, alignment failures table with source IP + count + last-seen.
- Setup helper: `mailery setup-dmarc` CLI writes `_dmarc.<domain>` TXT with `rua=mailto:dmarc-reports@<inbound-domain>`. Mirrors the existing `setup-sendgrid` pattern.

### PR7. DMARC dashboard polish

UI iteration on PR6 once real reports arrive. Split out so PR6 can ship with minimal UI.

---

## Phase 3 — Hygiene + content polish

### PR8. Engagement segments report + manual sunset

Visibility + one-click execution. No automation.

- Compute "engaged within 30/60/90/180d" rollups from `sends.openedAt` / `sends.firstClickAt`. Background job; cached in `mailer_engagement_rollups`.
- New admin screen "List Hygiene":
  - Headline: total contacts, % engaged at each window.
  - Suggestion card: "Sunsetting N contacts inactive >180d would drop projected bounce rate by ~X% and complaint rate by ~Y%." X/Y derived from historical rates of inactive segment.
  - Action: "Suppress these N contacts" button. Confirmation modal. Writes to suppressions with `reason: 'manual_sunset'`. Reversible.
- No cron, no automatic action. Operator decides.

### PR9. Mail-Tester API integration

- New config: `mailTesterApiKey` (optional).
- Template publish modal grows a "Run deliverability check" button. Clicking sends rendered template to a fresh mail-tester address, polls for score, displays panel.
- Configurable threshold (default 8/10). Score below threshold blocks publish.
- Cache score for 24h keyed on content hash so re-publishes don't burn credits.

### PR10. Content linter — editor-level squiggles

Reuse the PR3 rule engine through a new endpoint.

- `/admin/mailer/api/templates/:id/lint` — POST, body = current draft, response = issues. Debounced from editor (500ms after last keystroke).
- React: inline markers in MJML editor (line numbers for errors/warnings/infos), sidebar "Issues" panel listing each with severity icon and quick-jump.
- Reuses publish-gate logic; if editor shows zero errors, publish will pass.

---

## Out of scope (decided)

- List-validation adapter on contact import.
- Auto-warmup networks (Mailwarm, Lemwarm, etc).
- Automatic sunset flow — replaced with manual report+button (PR8).
- Seed-inbox IMAP placement checking — operator runs GlockApps externally.
- BIMI / VMC handling.

---

## Suggested merge order + rough effort

| # | PR | Effort | Depends on |
|---|----|--------|------------|
| 1 | Per-domain × kind health metrics | M | — |
| 2 | DNSBL monitor | S | (uses PR1 tile pattern) |
| 3 | Content linter rule engine + publish gate | M | — |
| 4 | Postmaster Tools puller | M | PR1 |
| 5 | SNDS puller | S | PR1, PR4 pattern |
| 6 | DMARC inbound + parser + storage | L | PR1 |
| 7 | DMARC dashboard UI polish | M | PR6 |
| 8 | Engagement rollups + List Hygiene + manual sunset | M | — |
| 9 | Mail-Tester publish integration | S | PR3 |
| 10 | Editor-level lint squiggles | M | PR3 |

S = ~1 day, M = ~3-5 days, L = ~1-2 weeks. Whole roadmap ≈ 6-8 weeks at one developer.

PRs 1, 3, 8 are fully independent and can run in parallel if multiple developers.
