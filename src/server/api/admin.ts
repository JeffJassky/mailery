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
import {
  applyTracking,
  compileMailyTemplate,
  compileTemplate,
  renderTemplate,
} from '../templates/render.js'
import { validateSenderDomain } from '../templates/sender-domain.js'
import { runSetupChecks } from './setup-status.js'
import { signUnsubscribeToken } from '../tokens.js'

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

  r.get(
    '/me',
    asyncHandler(async (req, res) => {
      const [flows, templates, broadcasts, contacts, suppressions, health] = await Promise.all([
        c.flows.estimatedDocumentCount(),
        c.templates.estimatedDocumentCount(),
        c.broadcasts.estimatedDocumentCount(),
        c.subscriptions.countDocuments({ status: 'subscribed' }),
        c.suppressions.estimatedDocumentCount(),
        c.health.findOne({ _id: 'singleton' }),
      ])
      res.json({
        actor: (req as any).actor,
        counts: { flows, templates, broadcasts, contacts, suppressions },
        health: { status: health?.status ?? null },
        providers: {
          names: Object.keys(mailer.config.providers),
          default: mailer.config.defaultProvider,
        },
        broadcastConfirmationThreshold: mailer.config.broadcastConfirmationThreshold,
      })
    }),
  )

  // ----- Dashboard ----------------------------------------------------------
  r.get(
    '/dashboard',
    asyncHandler(async (_req, res) => {
      const now = Date.now()
      const HOUR = 60 * 60 * 1000
      const since24h = new Date(now - 24 * HOUR)
      const since48h = new Date(now - 48 * HOUR)

      const [
        sentTotal, deliveredCount, bouncedCount, openedCount, clickedCount,
        sentPrev, deliveredPrev, openedPrev, clickedPrev,
        hourly,
      ] = await Promise.all([
        c.sends.countDocuments({ queuedAt: { $gt: since24h } }),
        c.sends.countDocuments({ queuedAt: { $gt: since24h }, status: 'delivered' }),
        c.sends.countDocuments({ queuedAt: { $gt: since24h }, status: 'bounced' }),
        c.sends.countDocuments({ queuedAt: { $gt: since24h }, openedAt: { $ne: null } }),
        c.sends.countDocuments({ queuedAt: { $gt: since24h }, firstClickAt: { $ne: null } }),
        c.sends.countDocuments({ queuedAt: { $gt: since48h, $lte: since24h } }),
        c.sends.countDocuments({ queuedAt: { $gt: since48h, $lte: since24h }, status: 'delivered' }),
        c.sends.countDocuments({ queuedAt: { $gt: since48h, $lte: since24h }, openedAt: { $ne: null } }),
        c.sends.countDocuments({ queuedAt: { $gt: since48h, $lte: since24h }, firstClickAt: { $ne: null } }),
        c.sends
          .aggregate<{ _id: number; sends: number; opens: number }>([
            { $match: { queuedAt: { $gt: since24h } } },
            {
              $project: {
                hour: {
                  $toInt: {
                    $divide: [{ $subtract: [now, { $toLong: '$queuedAt' }] }, HOUR],
                  },
                },
                opened: { $cond: [{ $ifNull: ['$openedAt', false] }, 1, 0] },
              },
            },
            { $group: { _id: '$hour', sends: { $sum: 1 }, opens: { $sum: '$opened' } } },
          ])
          .toArray(),
      ])

      const sendSeries = new Array(24).fill(0)
      const openSeries = new Array(24).fill(0)
      for (const row of hourly) {
        const idx = 23 - Math.max(0, Math.min(23, row._id))
        sendSeries[idx] = row.sends
        openSeries[idx] = row.opens
      }

      const delta = (cur: number, prev: number): number | null => {
        if (prev === 0) return null
        return (cur - prev) / prev
      }
      const rateDelta = (curN: number, curD: number, prevN: number, prevD: number): number | null => {
        if (prevD === 0 || curD === 0) return null
        return curN / curD - prevN / prevD
      }

      const health = await c.health.findOne({ _id: 'singleton' })
      const recentFlowsRaw = await c.flows.find({ enabled: true }).limit(5).toArray()
      const flowStatsMap = await computeFlowStats(mailer)
      const recentFlows = recentFlowsRaw.map((f) => ({ ...f, stats: flowStatsMap.get(f.slug) ?? emptyFlowStats() }))
      const recentSends = await c.sends.find().sort({ queuedAt: -1 }).limit(6).toArray()
      const recentAudit = await c.auditLog.find().sort({ occurredAt: -1 }).limit(5).toArray()

      const queueCounts = await collectQueueCounts(mailer)
      const lastSendError = await c.sends
        .findOne({ status: { $in: ['bounced', 'failed'] } }, { sort: { queuedAt: -1 } })
      const lastSendOk = await c.sends
        .findOne({ status: 'delivered' }, { sort: { queuedAt: -1 } })
      const providerOk =
        lastSendOk && lastSendError
          ? new Date(lastSendOk.queuedAt as Date).getTime() >= new Date(lastSendError.queuedAt as Date).getTime()
          : lastSendOk
          ? true
          : lastSendError
          ? false
          : null

      res.json({
        kpis: {
          sends: { value: sentTotal, delta: delta(sentTotal, sentPrev) },
          deliveredRate: {
            value: sentTotal === 0 ? null : deliveredCount / sentTotal,
            delta: rateDelta(deliveredCount, sentTotal, deliveredPrev, sentPrev),
            bounced: bouncedCount,
          },
          openRate: {
            value: sentTotal === 0 ? null : openedCount / sentTotal,
            delta: rateDelta(openedCount, sentTotal, openedPrev, sentPrev),
          },
          clickRate: {
            value: sentTotal === 0 ? null : clickedCount / sentTotal,
            delta: rateDelta(clickedCount, sentTotal, clickedPrev, sentPrev),
          },
        },
        series: { hourly: { sends: sendSeries, opens: openSeries } },
        health: {
          status: health?.status ?? null,
          rates: health?.rates ?? null,
          thresholds: {
            hardBounceRatePctTrip: mailer.config.circuitBreaker.hardBounceRatePctTrip,
            complaintRatePctTrip: mailer.config.circuitBreaker.complaintRatePctTrip,
            combinedBounceRatePctTrip: mailer.config.circuitBreaker.combinedBounceRatePctTrip,
            failedToSendRatePctDegrade: mailer.config.circuitBreaker.failedToSendRatePctDegrade,
          },
        },
        queue: {
          inFlight: queueCounts?.inFlight ?? null,
          delayed: queueCounts?.delayed ?? null,
          providerOk,
          providerName: mailer.config.defaultProvider,
        },
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
      const stats = await computeFlowStats(mailer)
      res.json(flows.map((f) => ({ ...f, stats: stats.get(f.slug) ?? emptyFlowStats() })))
    }),
  )

  r.get(
    '/flows/:slug',
    asyncHandler(async (req, res) => {
      const flow = await c.flows.findOne({ slug: req.params.slug })
      if (!flow) return res.status(404).json({ error: 'not_found' })
      const stats = (await computeFlowStats(mailer, flow.slug)).get(flow.slug) ?? emptyFlowStats()
      return res.json({ ...flow, stats })
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
      const stats = await computeTemplateStats(mailer)
      res.json(templates.map((t) => ({ ...t, stats: stats.get(t.slug) ?? emptyTemplateStats() })))
    }),
  )

  r.get(
    '/templates/:slug',
    asyncHandler(async (req, res) => {
      const template = await c.templates.findOne({ slug: req.params.slug })
      if (!template) return res.status(404).json({ error: 'not_found' })
      const stats = (await computeTemplateStats(mailer, template.slug)).get(template.slug) ?? emptyTemplateStats()
      return res.json({ ...template, stats })
    }),
  )

  // ----- Broadcasts ---------------------------------------------------------
  r.get(
    '/broadcasts',
    asyncHandler(async (_req, res) => {
      const broadcasts = await c.broadcasts.find().sort({ createdAt: -1 }).toArray()
      const stats = await computeBroadcastStats(mailer)
      res.json(broadcasts.map((b) => ({ ...b, stats: stats.get(String(b._id)) ?? emptyBroadcastStats() })))
    }),
  )

  r.get(
    '/broadcasts/:slug',
    asyncHandler(async (req, res) => {
      const broadcast = await c.broadcasts.findOne({ slug: req.params.slug })
      if (!broadcast) return res.status(404).json({ error: 'not_found' })
      const stats = (await computeBroadcastStats(mailer, broadcast._id)).get(String(broadcast._id)) ?? emptyBroadcastStats()
      return res.json({ ...broadcast, stats })
    }),
  )

  // ----- Contacts -----------------------------------------------------------
  r.get(
    '/contacts',
    asyncHandler(async (req, res) => {
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
      const limit = Math.min(Number(req.query.limit ?? 50), 200)
      const [{ contacts, nextCursor }, counts] = await Promise.all([
        mailer.adapter.query({}, { limit, cursor }),
        (async () => {
          const rows = await c.subscriptions
            .aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }])
            .toArray()
          const out: Record<string, number> = { subscribed: 0, pending_doi: 0, unsubscribed: 0, bounced: 0, complained: 0 }
          let total = 0
          for (const r of rows) {
            if (r._id) out[r._id] = r.n
            total += r.n
          }
          return { ...out, total }
        })(),
      ])
      res.json({ contacts, nextCursor, counts })
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

  // ----- Setup status -------------------------------------------------------
  r.get(
    '/setup-status',
    asyncHandler(async (_req, res) => {
      const status = await runSetupChecks(mailer)
      res.json(status)
    }),
  )

  // ----- Health -------------------------------------------------------------
  r.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const h = await c.health.findOne({ _id: 'singleton' })
      const cb = mailer.config.circuitBreaker
      const thresholds = {
        hardBounceRatePctTrip: cb.hardBounceRatePctTrip,
        complaintRatePctTrip: cb.complaintRatePctTrip,
        combinedBounceRatePctTrip: cb.combinedBounceRatePctTrip,
        failedToSendRatePctDegrade: cb.failedToSendRatePctDegrade,
      }
      if (!h) {
        // No tick has run yet. Do not fabricate "healthy" / zeroed rates —
        // the UI renders "—" / muted dots when status is null.
        res.json({ status: null, rates: null, counters: null, thresholds })
        return
      }
      res.json({ ...h, thresholds })
    }),
  )

  r.get(
    '/health/trips',
    asyncHandler(async (_req, res) => {
      const rows = await c.auditLog
        .find({ action: { $in: ['health.trip', 'health.resume'] } })
        .sort({ occurredAt: -1 })
        .limit(50)
        .toArray()
      res.json(rows)
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

  // ----- Flows: create / edit / publish ------------------------------------
  r.post(
    '/flows',
    asyncHandler(async (req, res) => {
      const { slug, name, description, trigger, goal, audience } = req.body ?? {}
      if (!slug || !name || !trigger?.eventName) {
        return res.status(400).json({ error: 'validation_failed', message: 'slug, name, and trigger.eventName required' })
      }
      const now = new Date()
      const doc = {
        slug,
        name,
        description: description ?? '',
        trigger: { type: 'event' as const, eventName: trigger.eventName, once: trigger.once !== false },
        enabled: false,
        steps: [],
        version: 0,
        draft: {
          steps: [],
          notes: 'Initial draft',
          lastModifiedBy: (req as any).actor ?? 'unknown',
          lastModifiedAt: now,
        },
        goal: goal ?? 'activation',
        audience: audience ?? '',
        expectedVolumePerWeek: null,
        stats: { activeRuns: 0, completedRuns: 0, sendsTotal: 0, sendsLast7Days: 0 },
        lastTriggerScanAt: null,
        publishedAt: null,
        publishedBy: null,
        createdAt: now,
        updatedAt: now,
      }
      try {
        await c.flows.insertOne(doc as any)
      } catch (err: any) {
        if (err?.code === 11000) return res.status(409).json({ error: 'slug_taken' })
        throw err
      }
      await mailer.audit({
        actor: (req as any).actor,
        action: 'flow.create',
        resource: { collection: 'mailer_flows', slug },
      })
      return res.json({ ok: true, slug })
    }),
  )

  r.patch(
    '/flows/:slug/draft',
    asyncHandler(async (req, res) => {
      const flow = await c.flows.findOne({ slug: req.params.slug })
      if (!flow) return res.status(404).json({ error: 'not_found' })
      const { steps, notes, trigger, name, description, goal, audience } = req.body ?? {}

      const set: Record<string, unknown> = {
        'draft.lastModifiedBy': (req as any).actor,
        'draft.lastModifiedAt': new Date(),
        updatedAt: new Date(),
      }
      if (Array.isArray(steps)) set['draft.steps'] = steps
      if (typeof notes === 'string') set['draft.notes'] = notes
      if (trigger?.eventName) set.trigger = { type: 'event' as const, eventName: trigger.eventName, once: trigger.once !== false }
      if (typeof name === 'string') set.name = name
      if (typeof description === 'string') set.description = description
      if (typeof goal === 'string') set.goal = goal
      if (typeof audience === 'string') set.audience = audience

      await c.flows.updateOne({ _id: flow._id }, { $set: set })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'flow.draft.update',
        resource: { collection: 'mailer_flows', id: flow._id, slug: flow.slug },
        diffSummary: `Updated draft (${steps ? `${steps.length} steps` : 'metadata only'})`,
      })
      return res.json({ ok: true })
    }),
  )

  r.post(
    '/flows/:slug/publish',
    asyncHandler(async (req, res) => {
      const flow = await c.flows.findOne({ slug: req.params.slug })
      if (!flow) return res.status(404).json({ error: 'not_found' })
      const draftSteps = flow.draft?.steps ?? flow.steps
      if (!Array.isArray(draftSteps) || draftSteps.length === 0) {
        return res.status(400).json({ error: 'empty_flow', message: 'flow has no steps to publish' })
      }
      const nextVersion = (flow.version ?? 0) + 1
      const now = new Date()
      await c.flowVersions.insertOne({
        flowId: flow._id!,
        version: nextVersion,
        steps: draftSteps,
        trigger: flow.trigger,
        publishedAt: now,
        publishedBy: (req as any).actor,
      })
      await c.flows.updateOne(
        { _id: flow._id },
        {
          $set: {
            steps: draftSteps,
            version: nextVersion,
            enabled: true,
            draft: null,
            publishedAt: now,
            publishedBy: (req as any).actor,
            updatedAt: now,
          },
        },
      )
      await mailer.audit({
        actor: (req as any).actor,
        action: 'flow.publish',
        resource: { collection: 'mailer_flows', id: flow._id, slug: flow.slug },
        diffSummary: `Published v${nextVersion}`,
      })
      return res.json({ ok: true, version: nextVersion })
    }),
  )

  r.delete(
    '/flows/:slug',
    asyncHandler(async (req, res) => {
      const flow = await c.flows.findOne({ slug: req.params.slug })
      if (!flow) return res.status(404).json({ error: 'not_found' })
      const everRan = await c.flowRuns.countDocuments({ flowId: flow._id }, { limit: 1 })
      if (everRan > 0) return res.status(409).json({ error: 'has_runs', message: 'flow has runs — pause it instead' })
      await c.flows.deleteOne({ _id: flow._id })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'flow.delete',
        resource: { collection: 'mailer_flows', id: flow._id, slug: flow.slug },
      })
      return res.json({ ok: true })
    }),
  )

  // ----- Templates: create / edit / publish --------------------------------
  r.post(
    '/templates',
    asyncHandler(async (req, res) => {
      const { slug, name, kind, subject, preheader, fromName, fromEmail } = req.body ?? {}
      if (!slug || !name || !kind) {
        return res.status(400).json({ error: 'validation_failed', message: 'slug, name, kind required' })
      }
      if (kind !== 'marketing' && kind !== 'transactional') {
        return res.status(400).json({ error: 'validation_failed', message: 'kind must be marketing or transactional' })
      }
      const resolvedFromEmail =
        fromEmail ??
        (kind === 'transactional' ? mailer.config.transactionalFromDefaults?.email : undefined) ??
        mailer.config.fromDefaults?.email ??
        'noreply@example.com'
      const senderCheck = validateSenderDomain(resolvedFromEmail, kind, mailer.config.senderDomains)
      if (!senderCheck.ok) {
        return res.status(400).json({
          error: 'sender_domain_invalid',
          code: senderCheck.code,
          message: senderCheck.reason,
        })
      }
      const now = new Date()
      try {
        await c.templates.insertOne({
          slug,
          name,
          description: '',
          kind,
          fromName:
            fromName ??
            (kind === 'transactional' ? mailer.config.transactionalFromDefaults?.name : undefined) ??
            mailer.config.fromDefaults?.name ??
            'Mailery',
          fromEmail: resolvedFromEmail,
          replyTo: null,
          providerOverride: null,
          subject: subject ?? `Untitled — ${name}`,
          preheader: preheader ?? '',
          body: { mjml: '', editorJson: null, html: '', plainText: '', compiledAt: null },
          variablesSchema: {},
          draft: {
            subject: subject ?? `Untitled — ${name}`,
            preheader: preheader ?? '',
            mjml: '',
            editorJson: null,
            notes: 'Initial draft',
            lastModifiedBy: (req as any).actor,
            lastModifiedAt: now,
          },
          tags: [],
          trackOpens: kind === 'marketing',
          trackClicks: kind === 'marketing',
          stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, lastSentAt: null },
          publishedAt: null,
          publishedBy: null,
          createdAt: now,
          updatedAt: now,
        } as any)
      } catch (err: any) {
        if (err?.code === 11000) return res.status(409).json({ error: 'slug_taken' })
        throw err
      }
      await mailer.audit({
        actor: (req as any).actor,
        action: 'template.create',
        resource: { collection: 'mailer_templates', slug },
      })
      return res.json({ ok: true, slug })
    }),
  )

  r.patch(
    '/templates/:slug/draft',
    asyncHandler(async (req, res) => {
      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })

      const { subject, preheader, mjml, editorJson, notes, name, fromName, fromEmail, replyTo, kind, trackOpens, trackClicks } = req.body ?? {}

      const set: Record<string, unknown> = {
        'draft.lastModifiedBy': (req as any).actor,
        'draft.lastModifiedAt': new Date(),
        updatedAt: new Date(),
      }
      if (typeof subject === 'string') set['draft.subject'] = subject
      if (typeof preheader === 'string') set['draft.preheader'] = preheader
      if (typeof mjml === 'string') set['draft.mjml'] = mjml
      if (editorJson !== undefined) set['draft.editorJson'] = editorJson
      if (typeof notes === 'string') set['draft.notes'] = notes
      if (typeof name === 'string') set.name = name
      if (typeof fromName === 'string') set.fromName = fromName
      if (typeof fromEmail === 'string') set.fromEmail = fromEmail
      if (typeof replyTo === 'string' || replyTo === null) set.replyTo = replyTo
      if (kind === 'marketing' || kind === 'transactional') set.kind = kind

      // Validate resulting (kind, fromEmail) against the senderDomains registry
      // whenever either field is being touched.
      if (typeof fromEmail === 'string' || kind === 'marketing' || kind === 'transactional') {
        const resultingKind = (set.kind as typeof tpl.kind) ?? tpl.kind
        const resultingFromEmail = (set.fromEmail as string) ?? tpl.fromEmail
        const senderCheck = validateSenderDomain(resultingFromEmail, resultingKind, mailer.config.senderDomains)
        if (!senderCheck.ok) {
          return res.status(400).json({
            error: 'sender_domain_invalid',
            code: senderCheck.code,
            message: senderCheck.reason,
          })
        }
      }
      if (typeof trackOpens === 'boolean') set.trackOpens = trackOpens
      if (typeof trackClicks === 'boolean') set.trackClicks = trackClicks

      await c.templates.updateOne({ _id: tpl._id }, { $set: set })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'template.draft.update',
        resource: { collection: 'mailer_templates', id: tpl._id, slug: tpl.slug },
      })
      return res.json({ ok: true })
    }),
  )

  r.post(
    '/templates/:slug/publish',
    asyncHandler(async (req, res) => {
      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })
      const draft = tpl.draft
      if (!draft) return res.status(400).json({ error: 'no_draft' })

      const senderCheck = validateSenderDomain(tpl.fromEmail, tpl.kind, mailer.config.senderDomains)
      if (!senderCheck.ok) {
        return res.status(400).json({
          error: 'sender_domain_invalid',
          code: senderCheck.code,
          message: senderCheck.reason,
        })
      }

      let compiled: { html: string; plainText: string; errors: any[] }
      if (draft.editorJson) {
        compiled = await compileMailyTemplate(draft.editorJson)
      } else if (draft.mjml) {
        compiled = await compileTemplate(draft.mjml)
      } else {
        return res.status(400).json({ error: 'empty_draft', message: 'draft has no MJML or editorJson content' })
      }

      const now = new Date()
      const nextVersion = await c.templateVersions.countDocuments({ templateId: tpl._id }) + 1
      await c.templateVersions.insertOne({
        templateId: tpl._id!,
        version: nextVersion,
        mjml: draft.mjml,
        html: compiled.html,
        plainText: compiled.plainText,
        subject: draft.subject,
        preheader: draft.preheader,
        publishedAt: now,
        publishedBy: (req as any).actor,
      })

      await c.templates.updateOne(
        { _id: tpl._id },
        {
          $set: {
            subject: draft.subject,
            preheader: draft.preheader,
            body: {
              mjml: draft.mjml,
              editorJson: draft.editorJson,
              html: compiled.html,
              plainText: compiled.plainText,
              compiledAt: now,
            },
            draft: null,
            publishedAt: now,
            publishedBy: (req as any).actor,
            updatedAt: now,
          },
        },
      )
      await mailer.audit({
        actor: (req as any).actor,
        action: 'template.publish',
        resource: { collection: 'mailer_templates', id: tpl._id, slug: tpl.slug },
        diffSummary: `Published v${nextVersion}`,
      })
      return res.json({ ok: true, version: nextVersion, warnings: compiled.errors })
    }),
  )

  r.post(
    '/templates/:slug/preview',
    asyncHandler(async (req, res) => {
      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })

      const useDraft = req.body?.useDraft !== false
      let html = ''
      let plainText = ''
      if (useDraft && tpl.draft) {
        const compiled = tpl.draft.editorJson
          ? await compileMailyTemplate(tpl.draft.editorJson)
          : await compileTemplate(tpl.draft.mjml || '<mjml><mj-body></mj-body></mjml>')
        html = compiled.html
        plainText = compiled.plainText
      } else {
        if (!tpl.body?.html) {
          return res.status(409).json({ error: 'not_published', message: 'Template has not been published yet.' })
        }
        html = tpl.body.html
        plainText = tpl.body.plainText
      }

      const sampleContact = req.body?.sampleContact ?? {
        externalId: 'preview-contact',
        email: 'preview@example.com',
        tags: [],
        fields: { firstName: 'Alex' },
      }
      const renderCtx = {
        contact: sampleContact,
        vars: req.body?.vars ?? {},
        unsubscribeUrl: `${mailer.config.publicUrl}/m/unsub/preview`,
        senderAddress: mailer.config.senderAddress,
      }

      const previewTpl = { ...tpl, body: { ...tpl.body, html, plainText } }
      const rendered = await renderTemplate(previewTpl as any, renderCtx, { helpers: mailer.config.handlebarsHelpers })
      return res.json({ subject: rendered.subject, preheader: rendered.preheader, html: rendered.html, plainText: rendered.plainText })
    }),
  )

  r.post(
    '/templates/:slug/send-test',
    asyncHandler(async (req, res) => {
      const { to, sampleData } = req.body ?? {}
      if (!to) return res.status(400).json({ error: 'to_required' })
      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })

      const contact = sampleData?.contact ?? {
        externalId: 'test-recipient',
        email: to,
        tags: [],
        fields: { firstName: 'Test' },
      }
      contact.email = to

      const renderCtx = {
        contact,
        vars: sampleData?.vars ?? {},
        unsubscribeUrl: `${mailer.config.publicUrl}/m/unsub/test`,
        senderAddress: mailer.config.senderAddress,
      }
      const rendered = await renderTemplate(tpl as any, renderCtx, { helpers: mailer.config.handlebarsHelpers })
      const tracking = applyTracking(rendered.html, {
        sendId: `test-${Date.now()}`,
        publicUrl: mailer.config.publicUrl,
        trackOpens: false,
        trackClicks: false,
      })

      const provider = mailer.providers[tpl.providerOverride ?? mailer.config.defaultProvider]!
      const result = await provider.send({
        to,
        fromName: rendered.fromName,
        fromEmail: rendered.fromEmail,
        subject: `[TEST] ${rendered.subject}`,
        html: tracking.html,
        text: rendered.plainText,
      })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'template.send-test',
        resource: { collection: 'mailer_templates', slug: tpl.slug },
        diffSummary: `to=${to}`,
      })
      // Avoid unused — sign helper is exposed for future preview routes.
      void signUnsubscribeToken
      return res.json({ ok: true, providerId: result.providerId })
    }),
  )

  // ----- Broadcasts: create / patch / schedule / cancel --------------------
  r.post(
    '/broadcasts',
    asyncHandler(async (req, res) => {
      const { slug, name, templateSlug, segmentDefinition } = req.body ?? {}
      if (!slug || !name || !templateSlug) {
        return res.status(400).json({ error: 'validation_failed', message: 'slug, name, templateSlug required' })
      }
      const now = new Date()
      try {
        await c.broadcasts.insertOne({
          slug,
          name,
          templateSlug,
          segmentDefinition: segmentDefinition ?? { filters: [{ kind: 'subscriptionStatus', equals: 'subscribed' }] },
          status: 'draft',
          scheduledAt: null,
          startedAt: null,
          completedAt: null,
          confirmationRequired: true,
          confirmedCount: null,
          confirmedAt: null,
          confirmedBy: null,
          recipientCount: null,
          stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
          createdAt: now,
          createdBy: (req as any).actor,
          updatedAt: now,
        } as any)
      } catch (err: any) {
        if (err?.code === 11000) return res.status(409).json({ error: 'slug_taken' })
        throw err
      }
      await mailer.audit({
        actor: (req as any).actor,
        action: 'broadcast.create',
        resource: { collection: 'mailer_broadcasts', slug },
      })
      return res.json({ ok: true, slug })
    }),
  )

  r.patch(
    '/broadcasts/:slug',
    asyncHandler(async (req, res) => {
      const b = await c.broadcasts.findOne({ slug: req.params.slug })
      if (!b) return res.status(404).json({ error: 'not_found' })
      if (b.status !== 'draft') return res.status(409).json({ error: 'not_draft' })
      const { name, templateSlug, segmentDefinition } = req.body ?? {}
      const set: Record<string, unknown> = { updatedAt: new Date() }
      if (typeof name === 'string') set.name = name
      if (typeof templateSlug === 'string') set.templateSlug = templateSlug
      if (segmentDefinition) set.segmentDefinition = segmentDefinition
      await c.broadcasts.updateOne({ _id: b._id }, { $set: set })
      return res.json({ ok: true })
    }),
  )

  r.post(
    '/broadcasts/:slug/segment/count',
    asyncHandler(async (req, res) => {
      const segmentDefinition = req.body?.segmentDefinition
      if (!segmentDefinition?.filters) return res.status(400).json({ error: 'segment_required' })
      const t0 = Date.now()
      // V1: only host-side filter translation. Mailer-side filters
      // (subscription status, fired events, etc.) and the suppression check
      // are applied at dispatch time over the streamed cursor, so the live
      // counter would have to scan-and-filter the full audience to be
      // precise. We return the upper-bound count and tell the UI it's an
      // estimate. When richer estimation lands, swap this for a sampled
      // pass that includes mailer-side filters + suppression.
      const hostFilter: any = {}
      for (const f of segmentDefinition.filters) {
        if (f.kind === 'hasTag') hostFilter.hasTag = f.tag
        if (f.kind === 'fieldEquals') hostFilter.fieldEquals = { field: f.field, value: f.value }
      }
      const hasMailerFilters = segmentDefinition.filters.some((f: any) =>
        ['subscriptionStatus', 'firedEvent', 'notFiredEvent', 'notHasTag', 'opened', 'notOpened', 'subscribedAfter', 'subscribedBefore'].includes(f.kind),
      )
      const upperBound = await mailer.adapter.count(hostFilter)
      return res.json({
        upperBound,
        approximate: hasMailerFilters,
        computedMs: Date.now() - t0,
      })
    }),
  )

  r.post(
    '/broadcasts/:slug/schedule',
    asyncHandler(async (req, res) => {
      const b = await c.broadcasts.findOne({ slug: req.params.slug })
      if (!b) return res.status(404).json({ error: 'not_found' })
      if (b.status !== 'draft') return res.status(409).json({ error: 'not_draft' })
      const { scheduledAt, confirmedCount, respectRecipientTimezone } = req.body ?? {}
      if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt_required' })
      const scheduled = new Date(scheduledAt)
      if (Number.isNaN(scheduled.getTime())) return res.status(400).json({ error: 'bad_scheduledAt' })

      const threshold = mailer.config.broadcastConfirmationThreshold
      if (typeof confirmedCount !== 'number') {
        return res.status(400).json({ error: 'confirmedCount_required' })
      }

      const set: Record<string, unknown> = {
        status: 'scheduled',
        scheduledAt: scheduled,
        confirmedCount,
        confirmedAt: new Date(),
        confirmedBy: (req as any).actor,
        updatedAt: new Date(),
      }
      if (respectRecipientTimezone) set.respectRecipientTimezone = true

      await c.broadcasts.updateOne({ _id: b._id }, { $set: set })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'broadcast.schedule',
        resource: { collection: 'mailer_broadcasts', id: b._id, slug: b.slug },
        diffSummary: `scheduled at ${scheduled.toISOString()} · confirmedCount=${confirmedCount} · threshold=${threshold}`,
      })
      return res.json({ ok: true })
    }),
  )

  r.post(
    '/broadcasts/:slug/cancel',
    asyncHandler(async (req, res) => {
      const b = await c.broadcasts.findOne({ slug: req.params.slug })
      if (!b) return res.status(404).json({ error: 'not_found' })
      await c.broadcasts.updateOne({ _id: b._id }, { $set: { status: 'cancelled', updatedAt: new Date() } })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'broadcast.cancel',
        resource: { collection: 'mailer_broadcasts', id: b._id, slug: b.slug },
      })
      return res.json({ ok: true })
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

/**
 * Sum inFlight and delayed across every queue the driver exposes. Returns
 * `null` for either count when the driver doesn't implement that accessor
 * (e.g. Agenda/Noop), so the UI can render "—" instead of a misleading 0.
 */
async function collectQueueCounts(
  mailer: Mailer,
): Promise<{ inFlight: number | null; delayed: number | null }> {
  const qs = Object.values(mailer.queues) as Array<{
    getInFlightCount?: () => Promise<number | null>
    getDelayedCount?: () => Promise<number | null>
  }>
  const sum = async (key: 'getInFlightCount' | 'getDelayedCount'): Promise<number | null> => {
    let total = 0
    let supported = false
    for (const q of qs) {
      const fn = q[key]
      if (!fn) continue
      try {
        const v = await fn.call(q)
        if (v == null) continue
        total += v
        supported = true
      } catch {
        // Treat one queue's failure as "unknown" — surface as null upstream.
        return null
      }
    }
    return supported ? total : null
  }
  const [inFlight, delayed] = await Promise.all([sum('getInFlightCount'), sum('getDelayedCount')])
  return { inFlight, delayed }
}

// ---------------------------------------------------------------------------
// Live stats aggregation
//
// The flow / template / broadcast list endpoints used to return zeros for
// every metric because no rollup ever wrote to `stats.*` on those docs. We
// now compute them on-the-fly from the canonical `sends` and `flowRuns`
// collections. Optional slug/id filters keep single-resource reads cheap.
// ---------------------------------------------------------------------------

interface FlowStats {
  activeRuns: number
  completedRuns: number
  sendsLast7Days: number
  sendsTotal: number
}
function emptyFlowStats(): FlowStats {
  return { activeRuns: 0, completedRuns: 0, sendsLast7Days: 0, sendsTotal: 0 }
}

async function computeFlowStats(mailer: Mailer, slugFilter?: string): Promise<Map<string, FlowStats>> {
  const out = new Map<string, FlowStats>()
  const match = slugFilter ? { flowSlug: slugFilter } : {}

  const runRows = await mailer.collections.flowRuns
    .aggregate<{ _id: { flowSlug: string; status: string }; count: number }>([
      { $match: match },
      { $group: { _id: { flowSlug: '$flowSlug', status: '$status' }, count: { $sum: 1 } } },
    ])
    .toArray()
  for (const row of runRows) {
    const slug = row._id.flowSlug
    if (!slug) continue
    const cur = out.get(slug) ?? emptyFlowStats()
    if (row._id.status === 'active') cur.activeRuns += row.count
    else if (row._id.status === 'completed') cur.completedRuns += row.count
    out.set(slug, cur)
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const sendRows = await mailer.collections.sends
    .aggregate<{ _id: string; total: number; last7: number }>([
      { $match: { flowRunId: { $ne: null } } },
      {
        $lookup: {
          from: mailer.collections.flowRuns.collectionName,
          localField: 'flowRunId',
          foreignField: '_id',
          as: 'run',
          pipeline: slugFilter
            ? [{ $match: { flowSlug: slugFilter } }, { $project: { flowSlug: 1 } }]
            : [{ $project: { flowSlug: 1 } }],
        },
      },
      { $unwind: '$run' },
      {
        $group: {
          _id: '$run.flowSlug',
          total: { $sum: 1 },
          last7: { $sum: { $cond: [{ $gte: ['$queuedAt', sevenDaysAgo] }, 1, 0] } },
        },
      },
    ])
    .toArray()
  for (const row of sendRows) {
    if (!row._id) continue
    const cur = out.get(row._id) ?? emptyFlowStats()
    cur.sendsTotal = row.total
    cur.sendsLast7Days = row.last7
    out.set(row._id, cur)
  }

  return out
}

interface TemplateStats {
  sent: number
  opened: number
  clicked: number
  bounced: number
  sentLast7Days: number
  lastSentAt: Date | null
}
function emptyTemplateStats(): TemplateStats {
  return { sent: 0, opened: 0, clicked: 0, bounced: 0, sentLast7Days: 0, lastSentAt: null }
}

async function computeTemplateStats(mailer: Mailer, slugFilter?: string): Promise<Map<string, TemplateStats>> {
  const out = new Map<string, TemplateStats>()
  const match: Record<string, unknown> = {}
  if (slugFilter) match.templateSlug = slugFilter
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const rows = await mailer.collections.sends
    .aggregate<{
      _id: string
      sent: number
      opened: number
      clicked: number
      bounced: number
      sentLast7Days: number
      lastSentAt: Date | null
    }>([
      { $match: match },
      {
        $group: {
          _id: '$templateSlug',
          sent: { $sum: 1 },
          opened: { $sum: { $cond: [{ $ifNull: ['$openedAt', false] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ifNull: ['$firstClickAt', false] }, 1, 0] } },
          bounced: { $sum: { $cond: [{ $eq: ['$status', 'bounced'] }, 1, 0] } },
          sentLast7Days: { $sum: { $cond: [{ $gte: ['$queuedAt', sevenDaysAgo] }, 1, 0] } },
          lastSentAt: { $max: '$queuedAt' },
        },
      },
    ])
    .toArray()
  for (const row of rows) {
    if (!row._id) continue
    out.set(row._id, {
      sent: row.sent,
      opened: row.opened,
      clicked: row.clicked,
      bounced: row.bounced,
      sentLast7Days: row.sentLast7Days,
      lastSentAt: row.lastSentAt ?? null,
    })
  }
  return out
}

interface BroadcastStats {
  delivered: number
  opened: number
  clicked: number
  bounced: number
}
function emptyBroadcastStats(): BroadcastStats {
  return { delivered: 0, opened: 0, clicked: 0, bounced: 0 }
}

async function computeBroadcastStats(
  mailer: Mailer,
  idFilter?: ObjectId,
): Promise<Map<string, BroadcastStats>> {
  const out = new Map<string, BroadcastStats>()
  const match: Record<string, unknown> = { broadcastId: { $ne: null } }
  if (idFilter) match.broadcastId = idFilter

  const rows = await mailer.collections.sends
    .aggregate<{
      _id: ObjectId
      delivered: number
      opened: number
      clicked: number
      bounced: number
    }>([
      { $match: match },
      {
        $group: {
          _id: '$broadcastId',
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          opened: { $sum: { $cond: [{ $ifNull: ['$openedAt', false] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ifNull: ['$firstClickAt', false] }, 1, 0] } },
          bounced: { $sum: { $cond: [{ $eq: ['$status', 'bounced'] }, 1, 0] } },
        },
      },
    ])
    .toArray()
  for (const row of rows) {
    if (!row._id) continue
    out.set(String(row._id), {
      delivered: row.delivered,
      opened: row.opened,
      clicked: row.clicked,
      bounced: row.bounced,
    })
  }
  return out
}
