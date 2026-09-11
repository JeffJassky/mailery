# Admin REST API

Mounted under `/api` inside `createAdminRouter(mailer)`. With the default mount path `/admin/mailer`, endpoints live at `/admin/mailer/api/*`. Gated by your host's auth middleware.

All requests/responses are JSON. Mutating endpoints write to `mailer_audit_log` automatically with `actor` resolved via `getActor` (default `human:${req.user?.email ?? 'anonymous'}`).

## Identity

### `GET /api/me`

```ts
→ { actor: string, permissions: { canPublish: boolean, canSendBroadcasts: boolean, canManageSuppressions: boolean } }
```

Called by the SPA on boot. The permissions object hides UI buttons the user can't activate.

## Dashboard

### `GET /api/dashboard`

Aggregated KPIs + recent activity.

```ts
→ {
  kpis: {
    sends: { value: number, delta: number | null }
    deliveredRate: { value: number, delta: number | null, bounced: number }
    openRate: { value: number, delta: number | null, exclBots: boolean }
    clickRate: { value: number, delta: number | null }
  }
  health: { status: 'healthy' | 'degraded' | 'tripped', rates: Record<string, number> }
  queue: { inFlight: number, delayed: number, providerOk: boolean, providerName: string }
  recentFlows: FlowDoc[]
  recentSends: SendDoc[]
  recentAudit: AuditLogDoc[]
}
```

## Events registry

### `GET /api/events`
The full event registry — declared events with their dedupe policies, the event names seen in `mailer_events` that nobody registered, and per-name volume so a registered trigger can be checked against what the host really fires. A name in `registered` with no `stats` entry (or none in `last30d`) is a trigger nobody is reaching.

```ts
→ {
  registered: { name: string; dedupePolicy: 'once-per-contact' | 'once-per-day' | 'every-time' }[]
  seen: string[]                       // names in mailer_events that are not registered
  stats: Record<string, {              // keyed by event name, registered or not
    total: number                      // rows ever
    last7d: number
    last30d: number
    firstAt: string                    // ISO
    lastAt: string
  }>
}
```

## Flows

### `GET /api/flows`
List all flows, newest-updated first.

### `GET /api/flows/:slug`
Single flow's full definition.

### `POST /api/flows/:slug/pause`
Set `enabled: false`. In-flight runs continue.

### `POST /api/flows/:slug/resume`
Set `enabled: true`.

## Templates

### `GET /api/templates`
List all templates, newest-updated first.

### `GET /api/templates/:slug`
Single template's full definition.

### `PATCH /api/templates/:slug/draft`
Stage changes on the template's unpublished draft. Every field is optional; only the ones present are written, so the editor can save one field without round-tripping the rest. A template with no draft yet gets one seeded from its published values first.

Exactly one of `html`, `mjml` or `editorJson` describes the body, and publish resolves them in that authoring precedence (`editorJson` → `mjml` → raw `html`). Sending `mjml: ''` or `editorJson: null` clears that source, which is how a template changes authoring mode.

`fromEmail` and `kind` are validated against the `senderDomains` registry as a pair, whether one or both are supplied.

```ts
body: {
  subject?: string
  preheader?: string
  html?: string
  mjml?: string
  editorJson?: Record<string, unknown> | null
  notes?: string
  name?: string
  fromName?: string
  fromEmail?: string
  replyTo?: string | null
  kind?: 'marketing' | 'transactional'
  bodyFormat?: 'multipart' | 'text_only'
  trackOpens?: boolean
  trackClicks?: boolean
}
→ { ok: true }
→ 400 { error: 'sender_domain_invalid', code: string, message: string }
```

## Broadcasts

### `GET /api/broadcasts`
List all broadcasts, newest-created first, each with `stats` computed from its sends (see [broadcasts → stats](/guide/broadcasts#stats); the four keys `delivered`, `opened`, `clicked`, `bounced` are always present).

### `GET /api/broadcasts/:slug`
Single broadcast with `stats`.

### `POST /api/broadcasts`
```ts
{ slug, name, templateSlug, segmentDefinition?, respectRecipientTimezone?, recipientCap?, order?, stopRules? }
→ { ok: true, slug }
→ 400 { error: 'validation_failed' | 'invalid_segment' | 'invalid_recipient_cap' | 'invalid_order' | 'invalid_stop_rules' }
→ 409 { error: 'slug_taken' | 'template_not_marketing' }
→ 422 { error: 'adapter_cannot_sort' }
```
The segment is validated leniently here (types only), so the composer can save a half-filled row; scheduling validates strictly.

### `PATCH /api/broadcasts/:slug`
Same fields as create except `slug`. Draft only. `→ { ok: true }`, `409 not_draft`.

### `POST /api/broadcasts/:slug/segment/count`
```ts
{ segmentDefinition }       // the segment being edited, not necessarily saved
→ { upperBound, approximate: false, computedMs, hostMatched, eligible, alreadySent, recipientCount }
```
Since 0.18 `upperBound` is the **exact** count dispatch would send (host filter, post-filters, suppression, cap) — it keeps its name because the composer reads it. It was the host filter alone.

### `POST /api/broadcasts/:slug/schedule`
```ts
{ scheduledAt, confirmedCount, respectRecipientTimezone? }
→ { ok: true }
→ 400 { error: 'scheduledAt_required' | 'bad_scheduledAt' | 'confirmedCount_required' | 'invalid_segment' }
→ 409 { error: 'not_draft' | 'template_not_found' | 'template_not_marketing' | 'template_not_published' }
```
The admin path does not compare `confirmedCount` with the count (the composer's typed-count gate does); the agent path does.

### `POST /api/broadcasts/:slug/cancel`
`→ { ok: true }`. Cancels the broadcast's queued and held sends as well; `409 already_finished` for a sent or failed broadcast with nothing left to send.

Waves, stop-rule overrides, pause, resume and test sends are on the [agent API](/reference/agent-api#broadcasts).

## Contacts

### `GET /api/contacts`
Paginated list via the adapter.

```
?cursor=<string>&limit=<number>     (limit max 200)
→ { contacts: Contact[], nextCursor?: string }
```

### `GET /api/contacts/:externalId`
Contact detail — adapter fields + subscription + recent events + recent sends + active flow runs.

```ts
→ {
  contact: Contact
  subscription: SubscriptionDoc | null
  recentEvents: EventDoc[]
  recentSends: SendDoc[]
  activeRuns: FlowRunDoc[]
}
```

## Sends

### `GET /api/sends`

```
?status=<SendStatus>&limit=<number>  (limit max 500)
→ SendDoc[]
```

### `GET /api/sends/:id`

```ts
→ { send: SendDoc, webhookEvents: WebhookEventDoc[] }
```

## Suppressions

### `GET /api/suppressions`
List, newest-added first (limit 500).

### `POST /api/suppressions`

```ts
body: {
  email: string
  scope: 'all' | 'marketing' | 'transactional'
  reason: 'unsubscribed' | 'hard_bounce' | 'complaint' | 'manual' | 'list_cleaning' | 'gdpr_forget'
  source?: string
  notes?: string
}
→ { ok: true }
```

## Audit log

### `GET /api/audit`
List, newest-first (limit 200).

## Vars schema

### `GET /api/vars-schema`
The host's `varsAdapter` schema as JSON Schema (drives editor autocomplete and the `unknown_variable` lint rule), plus the built-in render-context keys.

```ts
→ { schema: JSONSchema | null, builtins: string[] }
```

## Templates — preview + test send

### `POST /api/templates/:slug/preview`
Render the draft (or published body with `useDraft: false`). Pass `contactId` to render as a real contact — the contact is loaded through the adapter and the `varsAdapter` resolver runs (`reason: 'preview'`). Without it, a sample contact and empty host vars are used.

Pass `html`, `mjml` or `editorJson` to render that content instead of the stored draft, resolved in the usual authoring precedence. This is how the editor previews unsaved edits: a preview is a read, and making one should not write a draft — which is an audit-logged mutation — just to see the result.

Pass `eventProperties` to simulate a trigger event — both `{{event.*}}` and the resolver's `info.eventProperties` receive it.

```ts
body: {
  useDraft?: boolean
  contactId?: string
  sampleContact?: Contact
  vars?: Record<string, unknown>
  eventProperties?: Record<string, unknown>
  html?: string
  mjml?: string
  editorJson?: Record<string, unknown> | null
}
→ { subject, preheader, html, plainText, contact: { externalId, email } }
→ 404 { error: 'contact_not_found', contactId }
→ 409 { error: 'not_published', message }
→ 422 { error: 'compile_failed', message }
→ 502 { error: 'vars_resolve_failed', message }
```

### `POST /api/templates/:slug/send-test`
Send the published template to an operator-typed address. With `contactId`, the render uses that contact's data + resolved host vars (`reason: 'test'`) while still delivering to `to`.

```ts
body: { to: string; contactId?: string; sampleData?: { contact?: Contact; vars?: Record<string, unknown> }; eventProperties?: Record<string, unknown> }
→ { ok: true, providerId: string }
```

## Templates — content linter + Mail-Tester

### `POST /api/templates/:slug/lint`
Run the content linter against a draft. Body fields are all optional — missing fields fall back to the saved draft, then to the last published values. When the effective source resolves to raw HTML (see [Templates → Hand-written HTML](/guide/templates#hand-written-html)), the response's `errors` / `warnings` arrays also carry markup issues (unclosed tags, a `<script>` tag, a missing `<html>`/`<body>` wrapper, and the like) alongside the usual content rules.

```ts
body: {
  subject?: string
  preheader?: string
  mjml?: string
  html?: string
  editorJson?: Record<string, unknown> | null
  fromEmail?: string
  kind?: 'marketing' | 'transactional'
}
→ {
  errors:   { rule: string; severity: 'error';   message: string; hint?: string }[]
  warnings: { rule: string; severity: 'warning'; message: string; hint?: string }[]
  infos:    { rule: string; severity: 'info';    message: string; hint?: string }[]
  compileFailed: boolean
}
```

### `POST /api/templates/:slug/publish`
Publish the saved draft — its content may live in `html`, `mjml` or `editorJson`, resolved in that authoring precedence (`editorJson` → `mjml` → raw `html`); an HTML-only draft is stored verbatim with plain text derived. Rejects with 422 if the linter has errors. Rejects with 422 `mail_tester_blocked` when a cached Mail-Tester score is below `minScore` (`code: 'low_score'`), or — with `mailTester.requireScore` enabled — when the content has no score at all (`code: 'no_score'`, `score: null`). Pass `{ bypassMailTester: true }` to override the Mail-Tester gate (still subject to the lint gate).

```ts
body?: { bypassMailTester?: boolean }
→ 200 { ok: true, version: number, warnings: CompilerWarning[], lint: LintResult }
//   CompilerWarning ≈ { line?: number; message: string; tagName?: string; formattedMessage?: string }
//   These come from the MJML / Maily compiler — formatting warnings that did
//   not block compile (e.g. unknown attributes). Distinct from lint issues.
→ 422 { error: 'lint_failed', message: string, lint: LintResult }
→ 422 { error: 'mail_tester_blocked', message: string, score: MailTesterScoreDoc, hint: string }
```

### `GET /api/templates/:slug/mail-tester`
Mail-Tester status + the cached score for the current content fingerprint, if one exists.

```ts
→ {
  configured: boolean
  minScore: number
  cacheHours: number
  score: MailTesterScoreDoc | null
}
```

### `POST /api/templates/:slug/mail-tester-check`
Provision a Mail-Tester check, send the rendered draft to the test address via the default provider, return either a cached score or a pending checkId to poll.

```ts
→ {
  cached: boolean
  status: 'pending' | 'ready'
  checkId?: string
  contentKey?: string
  score?: MailTesterScoreDoc
  message?: string
}
```

Returns `400 { error: 'not_configured' }` when `MailerConfig.mailTester` is absent.

### `GET /api/templates/:slug/mail-tester-result?checkId=...&contentKey=...`
Poll the in-progress check. Returns `{ status: 'pending', score: null }` until Mail-Tester is ready, then the persisted score.

## Health

### `GET /api/health`
Per-(sender domain × kind) buckets plus the aggregate roll-up plus the configured trip thresholds. The top-level `status` is the worst bucket status (or `null` when no tick has run).

```ts
→ {
  status: 'healthy' | 'degraded' | 'tripped' | null
  rates: { bounceRate, hardBounceRate, complaintRate, failureRate } | null
  counters: HealthCounters | null
  aggregate: HealthDoc | null
  buckets: HealthDoc[]
  thresholds: {
    hardBounceRatePctTrip: number
    complaintRatePctTrip: number
    combinedBounceRatePctTrip: number
    failedToSendRatePctDegrade: number
  }
}
```

### `POST /api/health/resume`
Manual reset. Pass `{ senderDomain, kind }` to resume one bucket. Empty body resumes every tripped bucket.

```ts
body?: { senderDomain?: string; kind?: 'marketing' | 'transactional' }
→ { ok: true, resumed: number }
```

Audit-logged.

### `GET /api/health/trips`
The last 50 `health.trip` / `health.resume` audit-log rows.

## DNSBL

### `GET /api/dnsbl`
Latest scan results across all configured targets and lists.

```ts
→ {
  checks: DnsblCheckDoc[]
  latestRunAt: string | null
  intervalHours: number
}
```

### `POST /api/dnsbl/recheck`
Force an immediate scan (ignores throttle). Audit-logged.

```ts
→ { ran: boolean; reason?: string; totalChecks?: number; listedCount?: number }
```

## Google Postmaster Tools

### `GET /api/postmaster`

```ts
→ {
  configured: boolean
  intervalHours: number
  domains: Array<{
    domain: string
    latest: PostmasterSnapshotDoc | null
    history: PostmasterSnapshotDoc[]   // up to 30
  }>
}
```

### `POST /api/postmaster/refresh`
Force an immediate pull (ignores throttle). Audit-logged.

```ts
→ { ran: boolean; reason?: string; fetched?: number; trippedDomains?: string[] }
```

## Microsoft SNDS

### `GET /api/snds`

```ts
→ {
  configured: boolean
  intervalHours: number
  ips: Array<{
    ip: string
    latest: SndsSnapshotDoc | null
    history: SndsSnapshotDoc[]   // up to 30
  }>
}
```

### `POST /api/snds/refresh`
Force an immediate pull (ignores throttle). Audit-logged.

```ts
→ { ran: boolean; reason?: string; rowsParsed?: number; rowsPersisted?: number }
```

## DMARC

### `GET /api/dmarc`

```ts
→ {
  domains: Array<{
    domain: string
    passCount: number
    failCount: number
    totalMessages: number
    reportCount: number
    latestRangeEnd: string | null
    alignmentRate: number | null
    currentPolicy: 'none' | 'quarantine' | 'reject' | null
    currentPct: number | null
    progression: { policy, pct, reason, current: { policy, pct } } | null
    series: Array<{ day: string; alignmentRate: number | null }>   // last 14 days
  }>
  sources: Array<{
    sourceIp: string
    domain: string
    totalMessages: number
    daysSeen: number
    lastSeen: string
    dkimResult: string
    spfResult: string
    dispositionApplied: string
    label: string | null
    ignored: boolean
    tagSource: 'config' | 'db' | null
  }>
  recentReports: DmarcReportDoc[]   // up to 30
  retentionDays: number
}
```

### `POST /api/dmarc/upload`
Upload one `.zip` / `.gz` / `.xml` aggregate report as `multipart/form-data` with a `file` field. Audit-logged.

```ts
→ {
  ok: true
  reportId: string
  domain: string
  rangeStart: string
  rangeEnd: string
  totalMessages: number
  passCount: number
  failCount: number
  duplicate: boolean
}
```

Returns `400` for `no_file` / `ingest_failed` (with the parse error in `message`).

### `PUT /api/dmarc/sources/:ip`
Tag a DMARC source IP as known.

```ts
body: { label: string; ignored?: boolean }
→ { ok: true }
```

### `DELETE /api/dmarc/sources/:ip`
Remove a DB-set tag (config-set tags can't be deleted via the API — edit `MailerConfig.dmarc.knownSources`).

```ts
→ { ok: true; deleted: number }
```

## List hygiene

### `GET /api/hygiene`

```ts
→ {
  totalSubscribers: number
  totalWithSends: number
  buckets: Array<{
    label: string                       // "Engaged (last 30 days)", etc
    minDays?: number | null
    maxDays?: number | null
    neverEngaged?: boolean
    count: number
    pctOfTotal: number
  }>
  sunsetCandidate: {
    count: number
    pctOfTotal: number
    cohortLifetime: {
      totalSends: number
      bouncedRate: number
      hardBouncedRate: number
      complaintRate: number
    } | null
    projectedImpact: {
      recentTotalSends: number
      recentBounced: number
      recentComplained: number
      cohortRecentSends: number
      cohortRecentBounced: number
      cohortRecentComplained: number
      currentOverallBounceRate: number
      projectedBounceRate: number
      currentOverallComplaintRate: number
      projectedComplaintRate: number
    } | null
  }
  computedAt: string
}
```

## Error shape

All errors return:

```ts
{ error: string, message?: string }
```

Common error codes:

| Code | Status | Meaning |
|---|---|---|
| `not_found` | 404 | Resource doesn't exist |
| `bad_id` | 400 | Invalid ObjectId / slug format |
| `validation_failed` | 400 | Request body failed Zod parse |
| `forbidden` | 403 | Permission denied (when `resolvePermissions` is set) |

## Pagination

Endpoints that paginate use opaque cursor strings. Pass `?cursor=<nextCursor>` to fetch the next page. `nextCursor` is omitted on the last page.

Limits are bounded per endpoint (100-500 typical max).

## Versioning

The admin API is internal — coupled to the SPA shipped in the same `mailery` package version. Endpoints may change between mailery releases without major version bumps. Don't build external integrations against `/admin/mailer/api/*` — use the `Mailer` class methods instead.
