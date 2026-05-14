# Admin UI

mailery ships a React admin SPA, prebuilt and bundled inside the npm package. You mount it on a route gated by your existing auth — no separate frontend deploy.

## Mounting

```ts
import { createAdminRouter } from 'mailery'

app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))
```

`requireAdmin` is your middleware. mailery doesn't ship auth — it trusts whatever you mount in front of it.

Under the mounted path:

| Route | Served |
|---|---|
| `/admin/mailer/` (and any sub-route) | SPA shell (`index.html`) |
| `/admin/mailer/_assets/*` | Hashed JS/CSS assets, cached forever |
| `/admin/mailer/api/*` | JSON REST endpoints — see [Admin REST API](/reference/admin-api) |

The SPA is a single 232KB JS bundle (63KB gzipped) + 18KB CSS. Loads behind your auth gate, so users without admin access never see it.

## Mount path

V1 ships with the asset base path baked in as `/admin/mailer/_assets/` at build time. **You must mount the router at exactly `/admin/mailer`** for the SPA's asset URLs to resolve correctly.

To use a different path (`/dashboard/email`, `/internal/mailer`, etc.) you can:
1. Override `spaDir` with your own prebuilt copy that uses a different `base` in the Vite config.
2. Wait for the configurable-base feature in a future release.

## Screens

The SPA has 15 screens organized in four sidebar sections:

**Overview**
- Dashboard — KPIs (sends, deliverability, open rate, click rate), health, recent flows / sends / audit
- Health — see [Health screen](#health-screen) below

**Compose**
- Flows — list + detail with step editor
- Templates — list + Maily WYSIWYG editor (Design / MJML / Plain text tabs) with live content linter + Mail-Tester deliverability check
- Broadcasts — list + composer with segment builder + confirmation gate

**Audience**
- Contacts — search + detail (active flow runs, events, sends, adapter fields)
- Suppressions — list, add, remove
- List hygiene — see [List hygiene screen](#list-hygiene-screen) below

**Activity**
- Sends — log with status filter, click-through to send detail
- Audit log — every mutation, filterable by actor / action / resource

## Health screen

The Health screen consolidates every reputation signal mailery tracks. Each section appears even when its underlying feature is not configured — empty states explain what to do.

### Top-line KPIs

Aggregate rates over the rolling window (default 1 hour): hard bounce, complaint, combined bounce, failed-to-send. Each is colored against its trip threshold — green below 50% of trip, amber above 50%, red at trip or above.

### Per-(sender domain × kind) buckets

The circuit breaker is scoped per (sender domain × template kind), so one bad subdomain doesn't hold mail for the others. This table shows one row per bucket with current rates and status pill. Tripped buckets get an inline "Resume" button; the page header offers "Resume all" when any bucket is tripped.

See [Deliverability → Per-domain circuit breaker](./deliverability#per-domain-circuit-breaker).

### DNS block lists

Daily scan results against Spamhaus / SURBL / URIBL (and Spamhaus ZEN / Barracuda / SORBS / SpamCop when dedicated IPs are configured). Listed targets surface in red with a "Recheck now" button.

See [Deliverability → DNS block-list monitoring](./deliverability#dns-block-list-monitoring).

### Google Postmaster Tools

Latest daily snapshot per domain — reputation tier (HIGH / MEDIUM / LOW / BAD), user-reported spam %, SPF / DKIM / DMARC pass %. Empty state shows "not configured" when the OAuth credentials aren't set.

See [Deliverability → Google Postmaster Tools](./deliverability#google-postmaster-tools).

### Microsoft SNDS

Per-IP filter result (GREEN / YELLOW / RED), complaint rate, trap count, activity window. Visibility-only — RED status surfaces in setup-status but does not auto-trip the breaker.

See [Deliverability → Microsoft SNDS](./deliverability#microsoft-snds).

### DMARC RUA reports

Multi-file upload widget for `.zip` / `.gz` aggregate reports. Below it: per-domain pass/fail summary table with a 14-day alignment-rate sparkline + policy progression suggestion. When failures exist, a second table lists top failing source IPs with inline tag editor.

See [Deliverability → DMARC RUA report ingestion](./deliverability#dmarc-rua-report-ingestion).

## List hygiene screen

Engagement breakdown of your subscribed contacts:

- **4 headline KPIs** — total subscribed, engaged 30d %, inactive >180d %, never engaged %.
- **Engagement breakdown table** — one row per cohort (last 30d / 31-60d / 61-90d / 91-180d / >180d / never engaged) with count, % of subscribers, and a distribution bar.
- **Sunset opportunity card** — for the long-inactive cohort: count, lifetime bounce / complaint rates, projected impact on overall rates after sunset. Read-only — the screen surfaces the opportunity without acting on it.

See [Deliverability → List hygiene](./deliverability#list-hygiene).

## Template editor sidebar

The right rail of the template editor contains three reputation cards alongside the Sender card:

- **Issues** — live content-linter results. Debounces ~500ms after each keystroke. Errors block publish; warnings + infos pass through.
- **Deliverability check** — Mail-Tester button + score panel. Shows "not configured" when `MailerConfig.mailTester` is unset.

See [Deliverability → Content linter](./deliverability#content-linter) and [Mail-Tester integration](./deliverability#mail-tester-integration-optional).

## Permissions

By default, every authenticated user has full access. To gate specific actions:

```ts
createAdminRouter(mailer, {
  resolvePermissions: (req) => ({
    canPublish: req.user.roles.includes('email-admin'),
    canSendBroadcasts: req.user.roles.includes('email-admin'),
    canManageSuppressions: req.user.roles.includes('support'),
  }),
})
```

The SPA reads `GET /api/me/permissions` on boot and hides buttons the user can't activate. Insufficient permission on a mutating endpoint returns 403.

## Theming

V1 ships with light + dark themes (toggle in the top bar). Accent color is the warm orange `#f97316`. Customization isn't a config option yet — fork or override CSS variables in your own stylesheet.

## Browser support

Modern evergreens — Chrome / Firefox / Safari / Edge current minus 2 versions. No IE.

## Offline preview

The SPA's screens currently fall back to sample data if `/api/*` endpoints aren't reachable. Useful for demo deploys or static-export previews. When real data is available, the screens use it.

## REST API surface

Every interactive action in the SPA maps to a REST endpoint. See [Admin REST API](/reference/admin-api) for the catalogue.
