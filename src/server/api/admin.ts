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
      // Stage A: host-side via adapter. For V1 we just translate the first
      // host-side filter we recognize; richer segmentation lands later.
      const hostFilter: any = {}
      for (const f of segmentDefinition.filters) {
        if (f.kind === 'hasTag') hostFilter.hasTag = f.tag
        if (f.kind === 'fieldEquals') hostFilter.fieldEquals = { field: f.field, value: f.value }
      }
      const stageA = await mailer.adapter.count(hostFilter)
      // Stage B + suppression are estimated for the live counter; the real
      // numbers come at dispatch time when the cursor is streamed.
      return res.json({ stageA, stageB: stageA, afterSuppression: stageA, computedMs: Date.now() - t0 })
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
