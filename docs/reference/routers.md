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
| `/open/:sendId.:sig.png` | GET | 1×1 PNG open pixel. Records `openedAt` + `openCount` + `opens`. `:sig` optional (legacy). |
| `/click/:sendId/:linkId/:sig` | GET | 302 redirect to the original URL. Records `firstClickAt` + `clickCount` + appends to `clickedLinks`. `:sig` optional (legacy). |
| `/unsub/:token` | GET | HTML confirmation page with a one-click POST button. |
| `/unsub/:token` | POST | RFC 8058 one-click unsubscribe. Writes the suppression, then answers 200 — or journals to disk, or 503. See below. |
| `/webhooks/:provider` | POST | Provider event webhook. Verifies signature, deduplicates, returns 200, processes async. |
| `/inbound/dmarc` | POST | Inbound DMARC aggregate report. **Not mounted unless `dmarcInbound.secret` is set.** |

### Options

```ts
{
  pendingUnsubsPath?: string    // deprecated — set it in MailerConfig instead
  logger?: RouteLogger          // Logger; defaults to console. Pass `{}` to silence.
  dmarcInbound?: DmarcInboundOptions   // off unless set. See below.
}
```

#### `pendingUnsubsPath` <Badge type="warning" text="deprecated" />

Set `pendingUnsubsPath` in [`MailerConfig`](../guide/configuration#pendingunsubspath-the-unsubscribe-journal) instead. The tick drain reads the *config* value, so a path known only to the router is written and never replayed — which was the pre-0.15 bug. Setting it here without also setting it in config logs a warning at construction time.

#### `logger`

Structured logger for public-route failures and tracking-URL decisions, pino-style — each method takes `(fields, msg)`:

```ts
interface RouteLogger {
  error?: (fields: Record<string, unknown>, msg?: string) => void
  warn?:  (fields: Record<string, unknown>, msg?: string) => void
  info?:  (fields: Record<string, unknown>, msg?: string) => void
}
```

A pino or bunyan instance satisfies this directly:

```ts
app.use('/m', createPublicRouter(mailer, { logger: pino({ name: 'mailery-public' }) }))
```

Every method is optional, so `{}` is a valid silent logger — and a bare `console` is *not* silently accepted with its arguments in the wrong order. Defaults to a `console`-backed logger reproducing the output this package emitted before the option existed, so hosts that pass nothing see no change.

What lands where:

| Level | Emitted for |
|---|---|
| `error` | A route handler rejected; an async Mongo write failed after the response was already sent |
| `warn` | A click redirect blocked for a disallowed URL scheme; a tracking signature that was present and invalid; an unsigned tracking URL rejected under `requireSignedTrackingUrls` |
| `info` | An unsigned (pre-signing) tracking URL accepted in grace mode — one line per legacy hit, which is why it is not on `warn` |

### The unsubscribe journal (INVARIANT 8)

`POST /unsub/:token` is the one public route that finishes its work before answering, because a response sent first can only ever report success:

| what happened | response |
|---|---|
| the Mongo write succeeded (the normal case) | 200 |
| it failed or exceeded `unsubscribeWriteTimeoutMs`, and `pendingUnsubsPath` is set | appended to the journal → 200 |
| it failed and there is no journal, or the journal write also failed | **503** + `Retry-After: 60` |

The journal is replayed by `drainPendingUnsubscribes`, which runs on every `mailer:tick`. It is idempotent, crash-safe and safe to run from several processes at once; see [`pendingUnsubsPath`](../guide/configuration#pendingunsubspath-the-unsubscribe-journal) for how to choose a path and what happens if you don't.

Hosts that don't run the tick can drain it themselves:

```ts
import { drainPendingUnsubscribes } from 'mailery'

const { applied, deferred } = await drainPendingUnsubscribes(mailer.getRunnerContext())
```

#### `dmarcInbound`

```ts
{
  secret?: string            // absent/empty → the route is NOT mounted
  path?: string              // default '/inbound/dmarc'
  maxFileSizeBytes?: number  // default 10 * 1024 * 1024
  maxFiles?: number          // default 10
  allowedDomains?: string[]  // default: senderDomains + From defaults (+ parents)
  parseInbound?: (req) => Array<{ filename: string; buffer: Buffer }>
}
```

An inbound-email webhook for DMARC RUA reports. **SendGrid Inbound Parse does not sign its payloads**, so this endpoint authenticates with a shared secret (basic-auth password, or `Bearer`) and nothing else — which is why it is off by default and why no default secret exists. Full setup, the threat model, and the reasoning behind the secret-over-allowlist choice: [Deliverability → Receive reports automatically](../guide/deliverability#dmarc-inbound).

## Mounting at a non-`/admin/mailer` path

The admin SPA's asset URLs are baked into the bundle at build time (`base: '/admin/mailer/_assets/'`). V1 requires you to mount at exactly `/admin/mailer`. The public router has no such constraint — mount it anywhere, but make sure `publicUrl` in your config matches the host + path (e.g. `publicUrl: 'https://yourdomain.com'` + mount at `/m` means tracking URLs are `https://yourdomain.com/m/open/...`).

## CSRF + cookies

The `/m/*` endpoints are credentialed (cookies-included), so put them on the same origin as your app or configure your CORS / cookie scope accordingly. The admin `/api/*` endpoints sit behind your auth, which typically already handles CSRF.
