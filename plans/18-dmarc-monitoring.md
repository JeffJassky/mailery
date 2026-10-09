# 18 — DMARC Monitoring (ships in 0.21)

Locked 2026-10-09. Spec and work breakdown in one file. Folded into `release/0.21`
before it ships. The contract (PR 0) is committed; every later task implements it.

## 1. Why

Gmail, Yahoo and Microsoft require bulk senders to authenticate with SPF, DKIM and
DMARC. Two problems only DMARC aggregate reports reveal:

1. **Silent breakage.** A rotated DKIM key, an SPF edit, or a new tool sending as the
   domain makes mail fail authentication. Nothing errors; mail goes to spam.
2. **Spoofing.** Anyone can send as your domain until the policy is `p=reject`.

The goal for each sending domain is `p=none` → `p=quarantine` → `p=reject` without
blocking your own mail. Reports are the evidence that tightening is safe, and the
early warning when something breaks later.

Mailery already ingests, stores and displays reports (since 0.15). This work makes it
a *monitor*: reports arrive without a human, DNS is verified, alerts reach the host,
and a GUI walks an operator through setup.

## 2. Already built — do not rebuild

| Piece | Where |
|---|---|
| Extract .zip/.gz/.xml with bomb + zip-slip defense | `src/server/runner/dmarc.ts` `extractDmarcXmls` |
| RFC 7489 parser, idempotent ingest | `dmarc.ts` `parseDmarcReport`, `ingestDmarcAttachment` |
| 90-day prune, source tags, policy progression | `dmarc.ts` `pruneDmarcFailures`, `resolveSourceTags`, `suggestPolicyProgression` |
| Admin upload, `GET /dmarc`, source-tag routes | `src/server/api/admin.ts` (DMARC section, ~line 772) |
| Inbound webhook (SendGrid Inbound Parse, shared secret) | `src/server/api/dmarc-inbound.ts` |
| DMARC cards on the Health screen | `src/client/screens/health.tsx` ~436–560 |
| `mailery setup-dmarc` (+ Cloudflare) | `src/cli/setup-dmarc.ts` |
| Alert-hook pattern to copy | `onCircuitBreakerTrip` in `runner/health.ts` ~233, `runner/postmaster.ts` ~319 |

## 3. Decisions

1. **Reports arrive through the existing inbound webhook.** No Gmail API, no IMAP, no
   OAuth, no credentials in the database.
2. **Alerts go to a host hook, `MailerConfig.onDmarcAlert(alert)`.** Mailery never
   sends Slack or email itself. `alert.text` is ready to forward as is.
3. **GUI settings follow the source-tag pattern:** config is the baseline, one DB
   document overrides it, the UI edits that document. Only non-secret settings.
4. **One Mailery instance = one host app.** No tenant dimension.
5. **New admin screen "DMARC Monitoring"** (`screen: 'dmarc'`). Health keeps a compact
   card titled exactly `DMARC RUA reports` (an e2e test asserts it).
6. **Alerts are grouped per domain and kind, never per IP.**
7. **No new npm dependencies.** `psl`, `fast-xml-parser`, `adm-zip`, `multer`,
   `node:dns/promises` cover everything.
8. **Zero-config is untouched (0.21's upgrade rule).** The monitor does nothing — no
   DNS, no alert reads — unless `config.dmarc` is set or at least one report has been
   ingested. `test/upgrade/zero-config.test.ts` must stay green.
9. **Contract types live in `src/shared/dmarc-types.ts`** so the server and the SPA
   share one definition. The SPA uses `Wire<T>` (dates as ISO strings).

### Non-goals (also the docs' "Not supported" list)

Forensic (`ruf`) reports. TLS-RPT. BIMI. DKIM selector checks. CIDR source tags.
Mailbox polling (IMAP/Gmail). Mailgun/Postmark inbound parsers (the `InboundParser`
seam stays unimplemented). Editing DNS from the GUI. Built-in Slack/email delivery.

## 4. Contract (PR 0 — done)

The code is the contract. Read it, do not change it.

| What | File |
|---|---|
| All DMARC Monitoring types, `DMARC_ALERT_KINDS`, `Wire<T>` | `src/shared/dmarc-types.ts` |
| `DmarcConfig.alerts/reportAddress/extraDomains/ignoredDomains/adminUrl`, `MailerConfig.onDmarcAlert` | `src/server/config.ts` |
| `DmarcReportDoc.via`, `DmarcAlertStateDoc`, `DmarcSettingsDoc`, `DmarcDnsCheckDoc`, three collections, `dmarcAlerts` indexes | `src/server/models/index.ts` |
| `Mailer.dmarcInboundState` | `src/server/mailer.ts` |
| `AdminRouterOptions.dmarcDnsResolver` (test seam) | `src/server/api/admin.ts` |
| `SetupDmarcResult.authRecords` | `src/cli/setup-dmarc.ts` |
| `ProgressionInput.now` | `src/server/runner/dmarc.ts` |
| Stub modules with fixed signatures | `src/server/runner/dmarc-{dns,settings,alerts,domains,monitor}.ts` |
| Client types + API methods | `src/client/lib/api.ts` |
| Public type exports | `src/server/index.ts` |

Tests (red until implemented): `test/unit/dmarc-{dns,settings,alerts,domains}.test.ts`,
`test/unit/setup-dmarc.test.ts` (new `describe` at the end),
`test/integration/dmarc-{monitor,monitoring-api}.test.ts`, and the last test in
`test/e2e/deliverability.spec.ts`.

### 5.6 HTTP (admin router, behind the host's admin guard)

| Route | Body | Response |
|---|---|---|
| `GET /dmarc` (exists) | — | unchanged, plus `ptr` on each `sources[]` row |
| `GET /dmarc/monitoring` | — | `DmarcMonitoringPayload` |
| `PUT /dmarc/settings` | `DmarcSettingsPatch` | `{ settings }`, or 400 `validation_failed` |
| `DELETE /dmarc/settings` | — | `{ settings }` |
| `POST /dmarc/dns/check` | `{ domain?: string }` | `{ results: DmarcDnsCheckResult[] }`, 400 `validation_failed` for an unmonitored domain |
| `POST /dmarc/alerts/evaluate` | — | `{ ran, reason?, fired, open }` (always `force: true`) |
| `POST /dmarc/alerts/test` | — | `{ delivery, alert }` |

`inbound.url` is `${config.publicUrl}/m${path}`. The public router is mounted at `/m`
everywhere in Mailery (unsubscribe URLs assume it too). `alerts.open` is every open
row; `alerts.recent` is resolved rows, newest `resolvedAt` first, max 50. Views
carry `id` (the `_id`), never `_id`. All routes pass `opts.dmarcDnsResolver` through.

## 6. Alert rules

### 6.1 Settings

`DMARC_SETTINGS_DEFAULTS` is in `dmarc-settings.ts`. `mergeDmarcSettings(config, patch)`
= defaults ← config ← patch, key by key; arrays replace; domain lists lowercased,
trimmed, deduplicated; returns a fresh object (never the shared default); ignores
`DmarcConfig` keys that are not settings.

`validateDmarcSettingsPatch(body)`: body must be a plain object. Unknown keys rejected
at both levels, message names the key. Integers: `windowDays` 1–30,
`unknownSourceMinMessages` / `knownSourceMinMessages` / `alignmentMinMessages`
1–1 000 000, `reportsStoppedDays` 1–60, `realertAfterHours` 0–8760,
`dnsCheckIntervalHours` 0–720. `alignmentMinRate` number 0.5–1. `enabled` boolean.
`disabledKinds` ⊂ `DMARC_ALERT_KINDS`. Domains match
`/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/` after lowercasing,
max 100 per list; returned lowercased. `reportAddress` null or `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
Every message names the offending field.

`loadDmarcSettings(ctx)` reads `dmarcSettings` `_id: 'settings'`.
`saveDmarcSettingsPatch(ctx, patch, actor)` deep-merges `patch` into the stored patch
(`alerts` merged key by key, other keys replaced), upserts, returns merged settings.
`clearDmarcSettingsPatch(ctx)` deletes the document.

### 6.2 Domains

`deriveSenderDomains(config)`: every `senderDomains` key, plus the domain of
`fromDefaults.email` and `transactionalFromDefaults.email`, plus each one's
organizational domain via `psl.get(d) ?? d`. `senderAddress` is a postal address:
never used. Lowercased, deduplicated, sorted. Replaces the private copy in
`dmarc-inbound.ts` (and its last-two-labels approximation).

`resolveMonitoredDomains(config, settings, reportDomains)`: union of
`deriveSenderDomains` (origin `config`), `settings.extraDomains` (`extra`) and report
domains (`reports`), lowercased, sorted by domain; `origin` in that fixed order;
`ignored` = in `settings.ignoredDomains`. A domain that is only in `ignoredDomains`
is not added.

### 6.3 Candidates (`computeDmarcAlertCandidates`, pure)

`windowStart = now − windowDays`. A failure row counts when `day ≥
windowStart.toISOString().slice(0,10)`; a report counts when `rangeEnd ≥ windowStart`.
Never `receivedAt` (a backlog upload must not alert). Domains considered: those in
`monitoredDomains` and not in `settings.ignoredDomains`. Returns `[]` when
`alerts.enabled` is false; skips kinds in `disabledKinds`. Output sorted by domain,
then kind in `DMARC_ALERT_KINDS` order.

Per source (domain × IP, in-window rows): `messages` sum of `count`; `daysSeen`
distinct `day`; first/last day; `headerFrom` distinct lowercased, sorted; `dkimResult`
/ `spfResult` / `disposition` from the row with the greatest `day` (tie: larger
`count`); `reporters` = distinct `orgName` of input reports whose `reportId` matches
the rows, default sort; `label` from the tag; `ptr: null`. `sources` max 25 by
`messages` desc; `subjectKeys` = every qualifying IP.

A tag with `ignored: true` excludes its IP from every rule. Untagged = unknown;
tagged and not ignored = known.

| Kind | Fires when | Subject | subjectKeys | Severity | threshold |
|---|---|---|---|---|---|
| `unknown_source_failing` | ≥1 untagged IP with in-window messages ≥ `unknownSourceMinMessages` | `''` | those IPs | `critical` if any IP ≥ 10× threshold, else `warning` | `{ name: 'unknownSourceMinMessages', limit, actual: sum over qualifying IPs }` |
| `known_source_failing` | same, known IPs, `knownSourceMinMessages` | `''` | those IPs | `critical` | same shape |
| `alignment_drop` | `pass + adjFail ≥ alignmentMinMessages` and `pass/(pass+adjFail) < alignmentMinRate`; pass/fail summed over in-window reports; `adjFail = max(0, fail − in-window failing messages from ignored IPs)` | `''` | `[]` | `critical` if rate < 0.90, else `warning` | `{ name: 'alignmentMinRate', limit, actual: rate }` |
| `reports_stopped` | domain has ≥1 input report and none with `rangeEnd ≥ now − reportsStoppedDays` | `''` | `[]` | `warning` | null |
| `policy_ready` | `suggestPolicyProgression` (same inputs as `GET /dmarc`, plus `now`) is non-null | `` `${policy}:${pct}` `` | `[]` | `info` | null |
| `dns_misconfigured` | stored DNS check has ≥1 `error` issue | `''` | error codes | `critical` if `dmarc_missing`, else `warning` | null |

`dnsIssues` = the error issues for `dns_misconfigured`, else `[]`. `suggestedPolicy`
set only for `policy_ready`. `id = dmarcAlertId(kind, domain, subject)`.

`summary`: `reportCount`, `passCount`, `failCount`, `totalMessages = pass + fail`
over in-window reports (raw, not adjusted); `alignmentRate` pass/total or null;
`lastReportAt` newest `rangeEnd` of any input report for the domain, or null;
`policy`/`pct` from the newest report, else the DNS check, else null.
`window = { start: windowStart, end: now }`; `detectedAt = now`.

Numbers in text use `toLocaleString('en-US')`; rates `(r*100).toFixed(1)`.

- **unknown_source_failing** — title `{n} unknown sender(s) failing DMARC for {domain}`;
  message `{total} message(s) claiming to be from {domain} failed DMARC in the last {windowDays} days, sent from {n} IP address(es) you have not identified. This is either a tool you forgot to set up (SPF/DKIM) or someone spoofing your domain.{note}`,
  note ` Your policy is p=none, so receivers delivered these messages anyway.` when
  `summary.policy` is `none` or null; recommendation `Open DMARC Monitoring and look at each IP's reverse DNS. If it is yours, fix its SPF/DKIM and tag it. If it is not, tag it as ignored and keep moving toward p=reject.`
- **known_source_failing** — title `{labels} failing DMARC for {domain}` (distinct
  labels by volume, first 3 joined `, `, then ` +N more`); message `{total} message(s) from senders you tagged as yours failed DMARC in the last {windowDays} days. Your own mail is at risk of going to spam or being rejected.`;
  recommendation `Check that the DKIM key for this sender is still published and that its sending IPs are in your SPF record. A recent DNS or provider change is the usual cause.`
- **alignment_drop** — title `DMARC pass rate for {domain} dropped to {rate}%`;
  message `{pass} of {total} messages passed DMARC in the last {windowDays} days ({rate}%), below your {limit}% threshold.`
  (`total = pass + adjFail`); recommendation `Open DMARC Monitoring and sort the failing sources by volume. The top one explains most of the drop.`
- **reports_stopped** — title `No DMARC reports for {domain} in {reportsStoppedDays} days`;
  message `Receivers normally send a report every day they get mail from {domain}. The last one covered {YYYY-MM-DD of lastReportAt}. Either the domain stopped sending, the rua= address changed, or the inbound webhook is failing.`;
  recommendation `Run the DNS check in DMARC Monitoring, then look at your inbound-parse provider's activity log for rejected requests.`
- **policy_ready** — title `{domain} is ready for p={policy}{ pct=N unless 100}`;
  message = the progression `reason`; recommendation
  `Publish: npx mailery setup-dmarc --domain {domain} --rua-mailbox {reportAddress ?? '<your rua mailbox>'} --policy {policy} --pct {pct}`
- **dns_misconfigured** — title `DMARC DNS problem for {domain}`; message = the error
  issues' messages joined with a space; recommendation `Add or fix the record(s) shown in DMARC Monitoring → Setup. Each issue lists the exact record to publish.`
- **resolved** (`buildResolvedAlert`) — same id/kind/domain, `event 'resolved'`,
  `severity 'info'`, title `Resolved: {state.title}`, message `This condition is no longer detected.`,
  recommendation `''`, `sources []`, `dnsIssues []`, `newSourceIps []`, `threshold null`,
  `suggestedPolicy null`, `summary` and `window` from `state.lastAlert`,
  `firstDetectedAt` from the state, `detectedAt = now`.
- **test** (`buildTestDmarcAlert`) — `kind/event 'test'`, `severity 'info'`,
  `id test|{domain}|{now ISO}`, title `Test alert from Mailery DMARC Monitoring`,
  message `If you can read this, onDmarcAlert is wired up. Real alerts look like this one.`,
  recommendation `''`, summary all zero/null with `windowDays 7`, one source
  `{ ip '203.0.113.10', ptr 'mail.example.net', label null, messages 42, daysSeen 1,
  first/last day = now's date, headerFrom [domain], dkim 'fail', spf 'fail',
  disposition 'none', reporters ['google.com'] }`, window last 7 days.

`formatDmarcAlertText` — blocks joined by one blank line, no trailing newline:

```
[{SEVERITY}] {title}
{message}

Domain: {domain} (policy p={policy ?? 'unknown'}{, pct=N when pct is not null and not 100})
Last {windowDays}d: {totalMessages} messages, {rate% or 'n/a'} passing, {reportCount} reports

Sources:                                   ← only when sources is non-empty; first 10, then "  …and N more"
  {ip} ({ptr ?? 'no reverse DNS'}){ [label]} — {messages} msgs, DKIM {dkim}, SPF {spf}, reported by {reporters joined ', ' or 'unknown'}

DNS issues:                                ← only when dnsIssues is non-empty
  - {message}{ → publish {host} {type} "{value}" when fix}

What to do: {recommendation}               ← line omitted when empty
{adminUrl}                                 ← line omitted when null; block omitted when both are
```

`finalizeDmarcAlert(candidate, extra)` drops `subjectKeys`, adds the extra fields and
`text = formatDmarcAlertText(rest)`.

### 6.4 Evaluation and the state machine (`evaluateDmarcAlerts`)

1. Process-local throttle: without `force`, at most once per hour per process
   (`{ ran: false, reason: 'throttled' }`). `_resetDmarcMonitorThrottle` clears it.
2. Load settings. `alerts.enabled` false → `{ ran: false, reason: 'disabled', fired: 0, open }`;
   touch nothing.
3. Load reports (`rangeEnd` ≥ now − 35d), failures (`receivedAt` ≥ now − 30d), tags,
   stored DNS checks, monitored domains (non-ignored); compute candidates.
4. For each candidate:
   - `insertOne` a state doc (`status 'open'`, `fireCount 1`, `firstDetectedAt =
     lastDetectedAt = lastFiredAt = now`, `resolvedAt null`, `lastDelivery null`,
     `lastAlert` = the finalized alert). Success → fire **opened**.
   - Duplicate key (11000) → load it.
     - resolved → `updateOne({ _id, status: 'resolved' }, reopen: status open,
       firstDetectedAt/lastDetectedAt/lastFiredAt now, fireCount 1, resolvedAt null,
       subjectKeys, severity, title)`. Modified → fire **opened**.
     - open and a candidate subjectKey not in `subjectKeys` → `updateOne({ _id,
       lastFiredAt: existing.lastFiredAt }, $set subjectKeys = union, lastFiredAt =
       lastDetectedAt = now, severity, title; $inc fireCount)`. Modified → fire
       **updated**, `newSourceIps` = the new keys for the two source kinds, else `[]`.
     - open, `realertAfterHours > 0` and `existing.lastFiredAt ≤ now −
       realertAfterHours` → same guarded update → **reminder**.
     - otherwise `$set lastDetectedAt, severity, title`. No fire.
5. Every open doc not among the candidate ids and with kind ≠ `test` →
   `updateOne({ _id, status: 'open' }, $set status 'resolved', resolvedAt now)`.
   Modified → fire **resolved** unless the kind is `policy_ready`, the kind is in
   `disabledKinds`, or the domain is ignored or no longer monitored (then silent).
6. Return `{ ran: true, fired, open }`: `fired` = hook deliveries attempted this run;
   `open` = open docs after the run.

The guarded updates are the concurrency control: several instances evaluating at once
fire each event once.

### 6.5 Firing

Before firing opened/updated/reminder, fill `sources[].ptr` with `lookupPtr` (same
resolver) and re-run `finalizeDmarcAlert` so `text` includes them.

`fireDmarcAlert(ctx, alert)`: call `ctx.config.onDmarcAlert` in try/catch →
`delivered` / `no_handler` / `failed` with the error message; for kinds other than
`test`, `updateOne({ _id: alert.id }, $set lastAlert: alert, lastDelivery)`; audit
`{ actor: 'system:dmarc-monitor', action: 'dmarc.alert.<event>', resource: {
collection: 'mailer_dmarc_alerts', id: alert.id }, diffSummary: alert.title }` in
try/catch; return the delivery. Never throws.

`sendTestDmarcAlert(ctx, { now })`: domain = first non-ignored monitored domain, else
`example.com`; `buildTestDmarcAlert(domain, now, config.dmarc?.adminUrl ?? null)`;
`fireDmarcAlert`; no state doc.

Every alert's `adminUrl` is `config.dmarc?.adminUrl ?? null`.

### 6.6 Runner

`runDmarcMonitor(ctx, opts)`: active when `config.dmarc` is defined or
`dmarcReports.estimatedDocumentCount() > 0`; otherwise `{ ran: false, reason:
'inactive' }` and nothing else. When active: `runDmarcDnsChecks` then
`evaluateDmarcAlerts` (same opts); return `{ ran: true }`. Added to the parallel block
in `runner/tick.ts` with the same `.catch(console.error)` shape as its neighbours.

`runDmarcDnsChecks(ctx, opts)`: domains = monitored, non-ignored. With `opts.domain`:
must be one of them (else throw `Error('domain <d> is not monitored')`), always
checked. Otherwise per domain skip when the stored `checkedAt > now −
dnsCheckIntervalHours` unless `force`; `dnsCheckIntervalHours === 0` and not `force` →
`[]`. Calls `checkDmarcDns(domain, { resolver, reportAddress, now, orgDomainInSet })`
where `orgDomainInSet` = the organizational domain differs and is in the domain list.
Upserts `{ _id: domain, result, checkedAt: now }`. Returns the results it produced.

## 7. DNS checks (`dmarc-dns.ts`)

`ENOTFOUND` / `ENODATA` = no records. Any other error code → one `lookup_failed`
warning for that lookup and skip what depended on it (never report `dmarc_missing`
on a failed lookup). TXT records arrive as chunks; join each record's chunks with `''`.

`checkDmarcDns(domain, opts)`:

1. `org = organizationalDomain(domain)` (`psl.get(lowercased) ?? lowercased`).
2. TXT at `_dmarc.{domain}`; keep records matching `/^v=DMARC1\s*(;|$)/i`. None and
   `domain !== org` → TXT at `_dmarc.{org}`; found → `inheritedFrom = org`,
   `dmarc.host = _dmarc.{org}`, add `inherits_org_policy` (info). With
   `orgDomainInSet`, return right there: issues = that one info issue, `ok: true`.
3. None → `dmarc_missing` (error), fix `{ host: '_dmarc.{domain}', type: 'TXT', value:
   'v=DMARC1; p=none; rua=mailto:{reportAddress ?? "you@example.com"}' }`; skip 4–7.
   More than one → `dmarc_multiple` (error), `found true`, `raw` both, parsed fields
   null/empty; skip 4–7.
4. `parseDmarcRecord`: split on `;`, `k=v` trimmed, keys lowercased, `p`/`sp`/`adkim`/
   `aspf` values lowercased. `valid` = `p` ∈ none/quarantine/reject. `pct` integer
   0–100 else null. `rua`/`ruf`: comma-split, strip `mailto:`, strip a `!size` suffix,
   lowercase. Invalid → `dmarc_invalid` (error).
5. `rua` empty → `rua_missing` (error). `reportAddress` set and not in `rua`
   (case-insensitive) → `rua_missing_report_address` (warning).
6. For each rua address whose `organizationalDomain(ruaDomain) !== org`: TXT at
   `{policyDomain}._report._dmarc.{ruaDomain}` (`policyDomain = inheritedFrom ??
   domain`); authorized = a record matches the DMARC1 regex. Not authorized →
   `external_auth_missing` (error), fix `{ host, type: 'TXT', value: 'v=DMARC1' }`.
   Same-organization mailboxes are not looked up at all.
7. MX once per distinct `ruaDomain`; exchanges lowercased, trailing dot stripped.
   Empty → `rua_domain_no_mx` (error). `sendgridInbound` = some exchange ends with
   `sendgrid.net`.
8. SPF: TXT at `{domain}`, records starting `v=spf1`. None → `spf_missing` (warning).
   More than one → `spf_multiple` (error). `all` = last token matching
   `/^[+?~-]?all$/i`, else null. `+all` / `all` → `spf_permissive` (error); `?all` →
   `spf_permissive` (warning).
9. `policy === 'none'` → `policy_none` (info). `pct !== null && pct < 100` →
   `pct_partial` (info).
10. `ok = !issues.some(error)`. `checkedAt = opts.now ?? new Date()`.

`lookupPtr(ips, { resolver, timeoutMs = 2000, concurrency = 8 })`: one entry per
distinct IP; first name, trailing dot stripped, lowercased; error, empty or timeout →
null; never throws. Module cache `ip → { value, at }`, 24 h TTL, max 1000 entries
(evict the oldest). `_clearPtrCache` empties it.

`defaultDmarcDnsResolver` wraps `node:dns/promises` (`resolveTxt`, `resolveMx`,
`reverse`).

---

## 8. Execution

| Role | Who | Where |
|---|---|---|
| Contract + tests | Opus | PR 0 (done) |
| Untested-surface audit | Sonnet, after PR 0, before PR 1 | PR 0.5 |
| Implementation | Sonnet, one agent per task, worktree-isolated | PRs 1A–4 |
| Per-PR gate | Sonnet reviewer, one pass, checklist §9 | each PR |
| Area review | Opus, two passes | integrated `release/0.21` |

Branching: task branches `dmarc/<task>` off `release/0.21`, merged back in order by
the orchestrator.

### Rules in every implementer prompt

- Work only in your worktree. **Never use `git stash`**; commit WIP instead. Never push.
- Touch only the files under **Files**. If another file must change, stop and report.
- The contract (§4) is fixed. If it looks wrong, stop and report. Never delete, skip
  or loosen a test; adding tests is encouraged.
- TypeScript ESM, relative imports end in `.js`, **static imports only** (no
  `require`, no lazy `import()` of a package — see the top of `runner/dmarc.ts`).
  2 spaces, single quotes, no semicolons, trailing commas. Comments only for a
  non-obvious *why*.
- Hook and audit failures are swallowed (`try { … } catch { /* swallow */ }`).
- Done = `yarn typecheck` clean and your named tests green. Paste the final lines.
  Report in under 200 words: files changed, test output, anything uncertain.

### PR 1A — DNS checker · Sonnet
- **Files:** `src/server/runner/dmarc-dns.ts`.
- **Contract:** its stub signatures; §7.
- **Tests:** `test/unit/dmarc-dns.test.ts`.
- **Invariants:** never throws from `lookupPtr`; no network in tests.
- **Non-goals:** DKIM selectors, writing DNS, persistence.

### PR 1B — Settings and alert rules · Sonnet
- **Files:** `src/server/runner/dmarc-settings.ts`, `src/server/runner/dmarc-alerts.ts`.
- **Contract:** stubs; §6.1, §6.3. `computeDmarcAlertCandidates` is pure: no I/O, no
  `Date.now()` (pass `now` into `suggestPolicyProgression`).
- **Tests:** `test/unit/dmarc-settings.test.ts`, `test/unit/dmarc-alerts.test.ts`.
- **Invariants:** `DMARC_SETTINGS_DEFAULTS` never mutated.
- **Non-goals:** the state machine, PTR lookups, firing.

### PR 1C — Monitored domains and ingest provenance · Sonnet
- **Files:** `src/server/runner/dmarc-domains.ts`, `src/server/runner/dmarc.ts`
  (`IngestOptions.via`, written on insert only), `src/server/api/dmarc-inbound.ts`
  (use `deriveSenderDomains` from `dmarc-domains.ts`, delete the private copy and
  its `example.co.uk` comment, pass `via: 'inbound'`, set `mailer.dmarcInboundState
  = { mounted: true, path, allowedDomains: sorted }` after mounting), and one line in
  `src/server/api/admin.ts` (the upload's `ingestDmarcAttachment` call gains
  `{ via: 'upload' }`).
- **Contract:** stubs; §6.2.
- **Tests:** `test/unit/dmarc-domains.test.ts`; still green:
  `test/integration/dmarc-inbound.test.ts`, `test/integration/dmarc.test.ts`.
  The `via` and inbound-state assertions in `dmarc-monitoring-api.test.ts` go green
  once 2B lands.
- **Invariants:** the inbound route's auth-before-body order and domain gate.
- **Non-goals:** any admin route beyond that one line.

### PR 1D — CLI authorization records · Sonnet
- **Files:** `src/cli/setup-dmarc.ts`, `src/cli/index.ts` (help text only).
- **Contract:** `SetupDmarcResult.authRecords`.
- **Behaviour:** for each rua mailbox whose organizational domain (`psl`) differs from
  `--domain`'s: print `{domain}._report._dmarc.{mailboxDomain} TXT "v=DMARC1"` with one
  sentence on why. With `--cloudflare`, `findZoneId(inferZone(mailboxDomain))`; found →
  `upsertRecord`; not found → `warn` naming the record and continue
  (`zone_not_found`). Without Cloudflare → `skipped`. Next-steps step 2 becomes:
  "Reports arrive on their own once the inbound webhook is set up (DMARC Monitoring →
  Setup in the admin UI); until then, upload them there."
- **Tests:** `test/unit/setup-dmarc.test.ts`.
- **Non-goals:** checking live DNS from the CLI.

### PR 2A — Monitor runner · Sonnet (after 1A–1C merge)
- **Files:** `src/server/runner/dmarc-monitor.ts`, `src/server/runner/tick.ts`.
- **Contract:** stubs; §6.4–6.6.
- **Tests:** `test/integration/dmarc-monitor.test.ts`; still green:
  `test/upgrade/zero-config.test.ts`.
- **Invariants:** zero-config untouched (§3.8); one fire per event across concurrent
  evaluations; hook failure never fails the tick.
- **Non-goals:** HTTP routes, UI.

### PR 2B — Admin API · Sonnet (after 2A merges)
- **Files:** `src/server/api/admin.ts` (DMARC section), `src/server/api/setup-status.ts`
  (`checkDmarc` only).
- **Contract:** §5.6. `PUT` audits `dmarc.settings.update` with `diffSummary` listing
  changed key paths (`alerts.windowDays, extraDomains`); `DELETE` audits
  `dmarc.settings.reset`. `GET /dmarc` adds `ptr` via `lookupPtr`.
  `lastInboundReportAt` = newest `receivedAt` with `via: 'inbound'`.
  `reportCount30d` = reports with `rangeEnd` in the last 30 days.
  `checkDmarc`: first, if any stored DNS check has `ok: false` → `warn`, message
  `DNS problems on {domains}`, hint pointing at DMARC Monitoring → Setup; the
  zero-reports hint points at DMARC Monitoring → Setup; the unknown-sources hint says
  to tag them in the admin UI.
- **Tests:** `test/integration/dmarc-monitoring-api.test.ts`; still green:
  `test/integration/deliverability-api.test.ts`.
- **Non-goals:** UI.

### PR 3A — Setup and alerts cards · Sonnet
- **Files:** `src/client/screens/dmarc/setup-card.tsx`, `src/client/screens/dmarc/alerts-card.tsx`.
- **Contract:** `api.ts` types and methods. Reuse `health.tsx` classes (`card`,
  `card-head`, `card-title`, `card-sub`, `card-actions`, `card-body`, `table`,
  `pill green|amber|red`, `btn btn-xs`, `text-xs`, `subtle`, `mono`, `hstack`). No new
  CSS, no dependencies, no emoji.
- `SetupCard({ data, onChanged })`, card title `Setup`, numbered steps with a pill each:
  1. *Reports arrive automatically* — green when `inbound.mounted`; else the snippet
     `createPublicRouter(mailer, { dmarcInbound: { secret: process.env.MAILERY_DMARC_SECRET } })`
     and "Until then, upload reports by hand below."
  2. *Inbound Parse points at Mailery* — `https://mailery:<YOUR_SECRET>@{host+path of inbound.url}`
     with a Copy button and "Your provider's inbound-parse destination URL. The secret
     is the one in your config; Mailery never displays it."
  3. *Report address* — `settings.reportAddress`, or amber "Not set. Set it in Settings below."
  4. *DNS* — one row per non-ignored domain: domain, policy, pill `OK` / `N problem(s)`
     / `Not checked`, checked-at; expands to every issue's message and, when `fix`
     exists, `{host}  {type}  "{value}"` in `mono` with a Copy button. Button
     `Re-check DNS` → `api.checkDmarcDns()` then `onChanged()`.
  5. *Reports are arriving* — per domain `lastReportAt` and `reportCount30d`; amber when none.
  6. *Alerts reach you* — green when `alertHandlerConfigured`; else amber with the
     snippet `onDmarcAlert: async (alert) => { await postToSlack(alert.text) }`.
     Button `Send test alert` → `api.sendTestDmarcAlert()`; outcome inline:
     `Delivered` (green), `No onDmarcAlert handler is configured` (amber),
     `Failed: {error}` (red).
- `AlertsCard({ data, onChanged })`, card title `Alerts`: open alerts (severity pill,
  title, domain, first detected, last delivery outcome; expands to `lastAlert.text` in a
  `<pre>`); button `Run checks now` → `api.evaluateDmarcAlerts()` then `onChanged()`;
  a collapsed `History` list of `alerts.recent`. Empty: `No open alerts.`
- **Tests:** the e2e test (green after PR 4).
- **Non-goals:** routing, the Health screen.

### PR 3B — Settings card · Sonnet
- **Files:** `src/client/screens/dmarc/settings-card.tsx`.
- `SettingsCard({ data, onChanged })`, card title `Settings`: `Alerts enabled`
  checkbox; one checkbox per kind (checked = not disabled) with a one-line plain
  description; labelled number inputs — `Lookback window (days)` (`windowDays`),
  `Unknown sender threshold (messages)`, `Known sender threshold (messages)`,
  `Minimum pass rate (%)` (shown and edited as a percentage), `Minimum messages for
  pass-rate alerts`, `Reports stopped after (days)`, `Remind after (hours, 0 = never)`,
  `DNS check every (hours, 0 = never)`; `Report address` input; `Extra domains` and
  `Ignored domains` textareas, one per line. Every input has a `<label htmlFor>`.
  `Save` → `api.saveDmarcSettings(changed keys only)`; `Reset to defaults` shown only
  when `hasDbOverride`. Shows the server's message on 400. Muted line: "Secrets (the
  inbound webhook secret) and the alert handler are set in your app's Mailery config,
  not here."
- **Tests:** the e2e test (green after PR 4).

### PR 3C — Docs · Sonnet
- **Files:** `docs/guide/deliverability.md` (DMARC section), `docs/guide/configuration.md`,
  `docs/guide/admin-ui.md`, `docs/guide/upgrading-0.21.md`, `CHANGELOG.md` (0.21.0
  entry), `plans/deliverability-roadmap.md`, `plans/13-roadmap.md`,
  `examples/express-mongo` (add `dmarcInbound` and an `onDmarcAlert` that logs
  `alert.text`).
- DMARC section order: why (§1, plain language, define every term); 15-minute setup
  (inbound-parse host + MX → `rua=` → authorization record when the mailbox is on
  another domain → `dmarcInbound.secret` → verify in the GUI); the alert table in
  plain English; a Slack `onDmarcAlert` example and an email one; the `DmarcAlert`
  field reference; GUI settings vs config; the inbound security note summarized;
  non-goals. CHANGELOG bullets in the file's voice under "Added".
- **Gate:** `yarn docs:build`.

### PR 4 — Screen assembly · Sonnet (after 3A, 3B)
- **Files:** `src/client/screens/dmarc/index.tsx`, `src/client/screens/health.tsx`,
  `src/client/app.tsx`, `src/client/components/shell.tsx`.
- `index.tsx` exports `Dmarc`, heading `DMARC Monitoring`. Top to bottom: a short
  explainer (three sentences from §1, link to the guide); `AlertsCard`; `SetupCard`;
  the domains and failing-sources tables **moved out of `health.tsx`** with
  `DmarcSourceRow`, the upload input and its state (button `Upload report(s)`), plus a
  `Reverse DNS` column (`ptr`) and a `Recent reports` table with a `Via` column;
  `SettingsCard`. Two `useLive` calls (`api.dmarc()`, `api.dmarcMonitoring()`); every
  `onChanged` refetches both.
- `health.tsx`: replace the two DMARC cards with one card titled `DMARC RUA reports`
  (per-domain pass rate, open-alert count, button `Open DMARC Monitoring` →
  `setRoute({ screen: 'dmarc' })`). Delete what becomes unused.
- `app.tsx`: route `dmarc`, crumbs `['Mailery', 'DMARC Monitoring']`. `shell.tsx`:
  `<Item icon={Icons.Health} label="DMARC Monitoring" screen="dmarc" />` under Health.
- **Tests:** `test/e2e/deliverability.spec.ts`; gate also `yarn build`.

## 9. Sonnet per-PR review checklist

One pass, output a list or "clean": files outside **Files**; tests deleted, skipped or
loosened; contract edits; spec section vs diff gaps; new paths without a test;
`console.log`, TODO, commented-out code; docs for every new public surface. No design
re-derivation.

## 10. Opus area reviews (integrated `release/0.21`)

- **R1 — Alert correctness and concurrency.** Walk §6.3–6.5 against the code. Guarded
  updates under three concurrent evaluators; reopen after resolve; silent-resolve
  cases; `receivedAt` never used for windows; hook/audit failures contained;
  `alert.text` matches the payload.
- **R2 — Upgrade safety and exposure.** Zero-config snapshot green and the gate truly
  idle (no DNS, no extra reads); inbound secret never reaches the admin payload or
  logs; settings validation is the only write path from the GUI; new collections need
  no migration; e2e flow in the browser.

Findings go back as Sonnet fix PRs.

## 11. Order

```
PR0 (Opus, done) ─► 0.5 audit ─► 1A 1B 1C 1D (parallel) ─► 2A ─► 2B ─┐
                                 3A 3B 3C (parallel, after 0.5) ─────┴► 4 ─► R1 R2 ─► done
```

## 12. Rollout for the maintainer's domains (DNS read 2026-09-17)

| Domain | `_dmarc` | Problems |
|---|---|---|
| `jeffjassky.com` | `p=none; rua=mailto:dmarc@jeffjassky.com` | none; SPF covers Google + SendGrid |
| `maxedmarketing.ai` | `p=none; rua=mailto:jeff@jeffjassky.com` | no `maxedmarketing.ai._report._dmarc.jeffjassky.com`; no SPF, no MX at the apex |

After 0.21 ships in a host app:
1. Inbound host `dmarc-in.jeffjassky.com`: MX → `mx.sendgrid.net`; SendGrid Inbound
   Parse destination `https://mailery:<secret>@<app>/m/inbound/dmarc`.
2. `dmarcInbound.secret`, `dmarc.reportAddress: 'reports@dmarc-in.jeffjassky.com'`,
   `onDmarcAlert` posting `alert.text` to Slack.
3. `rua=mailto:reports@dmarc-in.jeffjassky.com,mailto:dmarc@jeffjassky.com` on each
   domain (keeps the Gmail copy until the pipeline is trusted).
4. `*._report._dmarc.dmarc-in.jeffjassky.com TXT "v=DMARC1"` once.
5. Each app accepts only its own sender domains: one inbound host per app, or one app
   with every domain in `dmarcInbound.allowedDomains`.

## 13. Done

All §4 tests green on `release/0.21`; full suite, `yarn typecheck`, `yarn build`,
`yarn docs:build` and `yarn test:e2e` green; R1–R2 findings closed.
