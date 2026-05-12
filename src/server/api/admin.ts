/**
 * Admin router — serves the built React SPA + stub REST endpoints.
 *
 * Mount inside a host Express app, gated by host auth:
 *
 *   import express from 'express'
 *   import { createAdminRouter } from 'mailery'
 *
 *   app.use('/admin/mailer', requireAdmin, createAdminRouter())
 *
 * Routes mounted under the base path:
 *   /_assets/*       → built SPA bundle (CSS, JS, sourcemaps)
 *   /api/*           → JSON endpoints consumed by the SPA
 *   anything else    → SPA shell (index.html), so client-side routing works
 *
 * V1 endpoints return sample data so the SPA renders. Real implementations
 * land in Phase 0+ as runner/data-model modules come online.
 */

import express, { Router, type Request, type Response } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Where the built SPA lives, relative to this compiled module. */
function defaultSpaDir(): string {
  // After tsup build: src/admin/router.ts → dist/router.js (flat). SPA at dist/admin/spa/.
  // After Vite build: admin/index.html → dist/admin/spa/index.html.
  return path.resolve(__dirname, 'admin/spa')
}

export interface AdminRouterOptions {
  /** Override path to the built SPA. Defaults to the location shipped in dist/. */
  spaDir?: string
}

export function createAdminRouter(opts: AdminRouterOptions = {}): Router {
  const router = Router()
  const spaDir = opts.spaDir ?? defaultSpaDir()

  // 1. Static assets (CSS, JS, source maps) — long-cache friendly because Vite hashes filenames.
  router.use(
    '/_assets',
    express.static(spaDir, {
      maxAge: '1y',
      immutable: true,
      index: false,
    }),
  )

  // 2. JSON API stubs. These return the same shape the SPA's `lib/mock.ts` uses today;
  //    real implementations swap in once the runner + data-model modules land.
  router.use('/api', stubApiRouter())

  // 3. SPA shell — every other GET returns the built index.html.
  router.get(/.*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(spaDir, 'index.html'))
  })

  return router
}

function stubApiRouter(): Router {
  const api = Router()

  api.get('/dashboard', (_req, res) => {
    res.json({
      kpis: {
        sends: { value: 14318, delta: 0.084 },
        deliveredRate: { value: 0.9942, delta: 0.0012, bounced: 83 },
        openRate: { value: 0.478, delta: -0.011, exclBots: true },
        clickRate: { value: 0.112, delta: 0.006 },
      },
      health: {
        status: 'healthy',
        rates: { hardBounce: 0.0031, complaint: 0.0002, combinedBounce: 0.0118, failedToSend: 0.0004 },
      },
      queue: { inFlight: 412, delayed: 9184, providerOk: true, providerName: 'sendgrid' },
      sendSeries: [12, 14, 9, 11, 18, 22, 31, 28, 24, 31, 38, 42, 39, 36, 41, 48, 52, 49, 44, 38, 32, 28, 22, 18],
      openSeries: [8, 9, 6, 7, 11, 14, 19, 18, 16, 21, 26, 28, 26, 24, 27, 32, 35, 33, 30, 26, 22, 19, 15, 12],
    })
  })

  api.get('/flows', (_req, res) => {
    res.json([
      { slug: 'welcome', name: 'Welcome series', trigger: 'event: Created', goal: 'activation', enabled: true, active: 142, sends7d: 412, version: 4 },
      { slug: 'activation-rescue', name: 'Activation rescue', trigger: 'event: Downloaded app', goal: 'activation', enabled: true, active: 23, sends7d: 87, version: 3 },
    ])
  })

  api.get('/flows/:slug', (req, res) => {
    res.json({
      slug: req.params.slug,
      name: 'Activation rescue',
      trigger: { type: 'event', eventName: 'Downloaded app', once: true },
      enabled: true,
      version: 3,
      steps: [
        { type: 'wait', value: 1, unit: 'days' },
        { type: 'condition', test: { not: { hasFiredEvent: 'Activated app' } }, ifFalse: 'exit' },
        { type: 'send', templateSlug: 'activation-rescue-1' },
      ],
      stats: { activeRuns: 23, completedRuns: 2184, sendsTotal: 12421, sendsLast7Days: 87 },
    })
  })

  api.get('/templates', (_req, res) => {
    res.json([
      { slug: 'welcome-1', name: 'Welcome · day 0', kind: 'marketing', stats: { sent7d: 412, openRate: 0.62, clickRate: 0.18 } },
      { slug: 'receipt', name: 'Receipt', kind: 'transactional', stats: { sent7d: 1840, openRate: 0.55, clickRate: 0.04 } },
    ])
  })

  api.get('/broadcasts', (_req, res) => {
    res.json([
      { slug: 'feature-import-beta', name: 'Import beta launching', status: 'scheduled', scheduledAt: '2026-05-14T17:00:00Z', recipientCount: 4231 },
    ])
  })

  api.get('/sends', (_req, res) => {
    res.json([
      { id: 'snd_8a2f', templateSlug: 'welcome-1', emailAtSend: 'ana@arcfound.io', status: 'delivered', flowSlug: 'welcome', opens: 0, clicks: 0 },
    ])
  })

  api.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      windowStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      counters: { sent: 14318, delivered: 14235, bounced: 83, hardBounced: 44, complained: 3 },
      rates: { hardBounceRate: 0.0031, complaintRate: 0.0002, combinedBounceRate: 0.0118, failureRate: 0.0004 },
    })
  })

  // Catch-all: explicit 404 with JSON instead of falling through to the SPA shell.
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }))

  return api
}
