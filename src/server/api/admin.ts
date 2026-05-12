/**
 * Admin router — serves the prebuilt React SPA + REST endpoints the SPA
 * consumes. Mount inside a host Express app, gated by host auth.
 *
 *   app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))
 *
 * REST routes under /api/* are documented in plans/14-admin-api.md.
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ObjectId } from 'mongodb'

import type { Mailer } from '../mailer.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function defaultSpaDir(): string {
  // After tsup build: dist/index.{js,cjs} + dist/admin/spa/. __dirname = dist/.
  return path.resolve(__dirname, 'admin/spa')
}

export interface AdminRouterOptions {
  /** Override path to the built SPA. Defaults to `dist/admin/spa` shipped with the package. */
  spaDir?: string
  /** Resolve actor metadata from a Request. Defaults to `human:${req.user?.email || 'anonymous'}`. */
  getActor?: (req: Request) => string
}

export function createAdminRouter(mailer: Mailer, opts: AdminRouterOptions = {}): Router {
  const router = Router()
  const spaDir = opts.spaDir ?? defaultSpaDir()
  const getActor =
    opts.getActor ?? ((req: Request) => `human:${(req as any).user?.email ?? 'anonymous'}`)

  // Static assets — long cache, hashed filenames.
  router.use(
    '/_assets',
    express.static(spaDir, {
      maxAge: '1y',
      immutable: true,
      index: false,
    }),
  )

  // JSON body parsing for mutating endpoints.
  router.use('/api', express.json({ limit: '1mb' }))

  // Inject actor on every API request (read after the host's auth middleware).
  router.use('/api', (req: Request, _res, next: NextFunction) => {
    ;(req as any).actor = getActor(req)
    next()
  })

  router.use('/api', apiRouter(mailer))

  // SPA shell — any other route returns index.html so client-side routing
  // doesn't 404 on refresh.
  router.get(/.*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(spaDir, 'index.html'))
  })

  return router
}

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

function apiRouter(mailer: Mailer): Router {
  const r = Router()
  const c = mailer.collections

  r.get('/me', (req, res) => {
    res.json({
      actor: (req as any).actor,
      permissions: { canPublish: true, canSendBroadcasts: true, canManageSuppressions: true },
    })
  })

  // ----- Dashboard ----------------------------------------------------------
  r.get(
    '/dashboard',
    asyncHandler(async (_req, res) => {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const [sentTotal, deliveredCount, bouncedCount, openedCount, clickedCount] = await Promise.all([
        c.sends.countDocuments({ queuedAt: { $gt: since24h } }),
        c.sends.countDocuments({ queuedAt: { $gt: since24h }, status: 'delivered' }),
        c.sends.countDocuments({ queuedAt: { $gt: since24h }, status: 'bounced' }),
        c.sends.countDocuments({ queuedAt: { $gt: since24h }, openedAt: { $ne: null } }),
        c.sends.countDocuments({ queuedAt: { $gt: since24h }, firstClickAt: { $ne: null } }),
      ])

      const health = await c.health.findOne({ _id: 'singleton' })
      const recentFlows = await c.flows.find({ enabled: true }).limit(5).toArray()
      const recentSends = await c.sends.find().sort({ queuedAt: -1 }).limit(6).toArray()
      const recentAudit = await c.auditLog.find().sort({ occurredAt: -1 }).limit(5).toArray()

      res.json({
        kpis: {
          sends: { value: sentTotal, delta: null },
          deliveredRate: {
            value: sentTotal === 0 ? 1 : deliveredCount / sentTotal,
            delta: null,
            bounced: bouncedCount,
          },
          openRate: { value: sentTotal === 0 ? 0 : openedCount / sentTotal, delta: null, exclBots: false },
          clickRate: { value: sentTotal === 0 ? 0 : clickedCount / sentTotal, delta: null },
        },
        health: health
          ? { status: health.status, rates: health.rates }
          : {
              status: 'healthy',
              rates: { hardBounceRate: 0, complaintRate: 0, combinedBounceRate: 0, failureRate: 0 },
            },
        queue: { inFlight: 0, delayed: 0, providerOk: true, providerName: mailer.config.defaultProvider },
        recentFlows,
        recentSends,
        recentAudit,
      })
    }),
  )

  // ----- Flows --------------------------------------------------------------
  r.get(
    '/flows',
    asyncHandler(async (_req, res) => {
      const flows = await c.flows.find().sort({ updatedAt: -1 }).toArray()
      res.json(flows)
    }),
  )

  r.get(
    '/flows/:slug',
    asyncHandler(async (req, res) => {
      const flow = await c.flows.findOne({ slug: req.params.slug })
      if (!flow) return res.status(404).json({ error: 'not_found' })
      return res.json(flow)
    }),
  )

  r.post(
    '/flows/:slug/pause',
    asyncHandler(async (req, res) => {
      const before = await c.flows.findOne({ slug: req.params.slug })
      if (!before) return res.status(404).json({ error: 'not_found' })
      await c.flows.updateOne({ _id: before._id }, { $set: { enabled: false, updatedAt: new Date() } })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'flow.pause',
        resource: { collection: 'mailer_flows', id: before._id, slug: before.slug },
      })
      return res.json({ ok: true })
    }),
  )

  r.post(
    '/flows/:slug/resume',
    asyncHandler(async (req, res) => {
      const before = await c.flows.findOne({ slug: req.params.slug })
      if (!before) return res.status(404).json({ error: 'not_found' })
      await c.flows.updateOne({ _id: before._id }, { $set: { enabled: true, updatedAt: new Date() } })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'flow.resume',
        resource: { collection: 'mailer_flows', id: before._id, slug: before.slug },
      })
      return res.json({ ok: true })
    }),
  )

  // ----- Templates ----------------------------------------------------------
  r.get(
    '/templates',
    asyncHandler(async (_req, res) => {
      const templates = await c.templates.find().sort({ updatedAt: -1 }).toArray()
      res.json(templates)
    }),
  )

  r.get(
    '/templates/:slug',
    asyncHandler(async (req, res) => {
      const template = await c.templates.findOne({ slug: req.params.slug })
      if (!template) return res.status(404).json({ error: 'not_found' })
      return res.json(template)
    }),
  )

  // ----- Broadcasts ---------------------------------------------------------
  r.get(
    '/broadcasts',
    asyncHandler(async (_req, res) => {
      const broadcasts = await c.broadcasts.find().sort({ createdAt: -1 }).toArray()
      res.json(broadcasts)
    }),
  )

  r.get(
    '/broadcasts/:slug',
    asyncHandler(async (req, res) => {
      const broadcast = await c.broadcasts.findOne({ slug: req.params.slug })
      if (!broadcast) return res.status(404).json({ error: 'not_found' })
      return res.json(broadcast)
    }),
  )

  // ----- Contacts -----------------------------------------------------------
  r.get(
    '/contacts',
    asyncHandler(async (req, res) => {
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
      const limit = Math.min(Number(req.query.limit ?? 50), 200)
      const { contacts, nextCursor } = await mailer.adapter.query({}, { limit, cursor })
      res.json({ contacts, nextCursor })
    }),
  )

  r.get(
    '/contacts/:externalId',
    asyncHandler(async (req, res) => {
      const externalId = String(req.params.externalId)
      const [contact, subscription, recentEvents, recentSends, activeRuns] = await Promise.all([
        mailer.adapter.getById(externalId),
        c.subscriptions.findOne({ externalId }),
        c.events.find({ externalId }).sort({ occurredAt: -1 }).limit(50).toArray(),
        c.sends.find({ externalId }).sort({ queuedAt: -1 }).limit(50).toArray(),
        c.flowRuns.find({ externalId, status: 'active' }).toArray(),
      ])
      if (!contact) return res.status(404).json({ error: 'not_found' })
      return res.json({ contact, subscription, recentEvents, recentSends, activeRuns })
    }),
  )

  // ----- Sends --------------------------------------------------------------
  r.get(
    '/sends',
    asyncHandler(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 100), 500)
      const status = typeof req.query.status === 'string' ? req.query.status : undefined
      const filter: any = {}
      if (status) filter.status = status
      const sends = await c.sends.find(filter).sort({ queuedAt: -1 }).limit(limit).toArray()
      res.json(sends)
    }),
  )

  r.get(
    '/sends/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id)
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'bad_id' })
      const send = await c.sends.findOne({ _id: new ObjectId(id) })
      if (!send) return res.status(404).json({ error: 'not_found' })
      const events = send.providerMessageId
        ? await c.webhookEvents.find({ providerMessageId: send.providerMessageId }).toArray()
        : []
      return res.json({ send, webhookEvents: events })
    }),
  )

  // ----- Suppressions -------------------------------------------------------
  r.get(
    '/suppressions',
    asyncHandler(async (_req, res) => {
      const rows = await c.suppressions.find().sort({ addedAt: -1 }).limit(500).toArray()
      res.json(rows)
    }),
  )

  r.post(
    '/suppressions',
    asyncHandler(async (req, res) => {
      const { email, scope, reason, source, notes } = req.body ?? {}
      await mailer.suppress(email, { scope, reason, source, notes })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'suppression.add',
        resource: { collection: 'mailer_suppressions' },
        diffSummary: `${email} → ${scope}/${reason}`,
      })
      res.json({ ok: true })
    }),
  )

  // ----- Audit log ----------------------------------------------------------
  r.get(
    '/audit',
    asyncHandler(async (_req, res) => {
      const rows = await c.auditLog.find().sort({ occurredAt: -1 }).limit(200).toArray()
      res.json(rows)
    }),
  )

  // ----- Health -------------------------------------------------------------
  r.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const h = await c.health.findOne({ _id: 'singleton' })
      res.json(
        h ?? {
          _id: 'singleton',
          status: 'healthy',
          windowStartedAt: new Date(Date.now() - 60 * 60 * 1000),
          windowDurationMs: 60 * 60 * 1000,
          counters: { sent: 0, delivered: 0, bounced: 0, hardBounced: 0, softBounced: 0, complained: 0, failedToSend: 0 },
          rates: { bounceRate: 0, hardBounceRate: 0, complaintRate: 0, failureRate: 0 },
        },
      )
    }),
  )

  r.post(
    '/health/resume',
    asyncHandler(async (req, res) => {
      await c.health.updateOne(
        { _id: 'singleton' },
        { $set: { status: 'healthy', manuallyResumedAt: new Date(), updatedAt: new Date() } },
      )
      await mailer.audit({
        actor: (req as any).actor,
        action: 'health.resume',
        resource: { collection: 'mailer_health' },
      })
      res.json({ ok: true })
    }),
  )

  // Catch-all 404 for /api.
  r.use((_req, res) => res.status(404).json({ error: 'not_found' }))

  return r
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>
function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next)
  }
}
