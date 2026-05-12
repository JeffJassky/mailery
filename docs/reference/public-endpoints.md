# Public router endpoints

Mounted via `createPublicRouter(mailer)`. Default mount path: `/m`. These endpoints **must be reachable from the public internet** — email clients, provider webhook servers. **Don't auth-gate them.**

## `GET /open/:sendId.png`

The open-pixel endpoint. Returns a 1×1 transparent PNG.

| | |
|---|---|
| Path param | `sendId` — the `_id` of the `mailer_sends` row |
| Cache | `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` |
| Body | Static 43-byte PNG |
| Side effects (async) | Sets `openedAt` (if null) + increments `openCount` |
| Status code | Always 200 |

Returns immediately. The Mongo update is fire-and-forget so a slow DB never blocks pixel delivery.

## `GET /click/:sendId/:linkId`

The click-redirect endpoint.

| | |
|---|---|
| Path params | `sendId`, `linkId` — `linkId` matches an entry in `mailer_sends.links` |
| Response | 302 redirect to the original URL |
| Side effects (async) | Sets `firstClickAt` (if null) + increments `clickCount` + appends to `clickedLinks` |
| Status codes | 302 (success), 400 (bad sendId), 404 (unknown sendId or linkId) |

Redirects without waiting on the Mongo write — clicks feel snappy.

## `GET /unsub/:token`

HTML confirmation page (for browser visits).

| | |
|---|---|
| Path param | `token` — HMAC-signed unsubscribe token |
| Response | HTML page with a "Unsubscribe" button that POSTs to the same URL |
| Status codes | 200 (valid), 400 (invalid/expired token) |

## `POST /unsub/:token`

RFC 8058 one-click unsubscribe. Gmail and other modern clients POST here when the user clicks the in-inbox unsubscribe button.

| | |
|---|---|
| Path param | `token` |
| Response | Empty 200 |
| Side effects (async) | `mailer.unsubscribe(email, { scope })` with the scope embedded in the token |
| Fallback | If Mongo is degraded, the request is appended to `pendingUnsubsPath` (default `/tmp/mailery-pending-unsubs.jsonl`); the next tick replays it |
| Status code | Always 200 — INVARIANT 8: never 5xx, providers retry too aggressively |

mailery returns 200 first, processes asynchronously. Providers (e.g. Gmail's one-click button infrastructure) get fast acks; users get a tiny "You are unsubscribed" page.

### Token format

```
${base64url(payload)}.${base64url(hmac)}

payload = JSON.stringify({ e: email, s: scope, x: expiresAtMs })
hmac    = HMAC-SHA256(unsubscribeSecret, payload)
```

Tokens expire after `unsubscribeTokenLifetimeDays` (default 90). Expired tokens fail verification but the confirmation page can re-request (V2 feature).

## `POST /webhooks/:provider`

Provider event webhook ingest.

| | |
|---|---|
| Path param | `provider` — must match a key in `providers` config |
| Headers required | Provider-specific signature (e.g. `x-twilio-email-event-webhook-signature` + `x-twilio-email-event-webhook-timestamp` for SendGrid) |
| Body | Provider's event payload (JSON, up to 5MB) |
| Response | Empty 200 |
| Side effects (async) | Upsert into `mailer_webhook_events` for dedup; enqueue `mailer-webhook` job for async processing |
| Status codes | 200 (success or unverified), 401 (signature verification failed), 404 (unknown provider) |

mailery returns 200 fast (INVARIANT 5: never make providers retry due to our slowness). The webhook worker picks up unprocessed events and applies them to `mailer_sends` + cascades to suppressions / subscriptions as needed.

### Dedup

Events are upserted by `(provider, providerEventId)`. Duplicate deliveries (providers retry on 5xx) are silently dropped.

### Reconciliation

Webhook delivery is unreliable enough that mailery also runs (in roadmap) a daily reconciliation job pulling the provider's Activity API for the last 24h to catch dropped events.

## CORS / cookies

These endpoints are credentialed (cookies-included) — host them on the same origin as your app or configure CORS appropriately. Open pixels and click redirects fire from email clients without any CORS preflight — no special handling needed.
