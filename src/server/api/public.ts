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
 *   POST /inbound/dmarc                — inbound DMARC report (opt-in; see below)
 *
 * Every route here is unauthenticated by necessity — mail clients and provider
 * webhook servers cannot present credentials. The one exception is
 * `/inbound/dmarc`, which is **not mounted at all** unless a shared secret is
 * configured; see `api/dmarc-inbound.ts`.
 *
 * `:sig` is a 12-character truncated HMAC issued by `applyTracking`. It is
 * syntactically optional on both tracking routes so that mail delivered before
 * signing existed keeps working — see `checkTrackingSignature`.
 */

import express, { Router, type Request, type Response } from 'express'
import { ObjectId } from 'mongodb'

import {
  sha256Hex,
  verifyUnsubscribeToken,
  tokenScope,
  verifyDoiToken,
  verifyTrackingToken,
  type TrackingScope,
  type TrackingTokenParams,
} from '../tokens.js'
import type { Mailer } from '../mailer.js'
import type { SendDoc } from '../models/index.js'
import type { CategoryDef, PreferenceState } from '../../shared/types.js'
import type { SuppressionScope } from '../../shared/enums.js'
import { resolveProvider } from '../provider-lookup.js'
import { DEFAULT_BOT_UA_RE, isBotUserAgent } from '../runner/predicate.js'
import { appendPendingUnsub } from '../unsub-journal.js'
import { attributeUnsubscribeToSend } from '../runner/broadcast-control.js'
import { mountDmarcInbound, type DmarcInboundOptions } from './dmarc-inbound.js'
import { consoleRouteLogger, wrap, type RouteLogger } from './wrap.js'

export interface PublicRouterOptions {
  /**
   * Overrides `MailerConfig.pendingUnsubsPath` for this router only.
   *
   * @deprecated Set `pendingUnsubsPath` in `MailerConfig` instead. The tick
   * drain (`drainPendingUnsubscribes`) reads the *config* value, so a path set
   * only here is written but never replayed — which is precisely the bug
   * INVARIANT 8 was carrying. Setting it here without also setting it in
   * config logs a warning at construction time.
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
  /**
   * Inbound DMARC aggregate-report webhook (SendGrid Inbound Parse and
   * friends). **Off unless `secret` is set** — see `api/dmarc-inbound.ts` for
   * why an endpoint that accepts unsigned file uploads must never appear on an
   * upgrade by itself.
   */
  dmarcInbound?: DmarcInboundOptions
}

// 1×1 transparent PNG (43 bytes)
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

export function createPublicRouter(mailer: Mailer, opts: PublicRouterOptions = {}): Router {
  const router = Router()
  const logger = opts.logger ?? consoleRouteLogger

  // INVARIANT 8. No filesystem default: see `MailerConfig.pendingUnsubsPath`
  // for why a library cannot pick one, and what happens when it is unset.
  const pendingUnsubsPath = opts.pendingUnsubsPath ?? mailer.config.pendingUnsubsPath ?? null
  if (opts.pendingUnsubsPath && !mailer.config.pendingUnsubsPath) {
    logger.warn?.(
      { path: opts.pendingUnsubsPath },
      'mailery: pendingUnsubsPath set on the public router but not in MailerConfig — the tick drain will not replay this journal',
    )
  }
  if (!pendingUnsubsPath) {
    logger.warn?.(
      {},
      'mailery: no pendingUnsubsPath configured — POST /unsub answers 503 when Mongo is unreachable instead of journaling the opt-out',
    )
  }

  // Inbound DMARC reports. Mounted only when a secret is configured; the
  // route's own module explains why that is not negotiable. Registered before
  // the body parsers below so nothing consumes its multipart stream, and
  // `mounted` is logged so an operator can see it exists.
  const dmarcInboundPath = mountDmarcInbound(router, mailer, opts.dmarcInbound, logger)
  if (dmarcInboundPath) {
    logger.info?.(
      { path: dmarcInboundPath },
      'mailery: DMARC inbound route mounted (shared-secret auth; SendGrid Inbound Parse does not sign payloads)',
    )
  }

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
      // An open proves delivery, but only moves a send forward from 'sent'.
      // Setting status unconditionally overwrote 'bounced' and 'complained'
      // (a complaint is usually preceded by an open), undercounting both.
      await mailer.collections.sends.updateOne(
        { _id: sendId, status: 'sent' },
        { $set: { status: 'delivered' as const } },
      )
      await mailer.collections.sends.updateOne(
        { _id: sendId },
        {
          $set: {
            openedAt: send.openedAt ?? now,
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
  // GET /click/:sendId/:linkId/:sig   (and the pre-0.15 unsigned form)
  //
  // Two explicit paths, not an optional segment. `{/:sig}` is Express 5
  // syntax; to Express 4's matcher — which the peer range allows and which
  // hosts on 4.x hand us when they build the router — the braces are literal
  // characters, so the route never matched and every tracked link in every
  // email answered the host's 404 page. Plain `:param` segments mean the same
  // thing to both majors; test/integration/route-syntax.test.ts keeps it so.
  // -------------------------------------------------------------------------
  router.get(['/click/:sendId/:linkId/:sig', '/click/:sendId/:linkId'], wrap(logger, async (req: Request, res: Response) => {
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
      { projection: { links: 1, firstClickAt: 1, queuedAt: 1, 'program.runId': 1 } },
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

    // plans/17 F4: a human click on a program email wakes the run, so a
    // shorter gap after progress (and a sunset reset) needs no scheduled tick.
    if (send.program) {
      try {
        const ua = requestUserAgent(req)
        const botRe = mailer.config.botFilter?.userAgentPattern ?? DEFAULT_BOT_UA_RE
        if (!isBotUserAgent(ua, botRe)) {
          await mailer.collections.programRuns.updateOne(
            { _id: send.program.runId, status: { $in: ['active', 'sunset'] } },
            { $min: { nextTickAt: new Date() } },
          )
        }
      } catch (err) {
        logger.error?.({ err, sendId: sendIdStr }, 'mailery: program wake on click failed')
      }
    }
  }))

  // -------------------------------------------------------------------------
  // GET + POST /unsub/:token
  // -------------------------------------------------------------------------
  const categories: CategoryDef[] = mailer.config.categories ?? []

  router.get('/unsub/:token', wrap(logger, async (req: Request, res: Response) => {
    const decoded = verifyUnsubscribeToken((req.params as any).token, mailer.config.unsubscribeSecret)
    if (!decoded) return sendUnsubError(res, 'Invalid or expired link.')

    // 0.21: with categories declared the link opens the preference page.
    if (categories.length > 0) {
      const prefs = await mailer.getPreferences(decoded.email)
      const action = req.originalUrl.split('?')[0]! + '/preferences'
      return res.status(200).type('html').send(renderPreferencePage(decoded.email, categories, prefs, action))
    }

    res.status(200).type('html').send(`<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <title>Unsubscribe</title>
  <style>${UNSUB_PAGE_STYLE}</style>
</head><body>
  <h1>Confirm unsubscribe</h1>
  <p>Click the button below to unsubscribe <strong>${escapeHtml(decoded.email)}</strong>${decoded.category ? ' from these emails' : decoded.scope === 'all' ? ' from everything' : ' from marketing emails'}.</p>
  <form method="POST" action="${escapeHtml(req.originalUrl)}">
    <button type="submit">Unsubscribe</button>
  </form>
</body></html>`)
  }))

  /**
   * Write opt-outs durably (INVARIANT 8): Mongo within the budget, else the
   * journal. 'ok' = in Mongo, 'journaled' = on disk for the drain, 'failed' =
   * neither (no journal configured, or the disk write failed).
   */
  const writeOptOutsDurably = async (
    email: string,
    scopes: SuppressionScope[],
    write: Promise<unknown>,
  ): Promise<{ result: 'ok' | 'journaled' | 'failed' | 'invalid'; dbError: unknown }> => {
    let dbError: unknown = null
    try {
      await withTimeout(write, mailer.config.unsubscribeWriteTimeoutMs)
    } catch (err) {
      // A validation error is not a database failure: journaling it would
      // answer 200 and the drain would drop the entry as malformed.
      if ((err as { name?: string } | null)?.name === 'ZodError') return { result: 'invalid', dbError: err }
      dbError = err ?? new Error('unsubscribe write failed')
      // The write may still land after the timeout; journal replay is
      // idempotent, but an unobserved rejection would take the host down.
      void write.catch(() => {})
    }
    if (!dbError) return { result: 'ok', dbError }
    if (!pendingUnsubsPath) {
      logger.error?.(
        { err: dbError },
        'mailery: unsubscribe write failed and no pendingUnsubsPath is configured — answering 503',
      )
      return { result: 'failed', dbError }
    }
    try {
      for (const scope of scopes) {
        appendPendingUnsub(pendingUnsubsPath, { email, scope, at: Date.now() })
      }
      logger.warn?.(
        { err: dbError, path: pendingUnsubsPath },
        'mailery: unsubscribe journaled to disk — will be replayed by the tick drain',
      )
    } catch (diskErr) {
      logger.error?.(
        { err: dbError, diskErr, path: pendingUnsubsPath },
        'mailery: unsub disk fallback failed — answering 503',
      )
      return { result: 'failed', dbError }
    }
    return { result: 'journaled', dbError }
  }

  /**
   * RFC 8058 one-click unsubscribe.
   *
   * This is the one public route that does *not* answer before doing its work,
   * and INVARIANT 8 is why. "Return 200 quickly" and "never silently drop an
   * opt-out" are both in that invariant, and answering first can only satisfy
   * the former: the response is already on the wire by the time we learn the
   * write failed, so the recipient is told they are unsubscribed and then
   * keeps receiving mail. Through v0.14 that is exactly what happened, and the
   * 503 the invariant describes was unreachable.
   *
   * So: durability first, within a budget.
   *
   *   Mongo write succeeds (typically sub-millisecond)   → 200
   *   Mongo fails or exceeds `unsubscribeWriteTimeoutMs` → journal → 200
   *   no journal configured, or the journal write fails  → 503
   *
   * A 503 is not a worse outcome than the old unconditional 200 — it is the
   * same failure, told honestly. The caller (a mail client's one-click
   * infrastructure, or a human on the confirmation page) can retry, and
   * nothing has claimed an unsubscribe that does not exist.
   */
  router.post('/unsub/:token', wrap(logger, async (req: Request, res: Response) => {
    const decoded = verifyUnsubscribeToken((req.params as any).token, mailer.config.unsubscribeSecret)
    if (!decoded) {
      res.status(200).end() // never 5xx; let provider stop retrying
      return
    }

    // The token's effective scope: the category for categorised mail, else
    // the signed scope (old tokens keep meaning what they meant).
    const scope = tokenScope(decoded)
    const { result, dbError } = await writeOptOutsDurably(
      decoded.email,
      [scope],
      mailer.unsubscribe(decoded.email, { scope, reason: 'user_request', source: 'one-click' }),
    )
    if (result === 'failed') return sendUnsubUnavailable(res)
    if (result === 'invalid') return sendUnsubError(res, 'We could not process this address.')

    res.status(200).type('html').send('<!doctype html><html><body><p>You are unsubscribed.</p></body></html>')

    // Best effort, after the answer: attribute the opt-out to the send the
    // link came from, so its broadcast's unsubscribe count (and stop rule)
    // sees it. Skipped when the write was journaled — Mongo is down.
    if (!dbError && decoded.sendId) {
      void attributeUnsubscribeToSend(mailer.getRunnerContext(), decoded.sendId, decoded.email).catch((err) => {
        logger.warn?.({ err, sendId: decoded.sendId }, 'mailery: unsubscribe attribution failed')
      })
    }
  }))

  // -------------------------------------------------------------------------
  // POST /unsub/:token/preferences — the preference page's form (0.21)
  //
  // Mounted only when categories are declared. Contract: see the header
  // comment of test/categories/preferences.test.ts.
  // -------------------------------------------------------------------------
  if (categories.length > 0) {
    router.post('/unsub/:token/preferences', wrap(logger, async (req: Request, res: Response) => {
      const decoded = verifyUnsubscribeToken((req.params as any).token, mailer.config.unsubscribeSecret)
      if (!decoded) return sendUnsubError(res, 'Invalid or expired link.')
      const body = (req.body ?? {}) as Record<string, unknown>

      if (body.action === 'unsubscribe-all') {
        const { result, dbError } = await writeOptOutsDurably(
          decoded.email,
          ['marketing'],
          mailer.unsubscribe(decoded.email, { scope: 'marketing', reason: 'user_request', source: 'preferences' }),
        )
        if (result === 'failed') return sendUnsubUnavailable(res)
        if (result === 'invalid') return sendUnsubError(res, 'We could not process this address.')
        res.status(200).type('html').send(preferencesDonePage('You are unsubscribed from all marketing email.'))
        if (!dbError && decoded.sendId) {
          void attributeUnsubscribeToSend(mailer.getRunnerContext(), decoded.sendId, decoded.email).catch((err) => {
            logger.warn?.({ err, sendId: decoded.sendId }, 'mailery: unsubscribe attribution failed')
          })
        }
        return
      }

      if (body.action !== 'save' && body.action !== 'resubscribe') return sendUnsubError(res, 'Unknown action.')
      // `save` never touches a marketing-wide opt-out (a recipient who is
      // unsubscribed from everything must not lose that by pressing Save);
      // only the explicit `resubscribe` action clears it.
      const resubscribe = body.action === 'resubscribe'

      // Checked boxes arrive as repeated `category` fields; ids that are not
      // declared are ignored, never written.
      const raw = body.category
      const posted = new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String))
      const declared = categories.map((c) => c.id)
      const update = {
        ...(resubscribe ? { marketing: true } : {}),
        categories: Object.fromEntries(declared.map((id) => [id, posted.has(id)])),
      }
      const optOuts = declared.filter((id) => !posted.has(id)).map((id) => `category:${id}` as SuppressionScope)

      const { result } = await writeOptOutsDurably(
        decoded.email,
        optOuts,
        mailer.setPreferences(decoded.email, update, { source: 'preferences' }),
      )
      // Opt-ins cannot be journaled, so anything but a Mongo write is a
      // failure to the recipient — after the opt-outs were journaled.
      if (result === 'invalid') return sendUnsubError(res, 'We could not process this address.')
      if (result !== 'ok') {
        return res
          .status(503)
          .set('Retry-After', '60')
          .type('html')
          .send(preferencesDonePage('We could not update your preferences right now. Please try again in a minute.'))
      }
      res.status(200).type('html').send(preferencesDonePage(resubscribe ? 'You are subscribed again to the topics you selected.' : 'Your preferences have been updated.'))
    }))
  }

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

/**
 * The 503 INVARIANT 8 describes: neither Mongo nor the journal could record
 * the opt-out. `Retry-After` is set because the honest answer to a one-click
 * client is "come back", not "done".
 */
function sendUnsubUnavailable(res: Response): Response {
  return res
    .status(503)
    .set('Retry-After', '60')
    .type('html')
    .send(
      '<!doctype html><html><body><p>We could not record your unsubscribe right now, ' +
        'so you are <strong>not</strong> unsubscribed yet. Please try again in a minute.</p></body></html>',
    )
}

/**
 * Resolve `p`, or reject once `ms` has elapsed.
 *
 * A rejected `p` still settles the race normally; the timer exists for the
 * case that matters here, a Mongo client that is neither resolving nor
 * rejecting because the server it is waiting on is gone. `unref()` keeps a
 * pending timer from holding the process open.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`))
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

const UNSUB_PAGE_STYLE =
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1c1917;line-height:1.5}h1{font-size:20px}button{padding:10px 18px;background:#dc2626;color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer}"

const PREFERENCE_PAGE_STYLE =
  UNSUB_PAGE_STYLE +
  'label{display:block;margin:12px 0}.desc{display:block;margin-left:24px;color:#57534e;font-size:13px}.actions{margin-top:20px}button.secondary{background:#1c1917}button.link{background:none;color:#dc2626;text-decoration:underline;padding:10px 0;margin-left:12px}'

function preferencesDonePage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8" /><title>Email preferences</title><style>${PREFERENCE_PAGE_STYLE}</style></head><body><p>${escapeHtml(message)}</p></body></html>`
}

/** The preference page: one checkbox per declared category, plus unsubscribe-from-all. */
function renderPreferencePage(
  email: string,
  categories: CategoryDef[],
  prefs: PreferenceState,
  action: string,
): string {
  const boxes = categories
    .map((c) => {
      const checked = prefs.categories[c.id] ? ' checked' : ''
      const desc = c.description ? `<span class="desc">${escapeHtml(c.description)}</span>` : ''
      return `    <label><input type="checkbox" name="category" value="${escapeHtml(c.id)}"${checked}> ${escapeHtml(c.label)}${desc}</label>`
    })
    .join('\n')
  const optedOut = !prefs.marketing
  const notice = optedOut
    ? `\n  <p class="notice"><strong>You're unsubscribed from all marketing email.</strong> Pick the topics you want and press Resubscribe to start receiving them again.</p>`
    : ''
  const buttons = optedOut
    ? `      <button type="submit" name="action" value="resubscribe" class="secondary">Resubscribe to the topics below</button>`
    : `      <button type="submit" name="action" value="save" class="secondary">Save preferences</button>
      <button type="submit" name="action" value="unsubscribe-all" class="link">Unsubscribe from all marketing email</button>`
  return `<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <title>Email preferences</title>
  <style>${PREFERENCE_PAGE_STYLE}</style>
</head><body>
  <h1>Email preferences</h1>${notice}
  <p>Choose which emails <strong>${escapeHtml(email)}</strong> receives.</p>
  <form method="POST" action="${escapeHtml(action)}">
${boxes}
    <div class="actions">
${buttons}
    </div>
  </form>
</body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
