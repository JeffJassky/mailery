# Routers

mailery ships two Express routers. Both are factory functions that take a `Mailer` instance.

```ts
import { createAdminRouter, createPublicRouter } from 'mailery'
```

## createAdminRouter(mailer, opts?)

```ts
function createAdminRouter(mailer: Mailer, opts?: AdminRouterOptions): Router
```

Serves the prebuilt React SPA + REST endpoints the SPA consumes.

```ts
app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))
```

| Sub-route | Serves |
|---|---|
| `/` (and any sub-path) | SPA shell (`index.html`) so client-side routing works on refresh |
| `/_assets/*` | Hashed JS/CSS assets, `Cache-Control: public, max-age=31536000, immutable` |
| `/api/*` | JSON endpoints — see [Admin REST API](/reference/admin-api) |

### Options

```ts
{
  spaDir?: string                        // override path to the built SPA
  getActor?: (req: Request) => string    // resolve the actor string for audit log entries
}
```

**Defaults:**

- `spaDir` — `dist/admin/spa/` shipped inside the npm package, resolved via `import.meta.url` from the package's main entry.
- `getActor` — `'human:' + req.user?.email ?? 'anonymous'`. Override to wire your auth's user shape.

```ts
createAdminRouter(mailer, {
  getActor: (req) => `human:${req.session.userId}`,
})
```

### Auth

mailery doesn't ship auth. Gate the route with your existing middleware:

```ts
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).end()
  next()
}

app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))
```

The middleware runs before the router, covering the SPA shell + `/api/*` + `/_assets/*`. mailery itself does no auth checks inside.

## createPublicRouter(mailer, opts?)

```ts
function createPublicRouter(mailer: Mailer, opts?: PublicRouterOptions): Router
```

Serves the routes that must be reachable by email recipients and your provider's webhook server. **Do NOT auth-gate this** — emails would bounce.

```ts
app.use('/m', createPublicRouter(mailer))
```

| Sub-route | Method | Purpose |
|---|---|---|
| `/open/:sendId.png` | GET | 1×1 PNG open pixel. Records `openedAt` + `openCount`. |
| `/click/:sendId/:linkId` | GET | 302 redirect to the original URL. Records `firstClickAt` + `clickCount` + appends to `clickedLinks`. |
| `/unsub/:token` | GET | HTML confirmation page with a one-click POST button. |
| `/unsub/:token` | POST | RFC 8058 one-click unsubscribe. Returns 200 fast; writes suppression async; disk fallback if Mongo is degraded. |
| `/webhooks/:provider` | POST | Provider event webhook. Verifies signature, deduplicates, returns 200, processes async. |

### Options

```ts
{
  pendingUnsubsPath?: string    // default '/tmp/mailery-pending-unsubs.jsonl'
}
```

The pending-unsubs file is the fallback path INVARIANT 8 requires: if Mongo is degraded, the unsub endpoint still returns 200 to the provider, and the request is appended to this file. The tick re-tries them once Mongo recovers.

## Mounting at a non-`/admin/mailer` path

The admin SPA's asset URLs are baked into the bundle at build time (`base: '/admin/mailer/_assets/'`). V1 requires you to mount at exactly `/admin/mailer`. The public router has no such constraint — mount it anywhere, but make sure `publicUrl` in your config matches the host + path (e.g. `publicUrl: 'https://yourdomain.com'` + mount at `/m` means tracking URLs are `https://yourdomain.com/m/open/...`).

## CSRF + cookies

The `/m/*` endpoints are credentialed (cookies-included), so put them on the same origin as your app or configure your CORS / cookie scope accordingly. The admin `/api/*` endpoints sit behind your auth, which typically already handles CSRF.
