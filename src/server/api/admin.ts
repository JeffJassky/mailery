/**
 * Admin router — serves the prebuilt React SPA + REST endpoints the SPA
 * consumes. Mount inside a host Express app, gated by host auth.
 *
 *   app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))
 *
 * REST routes under /api/* are documented in plans/14-admin-api.md.
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import net from 'node:net'
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
import { lintTemplate } from '../templates/linter.js'
import { resolveVars, varsJsonSchema, RESERVED_VAR_KEYS } from '../adapters/vars.js'
import type { Contact } from '../../shared/types.js'
import { runSetupChecks } from './setup-status.js'
import { sha256Hex, signUnsubscribeToken } from '../tokens.js'
import { effectiveOverallStatus } from '../runner/health.js'
import { runDnsblChecks } from '../runner/dnsbl.js'
import { runPostmasterPull } from '../runner/postmaster.js'
import { runSndsPull } from '../runner/snds.js'
import { ingestDmarcAttachment, resolveSourceTags, suggestPolicyProgression } from '../runner/dmarc.js'
import { computeListHygiene } from '../runner/hygiene.js'
import {
  createMailTesterClient,
  evaluateMailTesterGate,
  findCachedScore,
  mailTesterContentKey,
  persistScore,
  type MailTesterClient,
} from '../runner/mail-tester.js'
import { HEALTH_AGG_ID, healthBucketId } from '../models/index.js'

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
  /**
   * Inject a Mail-Tester client (tests use a stub). When omitted, a real
   * client is created from `mailer.config.mailTester`.
   */
  mailTesterClient?: MailTesterClient
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

  router.use('/api', apiRouter(mailer, opts))

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

function apiRouter(mailer: Mailer, opts: AdminRouterOptions = {}): Router {
  const r = Router()
  const c = mailer.collections

  // Computed once — the vars schema is fixed for the process lifetime.
  const varsSchema = mailer.config.varsAdapter ? varsJsonSchema(mailer.config.varsAdapter) : null

  function getMailTesterClient(): MailTesterClient | null {
    if (opts.mailTesterClient) return opts.mailTesterClient
    const cfg = mailer.config.mailTester
    if (!cfg?.apiKey) return null
    return createMailTesterClient(cfg)
  }

  // Vars contract for the template editor — JSON Schema of the host's
  // varsAdapter (null when none configured) plus the mailery-provided
  // built-in keys, so autocomplete/linting have one source of truth.
  r.get(
    '/vars-schema',
    asyncHandler(async (_req, res) => {
      res.json({ schema: varsSchema, builtins: RESERVED_VAR_KEYS })
    }),
  )

  r.get(
    '/me',
    asyncHandler(async (req, res) => {
      const [flows, templates, broadcasts, contacts, suppressions, healthDocs] = await Promise.all([
        c.flows.estimatedDocumentCount(),
        c.templates.estimatedDocumentCount(),
        c.broadcasts.estimatedDocumentCount(),
        c.subscriptions.countDocuments({ status: 'subscribed' }),
        c.suppressions.estimatedDocumentCount(),
        c.health.find({}).limit(500).toArray(),
      ])
      res.json({
        actor: (req as any).actor,
        counts: { flows, templates, broadcasts, contacts, suppressions },
        health: { status: effectiveOverallStatus(healthDocs) },
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

      const healthDocs = await c.health.find({}).limit(500).toArray()
      const healthAgg = healthDocs.find((d) => d._id === HEALTH_AGG_ID) ?? null
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
          status: effectiveOverallStatus(healthDocs),
          rates: healthAgg?.rates ?? null,
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

  // ----- Events registry ----------------------------------------------------
  r.get(
    '/events',
    asyncHandler(async (_req, res) => {
      const registered = mailer.events.list()
      const seenNames = await c.events.distinct('name')
      const known = new Set(registered.map((r) => r.name))
      const unregistered = (seenNames as string[]).filter((n) => n && !known.has(n))
      res.json({
        registered: registered.sort((a, b) => a.name.localeCompare(b.name)),
        seen: unregistered.sort(),
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
        c.flowRuns.find({ externalId, status: 'active' }).sort({ nextActionAt: 1 }).limit(50).toArray(),
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
        ? await c.webhookEvents
            .find({ providerMessageId: send.providerMessageId })
            .sort({ receivedAt: -1 })
            .limit(100)
            .toArray()
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
      const cb = mailer.config.circuitBreaker
      const thresholds = {
        hardBounceRatePctTrip: cb.hardBounceRatePctTrip,
        complaintRatePctTrip: cb.complaintRatePctTrip,
        combinedBounceRatePctTrip: cb.combinedBounceRatePctTrip,
        failedToSendRatePctDegrade: cb.failedToSendRatePctDegrade,
      }
      const docs = await c.health.find({}).limit(500).toArray()
      const aggregate = docs.find((d) => d._id === HEALTH_AGG_ID) ?? null
      const buckets = docs.filter((d) => d._id !== HEALTH_AGG_ID)
      const overall = effectiveOverallStatus(docs)
      if (docs.length === 0) {
        // No tick has run yet. UI renders "—" / muted dots when status is null.
        res.json({ status: null, rates: null, counters: null, aggregate: null, buckets: [], thresholds })
        return
      }
      // Keep top-level `status` / `rates` for back-compat with consumers that
      // expect a single status (broadcast-new pre-flight, shell pill).
      res.json({
        status: overall,
        rates: aggregate?.rates ?? null,
        counters: aggregate?.counters ?? null,
        aggregate,
        buckets,
        thresholds,
      })
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
      const body = (req.body ?? {}) as { senderDomain?: string; kind?: 'marketing' | 'transactional' }
      // Half-specified body (only senderDomain or only kind) is almost
      // certainly an operator error — fail closed rather than silently
      // resume every tripped bucket.
      if ((body.senderDomain != null) !== (body.kind != null)) {
        return res.status(400).json({
          error: 'validation_failed',
          message: 'senderDomain and kind must both be provided to target a single bucket, or both omitted to resume all tripped buckets.',
        })
      }
      if (body.kind && !['marketing', 'transactional'].includes(body.kind)) {
        return res.status(400).json({ error: 'validation_failed', message: 'kind must be "marketing" or "transactional"' })
      }
      const target = body.senderDomain && body.kind
        ? { _id: healthBucketId(body.senderDomain.toLowerCase(), body.kind) }
        // Explicitly exclude the aggregate doc — it never trips, but guard
        // anyway so a future schema change can't accidentally flip its status.
        : { status: 'tripped' as const, _id: { $ne: HEALTH_AGG_ID } }

      const result = await c.health.updateMany(
        target,
        { $set: { status: 'healthy', manuallyResumedAt: new Date(), updatedAt: new Date() } },
      )
      await mailer.audit({
        actor: (req as any).actor,
        action: 'health.resume',
        resource: {
          collection: 'mailer_health',
          id: body.senderDomain && body.kind ? `${body.senderDomain}|${body.kind}` : 'all-tripped',
        },
      })
      res.json({ ok: true, resumed: result.modifiedCount })
    }),
  )

  // ----- DNSBL --------------------------------------------------------------
  r.get(
    '/dnsbl',
    asyncHandler(async (_req, res) => {
      const checks = await c.dnsblChecks.find({}).sort({ result: 1, target: 1, list: 1 }).limit(500).toArray()
      const latestRunAt = checks.reduce<Date | null>((acc, d) => {
        const t = new Date(d.runAt)
        return acc && acc.getTime() >= t.getTime() ? acc : t
      }, null)
      res.json({
        checks,
        latestRunAt: latestRunAt ? latestRunAt.toISOString() : null,
        intervalHours: mailer.config.dnsbl?.intervalHours ?? 24,
      })
    }),
  )

  r.post(
    '/dnsbl/recheck',
    asyncHandler(async (req, res) => {
      const result = await runDnsblChecks(mailer.getRunnerContext(), { force: true })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'dnsbl.recheck',
        resource: { collection: 'mailer_dnsbl_checks' },
        diffSummary: result.ran
          ? `${result.totalChecks} checks, ${result.listedCount} listed`
          : `not run: ${result.reason}`,
      })
      res.json(result)
    }),
  )

  // ----- Postmaster Tools ---------------------------------------------------
  r.get(
    '/postmaster',
    asyncHandler(async (_req, res) => {
      const cfg = mailer.config.postmaster
      const configured = !!cfg?.clientId && !!cfg?.clientSecret && !!cfg?.refreshToken
      const all = await c.postmasterSnapshots.find({}).sort({ domain: 1, date: -1 }).limit(2000).toArray()
      // Group by domain, keep last 30 entries per domain.
      const byDomain = new Map<string, typeof all>()
      for (const s of all) {
        const arr = byDomain.get(s.domain) ?? []
        if (arr.length < 30) arr.push(s)
        byDomain.set(s.domain, arr)
      }
      const domains = Array.from(byDomain.entries()).map(([domain, snapshots]) => ({
        domain,
        latest: snapshots[0] ?? null,
        history: snapshots,
      }))
      res.json({
        configured,
        intervalHours: cfg?.intervalHours ?? 24,
        domains,
      })
    }),
  )

  r.post(
    '/postmaster/refresh',
    asyncHandler(async (req, res) => {
      const result = await runPostmasterPull(mailer.getRunnerContext(), { force: true })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'postmaster.refresh',
        resource: { collection: 'mailer_postmaster_snapshots' },
        diffSummary: result.ran
          ? `fetched ${result.fetched ?? 0}, tripped ${(result.trippedDomains ?? []).length}`
          : `not run: ${result.reason}`,
      })
      res.json(result)
    }),
  )

  // ----- List Hygiene -------------------------------------------------------
  // The hygiene aggregation iterates every send doc — at scale that's
  // expensive. Cache the result for 60s and serialize concurrent requests
  // so a few rapid-fire dashboard loads can't pile up multiple full scans.
  let hygieneCache: { computedAt: number; report: Awaited<ReturnType<typeof computeListHygiene>> } | null = null
  let hygieneInFlight: Promise<Awaited<ReturnType<typeof computeListHygiene>>> | null = null
  const HYGIENE_CACHE_MS = 60_000

  r.get(
    '/hygiene',
    asyncHandler(async (req, res) => {
      const force = req.query.refresh === '1' || req.query.refresh === 'true'
      const now = Date.now()
      if (!force && hygieneCache && now - hygieneCache.computedAt < HYGIENE_CACHE_MS) {
        return res.json(hygieneCache.report)
      }
      if (!hygieneInFlight) {
        hygieneInFlight = (async () => {
          try {
            const report = await computeListHygiene(mailer.getRunnerContext())
            hygieneCache = { computedAt: Date.now(), report }
            return report
          } finally {
            hygieneInFlight = null
          }
        })()
      }
      const report = await hygieneInFlight
      res.json(report)
    }),
  )

  // ----- DMARC RUA ingestion ------------------------------------------------
  const dmarcUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB; reports are typically <100KB
  })

  r.post(
    '/dmarc/upload',
    dmarcUpload.single('file'),
    asyncHandler(async (req, res) => {
      const file = (req as any).file as Express.Multer.File | undefined
      if (!file) return res.status(400).json({ error: 'no_file', message: 'expected a "file" field' })

      try {
        const result = await ingestDmarcAttachment(mailer.getRunnerContext(), file.buffer, file.originalname)
        await mailer.audit({
          actor: (req as any).actor,
          action: 'dmarc.ingest',
          resource: { collection: 'mailer_dmarc_reports', id: result.reportId },
          diffSummary: result.duplicate
            ? `duplicate report ${result.reportId}`
            : `ingested ${result.totalMessages} msgs (${result.passCount} pass / ${result.failCount} fail) for ${result.domain}`,
        })
        return res.json(result)
      } catch (err: any) {
        return res.status(400).json({ error: 'ingest_failed', message: String(err?.message ?? err) })
      }
    }),
  )

  r.get(
    '/dmarc',
    asyncHandler(async (_req, res) => {
      const ctx = mailer.getRunnerContext()
      const tagged = await resolveSourceTags(ctx)
      const reports = await c.dmarcReports.find({}).sort({ rangeEnd: -1 }).limit(200).toArray()
      const since30 = new Date(Date.now() - 30 * 86_400_000)
      // Cap at 5k rows — busy domains can easily generate that many failure
      // rows over 30 days. We only consume these for per-domain progression
      // suggestions (untagged-source check); a partial page is fine.
      const recentFailures = await c.dmarcFailures
        .find({ receivedAt: { $gte: since30 } })
        .sort({ receivedAt: -1 })
        .limit(5000)
        .toArray()

      const byDomain = new Map<string, { passCount: number; failCount: number; totalMessages: number; reportCount: number; latestRangeEnd: Date | null; latestPolicy: 'none' | 'quarantine' | 'reject' | null; latestPct: number | null; reports: typeof reports }>()
      for (const r of reports) {
        const cur = byDomain.get(r.domain) ?? { passCount: 0, failCount: 0, totalMessages: 0, reportCount: 0, latestRangeEnd: null, latestPolicy: null, latestPct: null, reports: [] }
        cur.passCount += r.passCount
        cur.failCount += r.failCount
        cur.totalMessages += r.totalMessages
        cur.reportCount += 1
        const re = new Date(r.rangeEnd)
        if (!cur.latestRangeEnd || re > cur.latestRangeEnd) {
          cur.latestRangeEnd = re
          cur.latestPolicy = r.policyP
          cur.latestPct = r.policyPct
        }
        cur.reports.push(r)
        byDomain.set(r.domain, cur)
      }

      // Build per-day alignment series (last 14 days) per domain for sparklines.
      const since14 = Date.now() - 14 * 86_400_000

      const domains = Array.from(byDomain.entries()).map(([domain, s]) => {
        // Sparkline series — pass rate per day from recent reports.
        const dayTotals = new Map<string, { pass: number; total: number }>()
        for (const r of s.reports) {
          if (new Date(r.rangeEnd).getTime() < since14) continue
          const day = new Date(r.rangeEnd).toISOString().slice(0, 10)
          const d = dayTotals.get(day) ?? { pass: 0, total: 0 }
          d.pass += r.passCount
          d.total += r.passCount + r.failCount
          dayTotals.set(day, d)
        }
        const series = Array.from(dayTotals.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([day, d]) => ({ day, alignmentRate: d.total === 0 ? null : d.pass / d.total }))

        // Policy progression suggestion.
        const knownIps = new Set(Array.from(tagged.values()).filter((t) => !t.ignored).map((t) => t.ip))
        const ignoredIps = new Set(Array.from(tagged.values()).filter((t) => t.ignored).map((t) => t.ip))
        const suggested = suggestPolicyProgression({
          reports: s.reports.map((r) => ({ rangeEnd: new Date(r.rangeEnd), passCount: r.passCount, failCount: r.failCount })),
          failures: recentFailures.filter((f) => f.domain === domain).map((f) => ({ sourceIp: f.sourceIp, count: f.count, receivedAt: new Date(f.receivedAt) })),
          knownSourceIps: knownIps,
          ignoredSourceIps: ignoredIps,
          currentPolicy: s.latestPolicy,
          currentPct: s.latestPct,
        })

        return {
          domain,
          passCount: s.passCount,
          failCount: s.failCount,
          totalMessages: s.totalMessages,
          reportCount: s.reportCount,
          latestRangeEnd: s.latestRangeEnd,
          alignmentRate: s.totalMessages === 0 ? null : s.passCount / s.totalMessages,
          currentPolicy: s.latestPolicy,
          currentPct: s.latestPct,
          progression: suggested
            ? { ...suggested, current: { policy: s.latestPolicy, pct: s.latestPct } }
            : null,
          series,
        }
      })

      const topFailures = await c.dmarcFailures
        .aggregate<{ _id: { sourceIp: string; domain: string }; total: number; days: number; lastSeen: Date; sample: any }>([
          { $match: { receivedAt: { $gte: since30 } } },
          {
            $group: {
              _id: { sourceIp: '$sourceIp', domain: '$domain' },
              total: { $sum: '$count' },
              days: { $addToSet: '$day' },
              lastSeen: { $max: '$receivedAt' },
              sample: { $first: '$$ROOT' },
            },
          },
          { $project: { sourceIp: '$_id.sourceIp', domain: '$_id.domain', total: 1, days: { $size: '$days' }, lastSeen: 1, sample: 1 } },
          { $sort: { total: -1 } },
          { $limit: 50 },
        ])
        .toArray()

      const sources = topFailures.map((f) => {
        const tag = tagged.get(f._id.sourceIp)
        return {
          sourceIp: f._id.sourceIp,
          domain: f._id.domain,
          totalMessages: f.total,
          daysSeen: f.days,
          lastSeen: f.lastSeen,
          dkimResult: f.sample.dkimResult,
          spfResult: f.sample.spfResult,
          dispositionApplied: f.sample.dispositionApplied,
          label: tag?.label ?? null,
          ignored: !!tag?.ignored,
          tagSource: tag?.source ?? null,
        }
      })

      res.json({
        domains,
        sources,
        recentReports: reports.slice(0, 30),
        retentionDays: mailer.config.dmarc?.retentionDays ?? 90,
      })
    }),
  )

  // ----- DMARC source tags (mutable from UI) --------------------------------
  r.put(
    '/dmarc/sources/:ip',
    asyncHandler(async (req, res) => {
      const ip = String(req.params.ip ?? '')
      if (!net.isIP(ip)) {
        return res.status(400).json({ error: 'validation_failed', message: 'invalid IP' })
      }
      const body = (req.body ?? {}) as { label?: string; ignored?: boolean }
      if (!body.label || typeof body.label !== 'string') {
        return res.status(400).json({ error: 'validation_failed', message: 'label is required' })
      }
      const label = body.label.trim().slice(0, 200)
      if (!label) {
        return res.status(400).json({ error: 'validation_failed', message: 'label is required' })
      }
      const ignored = !!body.ignored
      await c.dmarcSourceTags.updateOne(
        { ip },
        { $set: { ip, label, ignored, setBy: (req as any).actor ?? 'unknown', setAt: new Date() } },
        { upsert: true },
      )
      await mailer.audit({
        actor: (req as any).actor,
        action: 'dmarc.source_tag.upsert',
        resource: { collection: 'mailer_dmarc_source_tags', id: ip },
        diffSummary: `${ip} → "${label}"${ignored ? ' (ignored)' : ''}`,
      })
      res.json({ ok: true })
    }),
  )

  r.delete(
    '/dmarc/sources/:ip',
    asyncHandler(async (req, res) => {
      const ip = String(req.params.ip ?? '')
      if (!net.isIP(ip)) {
        return res.status(400).json({ error: 'validation_failed', message: 'invalid IP' })
      }
      const result = await c.dmarcSourceTags.deleteOne({ ip })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'dmarc.source_tag.delete',
        resource: { collection: 'mailer_dmarc_source_tags', id: ip },
      })
      res.json({ ok: true, deleted: result.deletedCount })
    }),
  )

  // ----- Microsoft SNDS -----------------------------------------------------
  r.get(
    '/snds',
    asyncHandler(async (_req, res) => {
      const cfg = mailer.config.snds
      const configured = !!cfg?.accessKey
      const all = await c.sndsSnapshots.find({}).sort({ ip: 1, activityStart: -1 }).limit(2000).toArray()
      const byIp = new Map<string, typeof all>()
      for (const s of all) {
        const arr = byIp.get(s.ip) ?? []
        if (arr.length < 30) arr.push(s)
        byIp.set(s.ip, arr)
      }
      const ips = Array.from(byIp.entries()).map(([ip, snapshots]) => ({
        ip,
        latest: snapshots[0] ?? null,
        history: snapshots,
      }))
      res.json({
        configured,
        intervalHours: cfg?.intervalHours ?? 24,
        ips,
      })
    }),
  )

  r.post(
    '/snds/refresh',
    asyncHandler(async (req, res) => {
      const result = await runSndsPull(mailer.getRunnerContext(), { force: true })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'snds.refresh',
        resource: { collection: 'mailer_snds_snapshots' },
        diffSummary: result.ran
          ? `parsed ${result.rowsParsed ?? 0}, persisted ${result.rowsPersisted ?? 0}`
          : `not run: ${result.reason}`,
      })
      res.json(result)
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

  // ----- Mail-Tester deliverability check ----------------------------------
  r.get(
    '/templates/:slug/mail-tester',
    asyncHandler(async (req, res) => {
      const cfg = mailer.config.mailTester
      const configured = !!cfg?.apiKey
      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })

      // Cache key must reflect the same fingerprint the check + publish gate
      // use — render the *current* draft if there is one, otherwise the
      // most recent published body. Previously this mixed draft.subject
      // with published body.html, which always missed pre-first-publish
      // and drifted whenever a subject edit followed a publish.
      let bodyHash = ''
      let subject = tpl.subject ?? ''
      if (tpl.draft) {
        try {
          const compiled = tpl.draft.editorJson
            ? await compileMailyTemplate(tpl.draft.editorJson)
            : tpl.draft.mjml
            ? await compileTemplate(tpl.draft.mjml)
            : null
          if (compiled) {
            bodyHash = sha256Hex(compiled.html)
            subject = tpl.draft.subject || subject
          }
        } catch {
          // If the draft no longer compiles, fall back to the published body.
        }
      }
      if (!bodyHash && tpl.body?.html) {
        bodyHash = sha256Hex(tpl.body.html)
      }
      const key = bodyHash ? mailTesterContentKey({ bodyHash, subject, fromEmail: tpl.fromEmail }) : null
      const cached = key ? await findCachedScore(mailer.getRunnerContext(), key) : null

      res.json({
        configured,
        minScore: cfg?.minScore ?? 8.0,
        cacheHours: cfg?.cacheHours ?? 24,
        score: cached,
      })
    }),
  )

  r.post(
    '/templates/:slug/mail-tester-check',
    asyncHandler(async (req, res) => {
      const client = getMailTesterClient()
      if (!client) {
        return res.status(400).json({
          error: 'not_configured',
          message: 'Mail-Tester is not configured. Set mailer.config.mailTester.apiKey to enable.',
        })
      }

      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })
      const draft = tpl.draft
      if (!draft) return res.status(400).json({ error: 'no_draft', message: 'Save a draft before running a deliverability check.' })

      let compiled: { html: string; plainText: string }
      try {
        if (draft.editorJson) compiled = await compileMailyTemplate(draft.editorJson)
        else if (draft.mjml) compiled = await compileTemplate(draft.mjml)
        else return res.status(400).json({ error: 'empty_draft' })
      } catch (err: any) {
        return res.status(400).json({ error: 'compile_failed', message: String(err?.message ?? err) })
      }

      const bodyHash = sha256Hex(compiled.html)
      const contentKey = mailTesterContentKey({ bodyHash, subject: draft.subject, fromEmail: tpl.fromEmail })
      const ctx = mailer.getRunnerContext()

      // Cache hit — return without burning a credit.
      const cached = await findCachedScore(ctx, contentKey)
      if (cached) {
        return res.json({ cached: true, status: 'ready', score: cached })
      }

      // Provision a new test address and send the rendered draft to it.
      const { checkId, emailAddress } = await client.provisionCheck()
      const provider = mailer.providers[tpl.providerOverride ?? mailer.config.defaultProvider]
      if (!provider) {
        return res.status(500).json({ error: 'provider_unknown', message: `default provider ${mailer.config.defaultProvider} is not registered` })
      }

      try {
        await provider.send({
          to: emailAddress,
          fromName: tpl.fromName,
          fromEmail: tpl.fromEmail,
          replyTo: tpl.replyTo ?? undefined,
          subject: draft.subject,
          html: compiled.html,
          text: compiled.plainText,
          headers: {},
          messageMeta: { mailTesterCheckId: checkId },
        })
      } catch (err: any) {
        return res.status(502).json({ error: 'send_failed', message: String(err?.message ?? err) })
      }

      await mailer.audit({
        actor: (req as any).actor,
        action: 'mail_tester.check.start',
        resource: { collection: 'mailer_mail_tester_scores', id: contentKey, slug: tpl.slug },
        diffSummary: `Sent draft to ${emailAddress} for Mail-Tester check ${checkId}`,
      })

      res.json({
        cached: false,
        status: 'pending',
        checkId,
        contentKey,
        message: 'Test email sent. Poll /mail-tester-result?checkId=...&contentKey=... for the score.',
      })
    }),
  )

  r.get(
    '/templates/:slug/mail-tester-result',
    asyncHandler(async (req, res) => {
      const client = getMailTesterClient()
      if (!client) return res.status(400).json({ error: 'not_configured' })

      const checkId = String(req.query.checkId ?? '')
      if (!checkId) return res.status(400).json({ error: 'validation_failed', message: 'checkId is required' })

      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })
      const draft = tpl.draft
      if (!draft) return res.status(400).json({ error: 'no_draft', message: 'Draft no longer exists.' })

      // Re-derive the content key server-side from the current draft so an
      // attacker can't land a score under an arbitrary fingerprint and game
      // the publish gate. We must recompile to recompute bodyHash.
      let compiled: { html: string; plainText: string }
      try {
        if (draft.editorJson) compiled = await compileMailyTemplate(draft.editorJson)
        else if (draft.mjml) compiled = await compileTemplate(draft.mjml)
        else return res.status(400).json({ error: 'empty_draft' })
      } catch (err: any) {
        return res.status(400).json({ error: 'compile_failed', message: String(err?.message ?? err) })
      }
      const contentKey = mailTesterContentKey({
        bodyHash: sha256Hex(compiled.html),
        subject: draft.subject,
        fromEmail: tpl.fromEmail,
      })

      const result = await client.fetchResult(checkId)
      if (!result.ready) {
        return res.json({ status: 'pending', score: null })
      }

      const ctx = mailer.getRunnerContext()
      const persisted = await persistScore(ctx, { templateSlug: tpl.slug, contentKey, checkId, result })
      await mailer.audit({
        actor: (req as any).actor,
        action: 'mail_tester.check.complete',
        resource: { collection: 'mailer_mail_tester_scores', id: contentKey, slug: tpl.slug },
        diffSummary: `Score ${result.score.toFixed(1)}`,
      })
      res.json({ status: 'ready', score: persisted })
    }),
  )

  r.post(
    '/templates/:slug/lint',
    asyncHandler(async (req, res) => {
      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })

      // Lint against the supplied draft if present, otherwise the saved draft,
      // otherwise the last-published body. Keep this tolerant so the editor
      // can call it without juggling round-trips.
      const body = (req.body ?? {}) as {
        subject?: string
        preheader?: string
        mjml?: string
        editorJson?: Record<string, unknown> | null
        fromEmail?: string
        kind?: 'marketing' | 'transactional'
      }

      const subject = body.subject ?? tpl.draft?.subject ?? tpl.subject ?? ''
      const preheader = body.preheader ?? tpl.draft?.preheader ?? tpl.preheader ?? ''
      const mjml = body.mjml ?? tpl.draft?.mjml ?? tpl.body?.mjml ?? ''
      const editorJson = body.editorJson !== undefined ? body.editorJson : (tpl.draft?.editorJson ?? tpl.body?.editorJson ?? null)
      const fromEmail = body.fromEmail ?? tpl.fromEmail
      // Whitelist kind — otherwise body.kind:'foo' bypasses the marketing-
      // only missing_unsubscribe_tag check by hitting neither branch.
      const kind = body.kind === 'marketing' || body.kind === 'transactional' ? body.kind : tpl.kind

      let html = ''
      let plainText = ''
      try {
        if (editorJson) {
          const compiled = await compileMailyTemplate(editorJson)
          html = compiled.html
          plainText = compiled.plainText
        } else if (mjml) {
          const compiled = await compileTemplate(mjml)
          html = compiled.html
          plainText = compiled.plainText
        }
      } catch (err: any) {
        return res.status(200).json({
          errors: [{ rule: 'compile_failed', severity: 'error', message: `Compile error: ${String(err?.message ?? err)}` }],
          warnings: [],
          infos: [],
          compileFailed: true,
        })
      }

      const lint = lintTemplate(
        { subject, preheader, mjml, editorJson, html, plainText, kind, fromEmail },
        { senderDomains: mailer.config.senderDomains, varsJsonSchema: varsSchema },
      )
      res.json({ ...lint, compileFailed: false })
    }),
  )

  r.post(
    '/templates/:slug/publish',
    asyncHandler(async (req, res) => {
      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })
      const draft = tpl.draft
      if (!draft) return res.status(400).json({ error: 'no_draft' })

      // Short-circuit sender-domain check — preserves the pre-linter 400
      // sender_domain_invalid contract so external callers (and the SPA's
      // own publish modal) can key on it without conflating with lint errors.
      const senderCheck = validateSenderDomain(tpl.fromEmail, tpl.kind, mailer.config.senderDomains)
      if (!senderCheck.ok) {
        return res.status(400).json({
          error: 'sender_domain_invalid',
          code: senderCheck.code,
          message: senderCheck.reason,
        })
      }

      let compiled: { html: string; plainText: string; errors: any[] }
      try {
        if (draft.editorJson) {
          compiled = await compileMailyTemplate(draft.editorJson)
        } else if (draft.mjml) {
          compiled = await compileTemplate(draft.mjml)
        } else {
          return res.status(400).json({ error: 'empty_draft', message: 'draft has no MJML or editorJson content' })
        }
      } catch (err: any) {
        // Same shape as the lint endpoint's compileFailed branch so the UI
        // can surface compile errors uniformly with lint errors.
        return res.status(422).json({
          error: 'compile_failed',
          message: String(err?.message ?? err),
          lint: {
            errors: [{ rule: 'compile_failed', severity: 'error', message: `Compile error: ${String(err?.message ?? err)}` }],
            warnings: [],
            infos: [],
          },
        })
      }

      const lint = lintTemplate(
        {
          subject: draft.subject,
          preheader: draft.preheader,
          mjml: draft.mjml ?? '',
          editorJson: draft.editorJson,
          html: compiled.html,
          plainText: compiled.plainText,
          kind: tpl.kind,
          fromEmail: tpl.fromEmail,
        },
        { senderDomains: mailer.config.senderDomains, varsJsonSchema: varsSchema },
      )

      if (lint.errors.length > 0) {
        return res.status(422).json({
          error: 'lint_failed',
          message: `Template publish blocked by ${lint.errors.length} content issue(s).`,
          lint,
        })
      }

      // Mail-Tester gate — only blocks when configured AND a cached score for
      // this exact content exists AND that score is below minScore. Operator
      // can override with `bypassMailTester: true` in the request body.
      const bypass = Boolean(req.body?.bypassMailTester)
      if (!bypass) {
        const gate = await evaluateMailTesterGate(mailer.getRunnerContext(), {
          bodyHash: sha256Hex(compiled.html),
          subject: draft.subject,
          fromEmail: tpl.fromEmail,
        })
        if (!gate.allowed) {
          return res.status(422).json({
            error: 'mail_tester_blocked',
            message: gate.reason,
            score: gate.score,
            hint: 'Re-run the deliverability check after fixing the feedback, or POST `bypassMailTester: true` to publish anyway.',
          })
        }
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
      return res.json({
        ok: true,
        version: nextVersion,
        warnings: compiled.errors,
        lint, // warnings + infos for UI
      })
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

      // Preview as a real contact when contactId is given — pulls the actual
      // contact through the adapter and runs the host's varsAdapter, so the
      // preview shows exactly what that person would receive.
      let contact: Contact
      const contactId = typeof req.body?.contactId === 'string' ? req.body.contactId : null
      if (contactId) {
        const found = await mailer.adapter.getById(contactId)
        if (!found) return res.status(404).json({ error: 'contact_not_found', contactId })
        contact = found
      } else {
        contact = req.body?.sampleContact ?? {
          externalId: 'preview-contact',
          email: 'preview@example.com',
          tags: [],
          fields: { firstName: 'Alex' },
        }
      }

      // Optional simulated trigger-event properties, so account/topic-scoped
      // templates ({{event.*}} or resolver branching) preview realistically.
      const eventProperties =
        req.body?.eventProperties && typeof req.body.eventProperties === 'object'
          ? (req.body.eventProperties as Record<string, unknown>)
          : undefined

      let resolved: Record<string, unknown> = {}
      try {
        resolved = await resolveVars(mailer.config.varsAdapter, contact, {
          reason: 'preview',
          templateSlug: tpl.slug,
          eventProperties,
        })
      } catch (err: any) {
        return res.status(502).json({
          error: 'vars_resolve_failed',
          message: `varsAdapter.resolve threw: ${String(err?.message ?? err)}`,
        })
      }

      const renderCtx = {
        ...resolved,
        contact,
        vars: req.body?.vars ?? {},
        event: eventProperties ?? {},
        unsubscribeUrl: `${mailer.config.publicUrl}/m/unsub/preview`,
        senderAddress: mailer.config.senderAddress,
      }

      const previewTpl = { ...tpl, body: { ...tpl.body, html, plainText } }
      const rendered = await renderTemplate(previewTpl as any, renderCtx, { helpers: mailer.config.handlebarsHelpers })
      return res.json({
        subject: rendered.subject,
        preheader: rendered.preheader,
        html: rendered.html,
        plainText: rendered.plainText,
        contact: { externalId: contact.externalId, email: contact.email },
      })
    }),
  )

  r.post(
    '/templates/:slug/send-test',
    asyncHandler(async (req, res) => {
      const { to, sampleData, contactId, eventProperties } = req.body ?? {}
      if (!to) return res.status(400).json({ error: 'to_required' })
      const tpl = await c.templates.findOne({ slug: req.params.slug })
      if (!tpl) return res.status(404).json({ error: 'not_found' })

      // Render as a real contact when contactId is given (vars included),
      // but always deliver to the operator-typed address.
      let contact: Contact
      if (typeof contactId === 'string' && contactId) {
        const found = await mailer.adapter.getById(contactId)
        if (!found) return res.status(404).json({ error: 'contact_not_found', contactId })
        contact = { ...found, email: to }
      } else {
        contact = sampleData?.contact ?? {
          externalId: 'test-recipient',
          email: to,
          tags: [],
          fields: { firstName: 'Test' },
        }
        contact.email = to
      }

      const evProps =
        eventProperties && typeof eventProperties === 'object'
          ? (eventProperties as Record<string, unknown>)
          : undefined

      let resolved: Record<string, unknown> = {}
      try {
        resolved = await resolveVars(mailer.config.varsAdapter, contact, {
          reason: 'test',
          templateSlug: tpl.slug,
          eventProperties: evProps,
        })
      } catch (err: any) {
        return res.status(502).json({
          error: 'vars_resolve_failed',
          message: `varsAdapter.resolve threw: ${String(err?.message ?? err)}`,
        })
      }

      const renderCtx = {
        ...resolved,
        contact,
        vars: sampleData?.vars ?? {},
        event: evProps ?? {},
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
