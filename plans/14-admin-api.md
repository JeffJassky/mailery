# 14 — Admin REST API

The JSON surface the React SPA (`09-admin-ui.md`) consumes. Lives under `/admin/mailer/api/*`, gated by the same host auth middleware that protects the SPA shell. Not a public API — host code talks to mailer directly via the public methods (`10-public-api.md`).

## Conventions

- **Base path**: whatever the host mounted the admin router on, plus `/api`. Examples below assume `/admin/mailer/api`.
- **Auth**: host's middleware runs before the router. `req.user` populated. The router itself does no auth.
- **Content type**: all bodies are JSON. `Content-Type: application/json`.
- **Dates**: ISO 8601 strings on the wire; `Date` objects internally.
- **Pagination**: cursor-based. Responses include `nextCursor` when more rows exist. Clients pass `?cursor=...` to fetch the next page.
- **Errors**: `{ error: 'code', message: 'human readable' }` with appropriate HTTP status. Codes are lowercase snake_case.
- **Audit**: every mutating endpoint writes a `mailer_audit_log` row with `actor` resolved via `getAdminActor(req)`.

## Endpoint catalogue

### Dashboard

```
GET  /api/dashboard
```

Returns the KPI rollup + recent activity for the dashboard landing page.

```ts
{
  kpis: {
    sends: { value: number, delta: number }
    deliveredRate: { value: number, delta: number, bounced: number }
    openRate: { value: number, delta: number, exclBots: boolean }
    clickRate: { value: number, delta: number }
  }
  health: { status: 'healthy' | 'degraded' | 'tripped', rates: {...} }
  queue: { inFlight: number, delayed: number, providerOk: boolean, providerName: string }
  sendSeries: number[]   // 24h hourly
  openSeries: number[]
  recentFlows: FlowSummary[]
  recentSends: SendSummary[]
  recentAudit: AuditEntry[]
}
```

### Flows

```
GET    /api/flows                     # list
GET    /api/flows/:slug               # detail + active draft
POST   /api/flows                     # create (always disabled, draft only)
PATCH  /api/flows/:slug/draft         # update draft.steps + notes
POST   /api/flows/:slug/publish       # promote draft → live + snapshot
POST   /api/flows/:slug/pause         # enabled = false (in-flight runs continue)
POST   /api/flows/:slug/resume        # enabled = true
POST   /api/flows/:slug/stop          # enabled = false + bulk-exit active runs
DELETE /api/flows/:slug               # only allowed if no flow_runs ever entered
GET    /api/flows/:slug/runs          # paginated active runs
GET    /api/flows/:slug/runs/:runId   # single run detail (history, current step)
POST   /api/flows/:slug/runs/:runId/cancel
POST   /api/flows/:slug/runs/:runId/skip-step
```

`GET /api/flows/:slug` returns the full flow document plus stats:

```ts
{
  slug, name, description, trigger, enabled, version, goal, audience,
  steps: FlowStep[], draft: { steps, notes, lastModifiedBy, lastModifiedAt } | null,
  stats: { activeRuns, completedRuns, sendsTotal, sendsLast7Days },
  publishedAt, publishedBy, createdAt, updatedAt
}
```

### Templates

```
GET    /api/templates                       # list
GET    /api/templates/:slug                 # detail + draft
POST   /api/templates                       # create
PATCH  /api/templates/:slug/draft           # update draft fields (subject, preheader, mjml, notes)
POST   /api/templates/:slug/publish         # compile MJML, derive plaintext, write body.*, snapshot
POST   /api/templates/:slug/preview         # body: { sampleData }; returns { html, plainText, subject, preheader }
POST   /api/templates/:slug/send-test       # body: { to, sampleData }
POST   /api/templates/:slug/rollback        # body: { toVersion }
GET    /api/templates/:slug/versions
DELETE /api/templates/:slug                 # only allowed if not referenced by any flow
```

### Broadcasts

```
GET    /api/broadcasts                  # list
GET    /api/broadcasts/:slug
POST   /api/broadcasts                  # create as draft
PATCH  /api/broadcasts/:slug            # edit draft (template, segment, schedule)
POST   /api/broadcasts/:slug/segment/count    # body: { segmentDefinition }; returns 3-stage count
POST   /api/broadcasts/:slug/schedule   # body: { scheduledAt, confirmedCount }; gate enforced
POST   /api/broadcasts/:slug/cancel
DELETE /api/broadcasts/:slug
```

`segment/count` is the live recomputation the broadcast composer calls on every filter change. Returns:

```ts
{
  stageA: number          # after host filter (via adapter)
  stageB: number          # after mailer post-filter
  afterSuppression: number # final
  computedMs: number
}
```

The schedule endpoint enforces `INVARIANT 11`: requires `confirmedCount` to equal the live count, else 400.

### Contacts

```
GET    /api/contacts                       # search; query params: q, status, tag, cursor
GET    /api/contacts/:externalId
POST   /api/contacts/:externalId/tag       # body: { tag }
POST   /api/contacts/:externalId/untag     # body: { tag }
POST   /api/contacts/:externalId/unsubscribe  # body: { scope, reason, notes }
POST   /api/contacts/:externalId/event     # body: { name, properties }; manual fire
POST   /api/contacts/:externalId/forget    # GDPR right-to-erasure
GET    /api/contacts/:externalId/export    # GDPR data export
```

`GET /api/contacts/:externalId` returns adapter fields + mailer-side state (subscription, recent events, recent sends, active flow_runs, suppression check results).

### Sends

```
GET    /api/sends                       # filter by template, status, flow, date range; cursor
GET    /api/sends/:id                   # full send doc + webhook events for that send
POST   /api/sends/:id/resend            # clone with new dedupeKey
```

### Suppressions

```
GET    /api/suppressions                # filter by reason, scope; cursor
POST   /api/suppressions                # body: { email, scope, reason, source, notes }
DELETE /api/suppressions/:id            # audit-logged
```

### Audit log

```
GET    /api/audit                       # filter by actor, action, resource; cursor
GET    /api/audit/:id                   # full diff
```

### Health

```
GET    /api/health                      # mailer_health snapshot
POST   /api/health/resume               # manual circuit-breaker reset; audit-logged
POST   /api/health/pause                # operator-initiated pause-all-sends
GET    /api/health/providers            # per-provider verifyDomainAuth status
```

### Boot

```
GET    /api/me                          # { actor, permissions }
```

Called by the SPA on mount. The host's `getAdminActor` resolves the actor string; the optional `resolvePermissions` hook (`09-admin-ui.md` § Auth) returns the permission map the UI uses to hide unavailable actions.

## V1 implementation status

The current `createAdminRouter()` returns sample JSON for the GET endpoints used by the dashboard. Mutating endpoints, search endpoints, and the full data-model-backed reads land in Phase 2 alongside the runner + collection-helper modules.

## Out of scope for V1

- Server-Sent Events / WebSockets (V2 — see "Live-update patterns" in `09-admin-ui.md`).
- Bulk operations (multi-row suppression add, batch contact tag) — single-row only.
- File uploads (CSV import for suppressions, template MJML import via dropzone) — V3.
- Rate limiting on the API surface — host's responsibility; the admin route is behind their auth gate.
