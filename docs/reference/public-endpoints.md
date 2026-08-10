# Public router endpoints

Mounted via `createPublicRouter(mailer)`. Default mount path: `/m`. These endpoints **must be reachable from the public internet** — email clients, provider webhook servers. **Don't auth-gate them.**

## `GET /open/:sendId.:sig.png`

The open-pixel endpoint. Returns a 1×1 transparent PNG.

| | |
|---|---|
| Path params | `sendId` — the `_id` of the `mailer_sends` row; `sig` — 12-char tracking signature (see [Tracking URL signatures](#tracking-url-signatures)) |
| Cache | `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` |
| Body | Static 43-byte PNG |
| Side effects (async) | Sets `openedAt` (if null), increments `openCount`, appends `{ openedAt, userAgent }` to `opens` (capped at the 50 most recent) |
| Status code | **Always 200**, including when the signature is rejected |

Returns immediately. The Mongo update is fire-and-forget so a slow DB never blocks pixel delivery.

The status code is 200 even for a forged or expired URL, deliberately: a 404 for "no such send" and a 200 for "real send, bad signature" would be an oracle an attacker could use to enumerate send ids. Rejections are visible in the log, not on the wire.

`sig` is syntactically optional — `/open/<sendId>.png` is the pre-signing URL shape and is still parsed. Whether it is *counted* depends on `requireSignedTrackingUrls`.

## `GET /click/:sendId/:linkId/:sig`

The click-redirect endpoint.

| | |
|---|---|
| Path params | `sendId`, `linkId` — `linkId` matches an entry in `mailer_sends.links`; `sig` — 12-char tracking signature, optional |
| Response | 302 redirect to the original URL |
| Side effects (async) | Sets `firstClickAt` (if null) + increments `clickCount` + appends `{ url, linkId, clickedAt, userAgent }` to `clickedLinks` |
| Status codes | 302 (success), 400 (malformed `sendId`, or the stored target is not `http:`/`https:`), 404 (unknown `sendId` or `linkId`, rejected signature, or a URL past `trackingUrlLifetimeDays`) |

Redirects without waiting on the Mongo write — clicks feel snappy.

**400 — rejected redirect scheme.** Stored link URLs come from `applyTracking`, which harvests hrefs from *rendered* HTML, so a template that interpolates a variable into an href position can put an arbitrary scheme into the stored URL. The endpoint refuses to bounce anything that is not `http:` or `https:`, answers 400 with a static body, does **not** count the click, and logs a warning. The rejected URL is never echoed into the response — doing so would reflect attacker-controlled content from the sending domain's own origin. (Since v0.15.0 `applyTracking` also declines to rewrite such hrefs in the first place, so reaching this branch means the link predates that change or was written directly to the send document.)

**404 for a bad signature**, rather than a distinct code, for the same anti-enumeration reason as the pixel: an unknown send and a forged signature are indistinguishable to the caller.

## Tracking URL signatures

Both tracking URLs carry a truncated HMAC over their own path components:

```
/m/open/<sendId>.<sig>.png
/m/click/<sendId>/<linkId>/<sig>

sig = base64url(HMAC-SHA256(unsubscribeSecret, "mailery.track.v1:<scope>:<sendId>[:<linkId>]")).slice(0, 12)
```

- **Scope** is `open` or `click` and is part of the signed message, so an open signature cannot be replayed on the click route or vice versa.
- **Key** is `unsubscribeSecret` (`MAILER_UNSUBSCRIBE_SECRET`) — the same secret the unsubscribe and DOI tokens use, so there is one secret to provision and one to rotate.
- **Length** is 12 base64url characters (72 bits), adding 13 characters to each URL. Verification is `crypto.timingSafeEqual` behind a length pre-check.
- **Expiry** is not in the token. It is derived from the send row's `queuedAt` against `trackingUrlLifetimeDays`, which defaults to `0` — never expires.

Without a signature the only secret in a tracking URL is a Mongo ObjectId, which is a timestamp plus a per-process-constant random plus a sequential counter — one received email largely gives up its neighbours. That matters beyond reporting: `hasOpened`, `openedAtLeastN` and friends are flow inputs, so forged opens advance real automation.

### Backward compatibility

Mail already delivered contains unsigned URLs and will keep being opened for years, so the endpoints accept three cases:

| URL | `requireSignedTrackingUrls: false` (default) | `requireSignedTrackingUrls: true` |
|---|---|---|
| Valid signature | counted | counted |
| Wrong signature | **rejected** | **rejected** |
| No signature (legacy) | counted, logged at `info` | rejected, logged at `warn` |

A wrong signature is never graced — grace covers "this URL predates signing", not "this URL was signed by someone without the key".

**What an operator has to do:** nothing to get signing — mail rendered on v0.15.0+ is signed automatically, and the default grace mode keeps older mail counting. To finish the migration, watch for the log line `mailery: unsigned tracking URL accepted — legacy grace mode` (emitted via `logger.info`, one per legacy hit). When that rate reaches zero — in practice a few months after your longest-lived campaign — set `requireSignedTrackingUrls: true`. From that point an unsigned pixel is silently not counted and an unsigned click 404s, so do not flip it early.

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
| Response | Tiny "You are unsubscribed" HTML page |
| Side effects | `mailer.unsubscribe(email, { scope })` with the scope embedded in the token, awaited within `unsubscribeWriteTimeoutMs` (default 5s) |
| Fallback | If the write fails or times out, the opt-out is appended to `pendingUnsubsPath` and replayed by the tick drain |
| Status codes | 200 (recorded, or durably journaled), 200 (invalid/expired token — never make a provider retry a token we will never accept), 503 (neither Mongo nor the journal could take it) |

INVARIANT 8 in one line: **mailery never returns 200 for an unsubscribe it did not durably record.** A healthy write is sub-millisecond, so the response is still fast; the timeout budget is only ever spent during an outage, and spending it is the difference between a truthful 200 and a lie. Before v0.15 this route answered 200 unconditionally *before* trying either write, so a failed write meant a recipient who had been told they were unsubscribed and would keep receiving mail.

See [Routers → The unsubscribe journal](./routers#the-unsubscribe-journal-invariant-8).

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

## `POST /inbound/dmarc` <Badge type="warning" text="opt-in" />

Inbound DMARC RUA aggregate report, for SendGrid Inbound Parse and equivalents.

**This route does not exist unless `dmarcInbound.secret` is configured.** It is the only endpoint here that accepts a file upload, and — unlike `/webhooks/:provider` — there is no signature to verify, because Inbound Parse does not sign its payloads.

| | |
|---|---|
| Path | `dmarcInbound.path`, default `/inbound/dmarc` |
| Auth | Shared secret as the HTTP Basic password (username ignored) or `Authorization: Bearer <secret>`, compared in constant time — checked **before** the body is read |
| Body | `multipart/form-data` in SendGrid Inbound Parse's shape; only `.zip` / `.gz` / `.xml` attachments are considered |
| Limits | `maxFileSizeBytes` (default 10MB) per attachment, `maxFiles` (default 10) per message |
| Side effects | The same ingest path as the admin upload — upserts `mailer_dmarc_reports` + `mailer_dmarc_failures`, idempotent on `reportId × orgName` |
| Rejections | A report whose `policy_published.domain` is not a domain this deployment sends from |
| Status codes | 200 (ingested, or nothing to ingest), 400 (nothing usable), 401 (bad/missing secret), 413 (over a limit) |

Setup and threat model: [Deliverability → Receive reports automatically](../guide/deliverability#dmarc-inbound).

## CORS / cookies

These endpoints are credentialed (cookies-included) — host them on the same origin as your app or configure CORS appropriately. Open pixels and click redirects fire from email clients without any CORS preflight — no special handling needed.
