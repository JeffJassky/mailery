# 09 — Admin UI

A mountable Express router. Server-rendered HTML + htmx for interactivity. No SPA bundle, no build step on consumer apps.

## Mounting

```ts
import { Mailer } from '@your-org/mailer'

const mailer = await Mailer.init({ /* ... */ })

// Gate with the host's existing auth middleware
app.use('/admin/mailer', requireAdmin, mailer.adminRouter())
```

The router serves at any base path — `/admin/mailer`, `/internal/email`, whatever. URLs are relative within the router.

## Tech choices

- **Server-rendered HTML** via simple Handlebars layouts (reused from the templating layer).
- **htmx** (~14KB gzipped) for interactivity — partial page updates, form submissions, lazy-loaded panels.
- **Alpine.js** (~7KB) for any small bits of client-side state (open/close menus, tab switching).
- **Pico.css** or a tiny custom CSS file for styling — purposely minimal so it integrates visually into whatever host UI it's mounted under.
- **No build step on consumer apps.** Static assets ship in the package and are served by the router (`/admin/mailer/static/*`).

The "no SPA, no build" choice is deliberate. The admin UI is for monitoring and small operations — not for being beautiful. Adding a React/Vue dependency would be the largest dependency the library has, for the smallest value-add.

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

## htmx patterns

Most pages are server-rendered full pages. Interactive bits use htmx partials:

- **Live preview pane** when editing a template: form fields have `hx-post="/templates/:slug/preview" hx-target="#preview-iframe" hx-trigger="keyup changed delay:500ms"`
- **Live segment counts** when editing a broadcast or segment
- **Inline status updates** on dashboard auto-refresh: `hx-get="/dashboard/widgets/health" hx-trigger="every 10s"`
- **Audit log infinite scroll**: `hx-get="/audit?cursor=..." hx-trigger="revealed"`

No build step. No bundler. The page source is readable when you View Source.

## Auth

The library doesn't ship auth. The host gates the route:

```ts
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).end()
  next()
}

app.use('/admin/mailer', requireAdmin, mailer.adminRouter())
```

If the host needs finer-grained permissions inside mailer (e.g. "this user can view but not publish"), pass a permission resolver:

```ts
mailer.adminRouter({
  resolvePermissions: (req) => ({
    canPublishFlows: req.user.roles.includes('email-admin'),
    canSendBroadcasts: req.user.roles.includes('email-admin'),
    canManageSuppressions: req.user.roles.includes('email-admin'),
    canViewContacts: req.user.roles.includes('support'),
  }),
})
```

Permissions gate the relevant routes; insufficient permission returns 403. UI hides buttons the user can't activate.

## Per-request audit context

Every admin-UI mutation grabs the requesting user from `req.user` (host-supplied) and writes it to `mailer_audit_log` as the `actor`. Source IP and User-Agent are recorded too.

The library exposes a hook to extract the actor name:

```ts
new Mailer({
  // ...
  getAdminActor: (req) => `human:${req.user?.email ?? 'anonymous'}`,
})
```

Defaults to `req.user?.id ?? 'unknown'`.

## Static assets

The library bundles its CSS and JS as static files:

```
/admin/mailer/static/pico.min.css
/admin/mailer/static/htmx.min.js
/admin/mailer/static/alpine.min.js
/admin/mailer/static/highlight.min.js
/admin/mailer/static/mailer.css            ← any custom styles
/admin/mailer/static/mailer.js             ← any custom behaviors
```

Served from the npm package via `express.static(node_modules_path)`. No CDN dependency.
