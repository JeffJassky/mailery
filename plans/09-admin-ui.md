# 09 — Admin UI

A mountable Express router that serves a **prebuilt React SPA** and the REST endpoints the SPA consumes. No build step required in consumer apps — the SPA is bundled at library publish time and shipped inside the npm tarball.

## Mounting

```ts
import { Mailer, createAdminRouter } from 'mailery'

const mailer = await Mailer.init({ /* ... */ })

// Gate with the host's existing auth middleware
app.use('/admin/mailer', requireAdmin, createAdminRouter())
```

The router mounts at exactly **`/admin/mailer`** in V1 — the SPA's asset URLs are baked in at build time. (Future: configurable mount path via runtime base-href injection.)

## Tech choices

- **React 18** + Vite-bundled SPA, shipped as static files at `dist/admin/spa/index.html` + `dist/admin/spa/index-<hash>.{js,css}`.
- **No bundler in consumer apps.** The host installs `mailery`, mounts the router, and the prebuilt SPA loads in the operator's browser.
- **Bundle size**: ~232 KB JS / ~63 KB gzipped, ~18 KB CSS / ~4 KB gzipped (V1 baseline). Targets <300 KB gzipped through Phase 3.
- **Hand-rolled CSS variables** for design tokens (see `src/client/styles.css`). No Tailwind, no CSS-in-JS. Tokens cover light + dark themes, accent color, density.
- **Lucide-style hand-rolled icons** as inline SVG components (no icon-pack dependency).
- **State management**: React local state. No Redux/Zustand. The screens are mostly read-only — REST fetch + render.
- **Client-side routing**: simple `useState({ screen, slug, id })`. Hash-based URLs (future) for deep linking.

Why React over htmx: the mockup polish (see `plans/design/client/`) is past the threshold where server-rendered HTML feels like a downgrade. A 60 KB gzipped bundle behind your auth gate is acceptable for an admin surface.

## Layout structure

The SPA's source lives at `src/client/`:

```
src/client/
├── index.html              # Vite entry
├── vite.config.ts          # base: '/admin/mailer/_assets/'
├── tsconfig.json
├── main.tsx                # ReactDOM.createRoot mount
├── app.tsx                 # routing + theme state
├── components/
│   ├── icons.tsx           # SVG icon set
│   └── shell.tsx           # Sidebar, Topbar, PageHead, StatusPill
├── screens/                # one file per route
│   ├── dashboard.tsx
│   ├── flows.tsx flow-detail.tsx
│   ├── templates.tsx template-editor.tsx
│   ├── broadcasts.tsx broadcast-new.tsx
│   ├── contacts.tsx contact-detail.tsx
│   ├── sends.tsx send-detail.tsx
│   ├── suppressions.tsx audit.tsx health.tsx
└── lib/
    ├── api.ts              # fetch wrappers for /admin/mailer/api/*
    └── mock.ts             # sample data for dev / Storybook
```

The build pipeline (`yarn build:client`) outputs to `dist/admin/spa/`. The server router (`src/server/api/admin.ts`) serves it.

## Views

### Dashboard (`/`)

Landing page on mount. Shows:

- Health summary (circuit breaker status, last hour's bounce/complaint rates, current `mailer_health` document)
- Active flows (table: name, version, active runs, sends last 7d)
- Recent sends (last 50, with status icons)
- Recent audit log entries (last 20)
- Quick links: new template, new broadcast, suppressions, contacts search

If `mailer_health.status === 'tripped'`, a prominent red banner shows reason + a "Resume sending" button (audit-logged).

### Flows list (`/flows`)

Table of all flows:

| Slug | Name | Enabled | Trigger | Active Runs | Sends 7d | Version |
|---|---|---|---|---|---|---|
| activation-rescue | Activation Rescue | ✓ | event: Downloaded app | 23 | 47 | v3 |
| pro-welcome | Pro Welcome | ✓ | event: Customer | 8 | 12 | v1 |
| ... | ... | ✓ | ... | ... | ... | ... |

Click into a flow → detail page.

### Flow detail (`/flows/:slug`)

Shows:

- Flow metadata (name, description, trigger, goal, audience)
- Visualization of steps (text-rendered tree, not drag-drop)
- Stats by step (sends per step, drop-off curve)
- Currently active runs (table; click a row to see the run's history)
- Recent completed runs
- Draft section — if there's a draft, show diff vs. live + "Publish" button
- Version history

Actions:
- Pause / unpause flow (audit-logged)
- View / edit raw flow JSON (a `<textarea>` editor — scripts edit via DB; humans edit via this fallback)
- Publish draft
- Manually enroll a contact (admin-only; rare)

### Flow run detail (`/flows/:slug/runs/:runId`)

Diagnostic deep-dive for one contact's journey:

- Contact summary (email, externalId, current tags via adapter)
- Step-by-step history (timestamps, decisions, sends)
- Next action (when, what)
- Manual override: skip step, cancel run, restart from step N

### Templates list (`/templates`)

Table: slug, name, kind, last sent, sent (7d), open rate, click rate.

Filters: kind (transactional/marketing), tag.

### Template detail / editor (`/templates/:slug`)

Two-pane view:

- **Left**: subject + preheader fields, then a tabbed body editor:
  - **Design** (default) — Maily WYSIWYG editor (`06-templates.md` § WYSIWYG). Operator drags blocks, edits inline, inserts merge tags from a `{{ }}` menu.
  - **Source** — MJML `<textarea>` with highlight.js syntax highlighting, for power users.
  Switching tabs round-trips through MJML — Design tab serializes to MJML on every save; Source tab deserializes back on switch.
- **Right**: live preview iframe. htmx auto-refreshes after each edit (debounced 500ms).

Actions:
- Save as draft (writes `draft.mjml`)
- Publish draft (compiles MJML, derives plain text, writes `body.*`, snapshots to `mailer_template_versions`)
- Send test → modal asking for an email address and sample variable values
- View version history → restore prior version
- Lint → runs through compliance checks (unsubscribe link present, sender address present, no broken merge tags)

### Contacts search (`/contacts`)

Search box. Type email → look up via adapter + mailer state.

Contact detail (`/contacts/:externalId`):

- Adapter-supplied info (email, fields, tags, timezone, locale)
- Subscription status (mailer-owned)
- Recent events (table, last 50)
- Recent sends (table, last 50)
- Active flow runs

Actions:
- Manually unsubscribe (any scope)
- Manually fire event
- Resend specific send
- Add tag / remove tag (routed through adapter)
- Manually add to suppressions
- GDPR export → JSON download

### Sends log (`/sends`)

Table of sends. Filter by: template, contact email, status, date range. Click into a row → send detail.

Send detail (`/sends/:id`):

- All metadata (provider, message ID, kind, etc.)
- Status timeline (queued → sent → delivered → opened → clicked)
- Rendered preview (the actual HTML that went out, if `storeBody: true`; otherwise re-renders from the template with the recorded sample data)
- Webhook events received for this send (table)
- Resend button

### Suppressions (`/suppressions`)

Table: email, scope, reason, source, added. Filter by reason. Add / remove (audit-logged).

CSV export.

### Broadcasts (`/broadcasts`)

Table of broadcasts past + scheduled. Status badges.

#### Broadcast create / edit

Form:

- Template (dropdown)
- Segment (JSON editor for `SegmentDefinition`; admin UI shows live recipient count as you edit)
- Schedule (now / specific datetime / draft)

Live recipient count via htmx → calls `segment.count(definition)` on every form change (debounced 500ms).

#### Broadcast confirmation gate (`INVARIANTS.md` rule 11)

If recipient count > threshold (default 1000), schedule button is disabled until the operator types the count exactly:

```
This broadcast will send to 4,231 contacts.
To proceed, type the count:  [          ]   [Schedule]
```

Typed value must match. Mismatch → error, retype. Audit-logged with `confirmedCount` and `confirmedBy`.

For broadcasts <= threshold, single-click is allowed.

### Audit log (`/audit`)

Reverse-chronological feed of every mutation. Filter by actor, action, resource type. Click an entry → diff view (before/after JSON).

### Health (`/health`)

Real-time view of `mailer_health`:

- Current status (healthy / degraded / tripped)
- Rolling-window counters and rates
- Recent trips (table)
- Manual resume button (if tripped) — requires confirmation, audit-logged

## Live-update patterns

The SPA polls or subscribes for fresh data. V1 uses periodic GETs against the REST API (`14-admin-api.md`):

- **Dashboard health widget**: refreshes every 10s.
- **Live segment counts** in the broadcast composer: debounced fetch on segment filter changes (500ms).
- **Template editor preview pane**: debounced POST to `/api/templates/:slug/preview` on MJML/subject edits (500ms).
- **Audit log infinite scroll**: paginated fetch on scroll-bottom.
- **Sends log**: optional auto-refresh toggle (5s) on the live view.

V2 may upgrade to Server-Sent Events for true push, but polling is simpler and admins watching the dashboard tolerate 10s latency.

## Auth

The library doesn't ship auth. The host gates the route:

```ts
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).end()
  next()
}

app.use('/admin/mailer', requireAdmin, createAdminRouter())
```

The middleware runs before the router, so it covers both the SPA shell and the `/api/*` endpoints.

If the host needs finer-grained permissions inside mailer (e.g. "this user can view but not publish"), pass a permission resolver:

```ts
createAdminRouter({
  resolvePermissions: (req) => ({
    canPublishFlows: req.user.roles.includes('email-admin'),
    canSendBroadcasts: req.user.roles.includes('email-admin'),
    canManageSuppressions: req.user.roles.includes('email-admin'),
    canViewContacts: req.user.roles.includes('support'),
  }),
})
```

Permissions gate the relevant REST endpoints; insufficient permission returns 403. The SPA reads `GET /api/me/permissions` on boot and hides buttons the user can't activate.

## Per-request audit context

Every mutating REST call grabs the requesting user from `req.user` (host-supplied) and writes it to `mailer_audit_log` as the `actor`. Source IP and User-Agent are recorded too.

The library exposes a hook to extract the actor name:

```ts
new Mailer({
  // ...
  getAdminActor: (req) => `human:${req.user?.email ?? 'anonymous'}`,
})
```

Defaults to `req.user?.id ?? 'unknown'`.

## Static assets

The router serves the prebuilt SPA from `dist/admin/spa/` (shipped inside the npm package):

```
/admin/mailer/                      → index.html (SPA shell)
/admin/mailer/_assets/index-*.js    → SPA bundle
/admin/mailer/_assets/index-*.css   → styles
/admin/mailer/api/*                 → JSON REST endpoints (see 14-admin-api.md)
```

No CDN dependency. Vite-hashed filenames mean the `_assets/*` responses are `Cache-Control: public, max-age=31536000, immutable` — the browser caches them forever, and a new release invalidates everything by changing the hash.
