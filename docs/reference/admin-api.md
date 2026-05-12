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

## Broadcasts

### `GET /api/broadcasts`
List all broadcasts, newest-created first.

### `GET /api/broadcasts/:slug`
Single broadcast.

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

## Health

### `GET /api/health`
The `mailer_health` singleton document, with safe defaults if uninitialized.

### `POST /api/health/resume`
Manual circuit-breaker reset.

```ts
→ { ok: true }
```

Audit-logged.

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
