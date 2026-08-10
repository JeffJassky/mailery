/**
 * Public router — endpoints that must be reachable by email clients and
 * provider webhooks. Mount under your tracking base path (default `/m`).
 *
 *   app.use('/m', createPublicRouter(mailer))
 *
 * Routes:
 *   GET  /open/:sendId.:sig.png        — open pixel (records open, returns 1×1 PNG)
 *   GET  /click/:sendId/:linkId/:sig   — click redirect (records click, 302 → target)
 *   GET  /unsub/:token                 — confirmation page (one-click POST link)
 *   POST /unsub/:token                 — RFC 8058 one-click unsubscribe
 *   POST /webhooks/:provider           — inbound provider event webhook
 *
 * `:sig` is a 12-character truncated HMAC issued by `applyTracking`. It is
 * syntactically optional on both tracking routes so that mail delivered before
 * signing existed keeps working — see `checkTrackingSignature`.
 */

import express, { Router, type Request, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { ObjectId } from 'mongodb'

import {
  sha256Hex,
  verifyUnsubscribeToken,
  verifyDoiToken,
  verifyTrackingToken,
  type TrackingScope,
  type TrackingTokenParams,
} from '../tokens.js'
import type { Mailer } from '../mailer.js'
import type { SendDoc } from '../models/index.js'
import type { MailProvider } from '../../shared/types.js'
import { consoleRouteLogger, wrap, type RouteLogger } from './wrap.js'

export interface PublicRouterOptions {
  /**
   * Path on disk where unsubscribe events fall back to when Mongo is degraded.
   * Defaults to /tmp/mailery-pending-unsubs.jsonl.
   */
  pendingUnsubsPath?: string
  /**
   * Structured logger for public-route failures, pino-style
   * (`logger.error(fields, message)`).
   *
   * Defaults to a `console`-backed logger that reproduces the output this
   * package emitted before the option existed. Pass `{}` to silence.
   */
  logger?: RouteLogger
}

// 1×1 transparent PNG (43 bytes)
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

export function createPublicRouter(mailer: Mailer, opts: PublicRouterOptions = {}): Router {
  const router = Router()
  const pendingUnsubsPath = opts.pendingUnsubsPath ?? '/tmp/mailery-pending-unsubs.jsonl'
  const logger = opts.logger ?? consoleRouteLogger

  // Parse JSON for webhooks — capture raw body for signature verification.
  router.use(
    '/webhooks',
    express.json({
      limit: '5mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf
      },
    }),
  )

  // Pre-parsed JSON for the POST one-click unsubscribe path (RFC 8058 sends a
  // small form/JSON body; we accept either by reading the URL only).
  router.use('/unsub', express.urlencoded({ extended: false }))

  // -------------------------------------------------------------------------
  // GET /open/:sendId.png
  // -------------------------------------------------------------------------
  router.get('/open/:sendId.png', wrap(logger, async (req: Request, res: Response) => {
    // The pixel is returned unconditionally, before anything is validated. A
    // rejected signature must look exactly like an accepted one on the wire:
    // any difference (404, empty body, slower response) is an oracle that tells
    // an attacker when a guessed sendId is real.
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Length', String(PIXEL.length))
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    res.status(200).end(PIXEL)

    // Async update — never block the response.
    const parsed = splitOpenParam((req.params as any).sendId as string)
    if (!parsed) return
    const { id, sig } = parsed
    if (!ObjectId.isValid(id)) return
    const sendId = new ObjectId(id)

    const verdict = checkTrackingSignature({
      scope: 'open',
      params: { sendId: id },
      sig,
      secret: mailer.config.unsubscribeSecret,
      requireSigned: mailer.config.requireSignedTrackingUrls,
      logger,
      fields: { sendId: id },
    })
    if (verdict === 'rejected') return

    try {
      const send = await mailer.collections.sends.findOne(
        { _id: sendId },
        { projection: { openedAt: 1, queuedAt: 1 } },
      )
      if (!send) return
      if (isTrackingExpired(send, mailer.config.trackingUrlLifetimeDays)) {
        logger.warn?.({ sendId: id }, 'mailery: open ignored — tracking URL past trackingUrlLifetimeDays')
        return
      }
      const now = new Date()
      await mailer.collections.sends.updateOne(
        { _id: sendId },
        {
          $set: {
            openedAt: send.openedAt ?? now,
            status: 'delivered' as const,
          },
          $inc: { openCount: 1 },
          // Per-open user agent, so `hasOpenedExcludingBots` has a signal to
          // filter on. Capped: an open pixel can be re-fetched indefinitely
          // (every time the recipient re-opens the mail) and an unbounded
          // array would eventually run the send document into the 16MB limit.
          $push: {
            opens: {
              $each: [{ openedAt: now, userAgent: requestUserAgent(req) }],
              $slice: -MAX_TRACKED_OPENS,
            },
          },
        },
      )
    } catch (err) {
      logger.error?.({ err, sendId: id }, 'mailery: open pixel update failed')
    }
  }))

  // -------------------------------------------------------------------------
  // GET /click/:sendId/:linkId
  // -------------------------------------------------------------------------
  router.get('/click/:sendId/:linkId{/:sig}', wrap(logger, async (req: Request, res: Response) => {
    const { sendId: sendIdStr, linkId, sig } = req.params as {
      sendId: string
      linkId: string
      sig?: string
    }
    if (!ObjectId.isValid(sendIdStr)) return res.status(400).end()
    const sendId = new ObjectId(sendIdStr)

    // A bad signature is answered with the same 404 an unknown send gets. Any
    // distinct status would confirm "this sendId exists, keep guessing".
    const verdict = checkTrackingSignature({
      scope: 'click',
      params: { sendId: sendIdStr, linkId },
      sig,
      secret: mailer.config.unsubscribeSecret,
      requireSigned: mailer.config.requireSignedTrackingUrls,
      logger,
      fields: { sendId: sendIdStr, linkId },
    })
    if (verdict === 'rejected') return res.status(404).end()

    const send = await mailer.collections.sends.findOne(
      { _id: sendId },
      { projection: { links: 1, firstClickAt: 1, queuedAt: 1 } },
    )
    if (!send) return res.status(404).end()

    if (isTrackingExpired(send, mailer.config.trackingUrlLifetimeDays)) {
      logger.warn?.(
        { sendId: sendIdStr, linkId },
        'mailery: click rejected — tracking URL past trackingUrlLifetimeDays',
      )
      return res.status(404).end()
    }

    const link = (send.links ?? []).find((l) => l.linkId === linkId)
    if (!link) return res.status(404).end()

    // Never redirect to a scheme we didn't sanction. The rejected URL is logged
    // but deliberately kept out of the response body — echoing it back would
    // reflect attacker-controlled content from the sending domain's origin.
    if (!isSafeRedirectTarget(link.url)) {
      logger.warn?.(
        { sendId: sendIdStr, linkId, url: link.url },
        'mailery: click redirect blocked — disallowed URL scheme',
      )
      return res
        .status(400)
        .type('html')
        .send('<!doctype html><html><body><p>This link cannot be opened.</p></body></html>')
    }

    res.redirect(302, link.url)

    try {
      await mailer.collections.sends.updateOne(
        { _id: sendId },
        {
          $set: { firstClickAt: send.firstClickAt ?? new Date() },
          $inc: { clickCount: 1 },
          $push: {
            clickedLinks: {
              url: link.url,
              linkId,
              clickedAt: new Date(),
              // The bot filter has always read `clickedLinks[].userAgent`; until
              // now nothing ever wrote it, so every click scored as human.
              userAgent: requestUserAgent(req),
            },
          },
        },
      )
    } catch (err) {
      logger.error?.({ err, sendId: sendIdStr, linkId }, 'mailery: click recording failed')
    }
  }))

  // -------------------------------------------------------------------------
  // GET + POST /unsub/:token
  // -------------------------------------------------------------------------
  router.get('/unsub/:token', wrap(logger, (req: Request, res: Response) => {
    const decoded = verifyUnsubscribeToken((req.params as any).token, mailer.config.unsubscribeSecret)
    if (!decoded) return sendUnsubError(res, 'Invalid or expired link.')

    res.status(200).type('html').send(`<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <title>Unsubscribe</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1c1917;line-height:1.5}h1{font-size:20px}button{padding:10px 18px;background:#dc2626;color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer}</style>
</head><body>
  <h1>Confirm unsubscribe</h1>
  <p>Click the button below to unsubscribe <strong>${escapeHtml(decoded.email)}</strong>${decoded.scope === 'all' ? ' from everything' : ' from marketing emails'}.</p>
  <form method="POST" action="${escapeHtml(req.originalUrl)}">
    <button type="submit">Unsubscribe</button>
  </form>
</body></html>`)
  }))

  router.post('/unsub/:token', wrap(logger, async (req: Request, res: Response) => {
    const decoded = verifyUnsubscribeToken((req.params as any).token, mailer.config.unsubscribeSecret)
    if (!decoded) {
      res.status(200).end() // never 5xx; let provider stop retrying
      return
    }

    // Reply 200 immediately. INVARIANT 8: bulletproof unsubscribe.
    res.status(200).type('html').send('<!doctype html><html><body><p>You are unsubscribed.</p></body></html>')

    try {
      await mailer.unsubscribe(decoded.email, {
        scope: decoded.scope,
        reason: 'user_request',
        source: 'one-click',
      })
    } catch (err) {
      try {
        fs.appendFileSync(
          pendingUnsubsPath,
          JSON.stringify({ email: decoded.email, scope: decoded.scope, at: Date.now() }) + '\n',
        )
      } catch (diskErr) {
        logger.error?.({ err, diskErr, path: pendingUnsubsPath }, 'mailery: unsub disk fallback failed')
      }
    }
  }))

  // -------------------------------------------------------------------------
  // GET /confirm-doi/:token
  // -------------------------------------------------------------------------
  router.get('/confirm-doi/:token', wrap(logger, async (req: Request, res: Response) => {
    const token = (req.params as any).token as string
    const decoded = verifyDoiToken(token, mailer.config.unsubscribeSecret)
    if (!decoded) {
      return res.status(400).type('html').send('<!doctype html><html><body><p>Confirmation link is invalid or expired.</p></body></html>')
    }
    const now = new Date()
    const result = await mailer.collections.subscriptions.updateOne(
      { externalId: decoded.externalId, status: 'pending_doi' },
      {
        $set: {
          status: 'subscribed',
          subscribedAt: now,
          doiConfirmedAt: now,
          doiIp: req.ip ?? null,
          doiUserAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          updatedAt: now,
        },
      },
    )
    if (result.matchedCount === 0) {
      return res.status(200).type('html').send('<!doctype html><html><body><p>Already confirmed. Thanks.</p></body></html>')
    }
    try {
      await mailer.fire('subscription.confirmed', decoded.externalId, {}, `doi-confirmed:${decoded.externalId}`)
    } catch {
      /* swallow — subscription is confirmed regardless */
    }
    return res.status(200).type('html').send('<!doctype html><html><body><p>Thanks — you\'re subscribed.</p></body></html>')
  }))

  // -------------------------------------------------------------------------
  // POST /webhooks/:provider
  // -------------------------------------------------------------------------
  router.post('/webhooks/:provider', wrap(logger, async (req: Request, res: Response) => {
    const providerName = (req.params as any).provider as string
    const provider = resolveProvider(mailer.providers, providerName)
    if (!provider) return res.status(404).end()

    const rawBody = (req as any).rawBody as Buffer | undefined
    if (!rawBody) return res.status(400).end()

    const headers = lowercaseHeaders(req.headers)
    const valid = await provider.verifyWebhook(rawBody, headers)
    if (!valid) return res.status(401).end()

    const events = provider.parseWebhookEvents(req.body, headers)

    // Always 200 fast — fail-open, retry inbound is wasted bandwidth.
    res.status(200).end()

    // Preserve the original provider payload alongside each normalized event so the
    // audit trail isn't reduced to just our extracted fields. The raw body is the
    // full provider response array; we record it once per parsed event for clarity.
    const rawBodyRef = req.body as unknown
    for (const evt of events) {
      try {
        await mailer.collections.webhookEvents.updateOne(
          { provider: providerName, providerEventId: evt.providerEventId },
          {
            $setOnInsert: {
              provider: providerName,
              providerEventId: evt.providerEventId,
              eventType: evt.type,
              normalizedType: evt.type,
              providerMessageId: evt.providerMessageId,
              email: evt.email,
              occurredAt: evt.occurredAt,
              receivedAt: new Date(),
              processed: false,
              raw: { normalized: evt, providerBody: rawBodyRef },
            },
          },
          { upsert: true },
        )
      } catch (err) {
        logger.error?.(
          { err, provider: providerName, providerEventId: evt.providerEventId },
          'mailery: webhook dedupe insert failed',
        )
      }
    }

    if (events.length > 0) {
      try {
        await mailer.queues.webhook.add('webhook', { provider: providerName })
      } catch {
        /* will be picked up by next tick */
      }
    }

    // Bypass linting — `path` import retained for any future on-disk fallback.
    void path
  }))

  return router
}

// ---------------------------------------------------------------------------
// Tracking-URL verification
// ---------------------------------------------------------------------------

/** Most recent opens kept per send. See `SendDoc.opens`. */
const MAX_TRACKED_OPENS = 50

/** User agents are stored for bot classification only; the tail carries nothing. */
const MAX_UA_LENGTH = 256

function requestUserAgent(req: Request): string | null {
  const ua = req.headers['user-agent']
  if (typeof ua !== 'string' || ua.trim() === '') return null
  return ua.slice(0, MAX_UA_LENGTH)
}

/**
 * Split the `:sendId.png` path parameter into id and optional signature.
 *
 * Express hands us everything before the literal `.png`, so a signed pixel
 * arrives as `<objectId>.<sig>` and a legacy one as `<objectId>`. Anything with
 * more dots than that was not produced by `applyTracking` and is dropped
 * outright rather than guessed at.
 */
function splitOpenParam(raw: unknown): { id: string; sig?: string } | null {
  if (typeof raw !== 'string') return null
  const parts = raw.split('.')
  if (parts.length === 1) return { id: parts[0]! }
  if (parts.length === 2) return { id: parts[0]!, sig: parts[1]! }
  return null
}

type TrackingVerdict = 'signed' | 'legacy' | 'rejected'

/**
 * Decide whether a tracking hit may be counted.
 *
 * Three cases, and the middle one is the whole backward-compatibility story:
 *
 *   signature present + valid  → 'signed'
 *   signature present + wrong  → 'rejected', always, in every mode
 *   signature absent           → 'rejected' if `requireSignedTrackingUrls`,
 *                                otherwise 'legacy' — counted, and logged
 *
 * Grace mode exists because mail already in inboxes carries unsigned URLs and
 * will keep being opened for years; hard-rejecting it would silently zero the
 * tracking for every send that predates this change. The per-hit warn is the
 * operator's instrument: watch the legacy rate decay, then set
 * `requireSignedTrackingUrls: true`.
 *
 * A wrong signature is never graced. Grace covers "this URL predates signing",
 * not "this URL was signed by someone who does not have the key".
 */
function checkTrackingSignature(args: {
  scope: TrackingScope
  params: TrackingTokenParams
  sig: string | undefined
  secret: string
  requireSigned: boolean
  logger: RouteLogger
  fields: Record<string, unknown>
}): TrackingVerdict {
  const { sig, logger, fields, scope } = args

  if (sig === undefined || sig === '') {
    if (args.requireSigned) {
      logger.warn?.(
        { ...fields, scope },
        'mailery: unsigned tracking URL rejected (requireSignedTrackingUrls)',
      )
      return 'rejected'
    }
    // `info`, not `warn`: in grace mode this fires once per legacy open, which
    // is telemetry rather than a fault. It is the operator's readout for
    // "has legacy traffic stopped yet?" — when this line goes quiet, flipping
    // `requireSignedTrackingUrls` to true is safe.
    logger.info?.(
      { ...fields, scope },
      'mailery: unsigned tracking URL accepted — legacy grace mode',
    )
    return 'legacy'
  }

  if (!verifyTrackingToken(sig, scope, args.params, args.secret)) {
    logger.warn?.({ ...fields, scope }, 'mailery: tracking URL signature invalid')
    return 'rejected'
  }
  return 'signed'
}

/**
 * True when the send is older than `trackingUrlLifetimeDays`.
 *
 * The deadline is derived from the send row rather than embedded in the token:
 * it costs no URL bytes, and changing the config takes effect immediately for
 * mail that has already gone out. A send with no usable `queuedAt` is never
 * treated as expired — losing a real open to a missing timestamp is worse than
 * counting a stale one.
 */
function isTrackingExpired(send: Pick<SendDoc, 'queuedAt'>, lifetimeDays: number, now: Date = new Date()): boolean {
  if (!lifetimeDays || lifetimeDays <= 0) return false
  const queuedAt = send.queuedAt
  if (!(queuedAt instanceof Date) || Number.isNaN(queuedAt.getTime())) return false
  return now.getTime() - queuedAt.getTime() > lifetimeDays * 24 * 60 * 60 * 1000
}

function sendUnsubError(res: Response, msg: string): Response {
  return res.status(400).type('html').send(`<!doctype html><html><body><p>${escapeHtml(msg)}</p></body></html>`)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Resolve a provider by the name in the request path.
 *
 * `mailer.providers` is a plain object literal, so a bare `providers[name]`
 * lookup also resolves inherited `Object.prototype` members: `constructor`,
 * `toString`, `valueOf` and friends all return something truthy, pass the
 * `if (!provider)` guard, and reach `provider.verifyWebhook(...)` as a
 * non-provider. `__proto__` resolves to the prototype object itself.
 *
 * Two gates, because either alone is incomplete: `Object.hasOwn` rejects
 * inherited keys, and the shape check rejects an own key whose value was never
 * a provider (a host building the map from untyped JSON, say).
 */
function resolveProvider(
  providers: Record<string, MailProvider>,
  name: string,
): MailProvider | null {
  if (typeof name !== 'string' || !Object.hasOwn(providers, name)) return null
  const candidate = providers[name] as unknown
  if (!candidate || typeof candidate !== 'object') return null
  const p = candidate as Partial<MailProvider>
  if (typeof p.verifyWebhook !== 'function') return null
  if (typeof p.parseWebhookEvents !== 'function') return null
  return p as MailProvider
}

/** Schemes we are willing to bounce a click through. */
const ALLOWED_REDIRECT_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Guard for the click-tracking redirect target.
 *
 * Stored link URLs come out of `applyTracking`, which harvests `href` values
 * from *rendered* HTML — i.e. after Handlebars substitution — so a template
 * that interpolates a variable into an href position can put an arbitrary
 * scheme into the stored URL. Redirecting to it would launch `javascript:` or
 * `data:` from the sending domain's own origin, with the sender's reputation
 * behind it.
 *
 * Parsed with `new URL()` rather than string matching: the URL parser strips
 * tab/newline and lowercases the scheme, so `java\tscript:` and `JavaScript:`
 * normalize to the same rejected protocol. A protocol-relative `//evil.com`
 * has no scheme and no base here, so parsing throws and it is rejected too.
 */
function isSafeRedirectTarget(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  if (trimmed === '') return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  return ALLOWED_REDIRECT_PROTOCOLS.has(parsed.protocol)
}

function lowercaseHeaders(h: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(h)) {
    const v = h[k]
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v ?? '')
  }
  return out
}

// silence unused
void sha256Hex
