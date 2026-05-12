/**
 * Public router — endpoints that must be reachable by email clients and
 * provider webhooks. Mount under your tracking base path (default `/m`).
 *
 *   app.use('/m', createPublicRouter(mailer))
 *
 * Routes:
 *   GET  /open/:sendId.png         — open pixel (records open, returns 1×1 PNG)
 *   GET  /click/:sendId/:linkId    — click redirect (records click, 302 → target)
 *   GET  /unsub/:token             — confirmation page (one-click POST link)
 *   POST /unsub/:token             — RFC 8058 one-click unsubscribe
 *   POST /webhooks/:provider       — inbound provider event webhook
 */

import express, { Router, type Request, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { ObjectId } from 'mongodb'

import { sha256Hex, verifyUnsubscribeToken, verifyDoiToken } from '../tokens.js'
import type { Mailer } from '../mailer.js'

export interface PublicRouterOptions {
  /**
   * Path on disk where unsubscribe events fall back to when Mongo is degraded.
   * Defaults to /tmp/mailery-pending-unsubs.jsonl.
   */
  pendingUnsubsPath?: string
}

// 1×1 transparent PNG (43 bytes)
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

export function createPublicRouter(mailer: Mailer, opts: PublicRouterOptions = {}): Router {
  const router = Router()
  const pendingUnsubsPath = opts.pendingUnsubsPath ?? '/tmp/mailery-pending-unsubs.jsonl'

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
  router.get('/open/:sendId.png', async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Length', String(PIXEL.length))
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    res.status(200).end(PIXEL)

    // Async update — never block the response.
    const id = (req.params as any).sendId as string
    if (!ObjectId.isValid(id)) return
    const sendId = new ObjectId(id)
    try {
      const send = await mailer.collections.sends.findOne({ _id: sendId }, { projection: { openedAt: 1 } })
      if (!send) return
      await mailer.collections.sends.updateOne(
        { _id: sendId },
        {
          $set: {
            openedAt: send.openedAt ?? new Date(),
            status: 'delivered' as const,
          },
          $inc: { openCount: 1 },
        },
      )
    } catch (err) {
      console.error('mailery: open pixel update failed', err)
    }
  })

  // -------------------------------------------------------------------------
  // GET /click/:sendId/:linkId
  // -------------------------------------------------------------------------
  router.get('/click/:sendId/:linkId', async (req: Request, res: Response) => {
    const { sendId: sendIdStr, linkId } = req.params as { sendId: string; linkId: string }
    if (!ObjectId.isValid(sendIdStr)) return res.status(400).end()
    const sendId = new ObjectId(sendIdStr)

    const send = await mailer.collections.sends.findOne(
      { _id: sendId },
      { projection: { links: 1, firstClickAt: 1 } },
    )
    if (!send) return res.status(404).end()

    const link = (send.links ?? []).find((l) => l.linkId === linkId)
    if (!link) return res.status(404).end()

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
            },
          },
        },
      )
    } catch (err) {
      console.error('mailery: click recording failed', err)
    }
  })

  // -------------------------------------------------------------------------
  // GET + POST /unsub/:token
  // -------------------------------------------------------------------------
  router.get('/unsub/:token', (req: Request, res: Response) => {
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
  })

  router.post('/unsub/:token', async (req: Request, res: Response) => {
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
        console.error('mailery: unsub disk fallback failed', { err, diskErr })
      }
    }
  })

  // -------------------------------------------------------------------------
  // GET /confirm-doi/:token
  // -------------------------------------------------------------------------
  router.get('/confirm-doi/:token', async (req: Request, res: Response) => {
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
  })

  // -------------------------------------------------------------------------
  // POST /webhooks/:provider
  // -------------------------------------------------------------------------
  router.post('/webhooks/:provider', async (req: Request, res: Response) => {
    const providerName = (req.params as any).provider as string
    const provider = mailer.providers[providerName]
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
        console.error('mailery: webhook dedupe insert failed', err)
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
  })

  return router
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
