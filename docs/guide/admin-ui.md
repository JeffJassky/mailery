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

The SPA has 14 screens organized in three sidebar sections:

**Overview**
- Dashboard — KPIs (sends, deliverability, open rate, click rate), health, recent flows / sends / audit
- Health — circuit breaker status, rolling-window rates, recent trips, provider status

**Compose**
- Flows — list + detail with step editor
- Templates — list + Maily WYSIWYG editor (Design / MJML / Plain text tabs)
- Broadcasts — list + composer with segment builder + confirmation gate

**Audience**
- Contacts — search + detail (active flow runs, events, sends, adapter fields)
- Suppressions — list, add, remove

**Activity**
- Sends — log with status filter, click-through to send detail
- Audit log — every mutation, filterable by actor / action / resource

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
