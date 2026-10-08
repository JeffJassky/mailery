/**
 * HTTP tests for the Programs routes (0.21), through both surfaces: the agent
 * router (`/agent/programs`, and the admin API it embeds at `/agent/api/...`)
 * and the admin API router on its own. Every route, the 422 publish issues,
 * stats split by arm, and the audit rows of every mutating route.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createAdminApiRouter } from '../../src/server/api/admin.js'
import { buildProgram } from '../../src/testing/index.js'
import { holdoutArm } from '../../src/server/runner/programs/index.js'
import { restoreClock } from '../matrix/clock.js'
import {
  activation,
  CATEGORY,
  dispatch,
  programHarness,
  seedProgramWithTemplates,
  startClock,
  subject,
  type ProgramHarness,
} from '../programs/helpers.js'

const TOKEN = 'programs-api-token-0123456789abcdef'
let P: ProgramHarness
let baseUrl: string
let server: ReturnType<ReturnType<typeof express>['listen']>

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(P.H, activation({ holdoutPct: 50 }))

  const app = express()
  app.use('/agent', createAgentRouter(P.H.mailer, { tokens: [{ token: TOKEN, actor: 'agent:test' }] }))
  const admin = express.Router()
  admin.use(express.json())
  admin.use((req, _res, next) => {
    ;(req as any).actor = 'human:admin@example.com'
    next()
  })
  admin.use('/api', createAdminApiRouter(P.H.mailer))
  app.use('/admin', admin)
  server = app.listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  restoreClock()
  server?.close()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

function call(method: string, path: string, body?: unknown, prefix = '/agent', token: string | null = TOKEN) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) }
    if (token && prefix === '/agent') headers.authorization = `Bearer ${token}`
    const req = request(`${baseUrl}${prefix}${path}`, { method, headers }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }) }
        catch { resolve({ status: res.statusCode ?? 0, body: raw }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const audits = (action: string) => P.H.mailer.collections.auditLog.find({ action }).toArray()

describe('auth + discovery', () => {
  it('401s without a token and lists the program routes in discovery', async () => {
    expect((await call('GET', '/programs', undefined, '/agent', null)).status).toBe(401)
    const d = await call('GET', '/')
    expect(d.body.endpoints.some((e: any) => e.path === '/programs/:slug/stats')).toBe(true)
  })
})

describe('draft, publish, enable (agent router)', () => {
  const def = () => buildProgram({ slug: 'drafty', name: 'Drafty', actions: [{ id: 'a1', title: 'A1', priority: 10, attempts: 1, satisfied: { fact: 'ga4_connected' } }] })

  it('POST /programs rejects a structurally invalid definition with 400', async () => {
    const res = await call('POST', '/programs', { slug: 'Bad Slug' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('validation_failed')
  })

  it('POST /programs saves a draft (201), audited with the token actor; again is 200', async () => {
    await P.H.seedTemplate({ slug: 'a1-1', kind: 'marketing', category: CATEGORY, subject: 'A1' })
    const d = def()
    d.actions[0]!.attempts = [{ deliveries: [{ channel: 'email', templateSlug: 'a1-1' }] }]
    const res = await call('POST', '/programs', d)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ ok: true, slug: 'drafty', version: 0, created: true })
    const again = await call('POST', '/programs', { definition: d, notes: 'second' })
    expect(again.status).toBe(200)
    const rows = await audits('program.save_draft')
    expect(rows.some((a) => a.actor === 'agent:test' && a.resource.slug === 'drafty')).toBe(true)
  })

  it('PATCH /programs/:slug replaces the draft; 404 for unknown, 400 for a slug mismatch', async () => {
    const d = def()
    d.name = 'Drafty v2'
    d.actions[0]!.attempts = [{ deliveries: [{ channel: 'email', templateSlug: 'a1-1' }] }]
    const ok = await call('PATCH', '/programs/drafty', d)
    expect(ok.status).toBe(200)
    expect((await call('GET', '/programs/drafty')).body.draft.definition.name).toBe('Drafty v2')
    expect((await call('PATCH', '/programs/nope', d)).status).toBe(404)
    expect((await call('PATCH', '/programs/drafty', { ...d, slug: 'other' })).status).toBe(400)
  })

  it('publish answers 422 with issues when validation fails, and 404 for an unknown program', async () => {
    const d = def()
    d.category = 'undeclared.category'
    d.actions[0]!.attempts = [{ deliveries: [{ channel: 'email', templateSlug: 'missing-template' }] }]
    await call('PATCH', '/programs/drafty', d)
    const res = await call('POST', '/programs/drafty/publish')
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('validation_failed')
    const paths = res.body.issues.map((i: any) => i.path)
    expect(paths).toContain('category')
    expect(res.body.issues.some((i: any) => /missing-template/.test(i.message))).toBe(true)
    expect((await call('POST', '/programs/nope/publish')).status).toBe(404)
  })

  it('enable before publish is 409; publish then enable/disable work and are audited', async () => {
    expect((await call('POST', '/programs/drafty/enable')).status).toBe(409)

    const d = def()
    d.actions[0]!.attempts = [{ deliveries: [{ channel: 'email', templateSlug: 'a1-1' }] }]
    await call('PATCH', '/programs/drafty', d)
    const pub = await call('POST', '/programs/drafty/publish')
    expect(pub.status).toBe(200)
    expect(pub.body).toEqual({ ok: true, version: 1 })

    expect((await call('POST', '/programs/drafty/enable')).body).toMatchObject({ ok: true, enabled: true })
    expect((await call('POST', '/programs/drafty/disable')).body).toMatchObject({ ok: true, enabled: false })
    for (const a of ['program.publish', 'program.enable', 'program.disable']) {
      expect((await audits(a)).some((r) => r.actor === 'agent:test' && r.resource.slug === 'drafty')).toBe(true)
    }
  })

  it('GET /programs/:slug returns published, draft and the versions list', async () => {
    const res = await call('GET', '/programs/drafty')
    expect(res.status).toBe(200)
    expect(res.body.version).toBe(1)
    expect(res.body.published.slug).toBe('drafty')
    expect(res.body.draft).toBeNull()
    expect(res.body.versions).toEqual([expect.objectContaining({ version: 1, publishedBy: 'agent:test' })])
    expect((await call('GET', '/programs/nope')).status).toBe(404)
  })

  it('GET /programs lists slug, name, version, enabled, draft flag and run counts', async () => {
    const res = await call('GET', '/programs')
    expect(res.status).toBe(200)
    const row = res.body.find((p: any) => p.slug === 'drafty')
    expect(row).toMatchObject({ name: 'Drafty', version: 1, enabled: false, draft: false })
    expect(row.runs).toMatchObject({ active: 0, completed: 0, exited: 0, sunset: 0, total: 0 })
  })
})

describe('runs, decisions, state, stats, operator actions', () => {
  const slug = 'activation'
  const arms: Record<string, string> = {}

  it('enter validates input, 404s unknown programs, creates a run (201) and is idempotent (200)', async () => {
    startClock()
    expect((await call('POST', `/programs/${slug}/enter`, {})).status).toBe(400)
    expect((await call('POST', '/programs/nope/enter', { subjectId: 'x' })).status).toBe(404)

    // Subjects until both arms are covered (assignment is a deterministic hash).
    for (let i = 0; i < 40 && new Set(Object.values(arms)).size < 2; i++) {
      const { subjectId } = await subject(P)
      arms[subjectId] = holdoutArm(slug, subjectId, 50)
    }
    expect(new Set(Object.values(arms)).size).toBe(2)
    for (const id of Object.keys(arms)) {
      const res = await call('POST', `/programs/${slug}/enter`, { subjectId: id })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ ok: true, created: true })
    }
    const first = Object.keys(arms)[0]!
    const again = await call('POST', `/programs/${slug}/enter`, { subjectId: first })
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect((await audits('program.enter')).some((a) => a.actor === 'agent:test')).toBe(true)
  })

  it('force tick 404s without a run, otherwise ticks, returns the result and audits', async () => {
    expect((await call('POST', `/programs/${slug}/runs/ghost/tick`)).status).toBe(404)
    for (const id of Object.keys(arms)) {
      const res = await call('POST', `/programs/${slug}/runs/${id}/tick`)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.result.status).toBe('ticked')
    }
    expect((await audits('program.force_tick')).filter((a) => a.actor === 'agent:test').length).toBeGreaterThanOrEqual(2)
    await dispatch(P)
  })

  it('GET runs paginates and filters by status and arm; rejects bad filters', async () => {
    const all = await call('GET', `/programs/${slug}/runs`)
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(Object.keys(arms).length)
    const page = await call('GET', `/programs/${slug}/runs?limit=1&skip=1`)
    expect(page.body.runs).toHaveLength(1)
    expect(page.body).toMatchObject({ limit: 1, skip: 1 })
    const hold = await call('GET', `/programs/${slug}/runs?arm=holdout`)
    expect(hold.body.runs.every((r: any) => r.arm === 'holdout')).toBe(true)
    expect(hold.body.total).toBe(Object.values(arms).filter((a) => a === 'holdout').length)
    expect((await call('GET', `/programs/${slug}/runs?status=completed`)).body.total).toBe(0)
    expect((await call('GET', `/programs/${slug}/runs?status=bogus`)).status).toBe(400)
    expect((await call('GET', `/programs/${slug}/runs?arm=bogus`)).status).toBe(400)
    expect((await call('GET', `/programs/${slug}/runs?limit=0`)).status).toBe(400)
  })

  it('GET run returns the run and its decisions newest first, paginated', async () => {
    const id = Object.keys(arms)[0]!
    await call('POST', `/programs/${slug}/runs/${id}/tick`) // a second decision (in-flight / min-gap)
    const res = await call('GET', `/programs/${slug}/runs/${id}`)
    expect(res.status).toBe(200)
    expect(res.body.run.subjectId).toBe(id)
    expect(res.body.total).toBeGreaterThanOrEqual(2)
    const ats = res.body.decisions.map((d: any) => Date.parse(d.at))
    expect(ats).toEqual([...ats].sort((a, b) => b - a))
    expect(res.body.decisions[0].candidates.length).toBeGreaterThan(0)
    const p = await call('GET', `/programs/${slug}/runs/${id}?limit=1`)
    expect(p.body.decisions).toHaveLength(1)
    expect((await call('GET', `/programs/${slug}/runs/ghost`)).status).toBe(404)
  })

  it('GET state needs ?subject, 404s without a run, and returns the checklist', async () => {
    const id = Object.keys(arms)[0]!
    expect((await call('GET', `/programs/${slug}/state`)).status).toBe(400)
    expect((await call('GET', `/programs/${slug}/state?subject=ghost`)).status).toBe(404)
    const res = await call('GET', `/programs/${slug}/state?subject=${id}`)
    expect(res.status).toBe(200)
    expect(res.body.map((s: any) => s.actionId)).toEqual(['connect-shopify', 'connect-ga4', 'install-agent', 'run-playbook'])
    expect(res.body.filter((s: any) => s.isNext)).toHaveLength(1)
  })

  it('GET stats splits the funnel by arm: treatment sends are real, holdout sends are simulated', async () => {
    const res = await call('GET', `/programs/${slug}/stats`)
    expect(res.status).toBe(200)
    const nT = Object.values(arms).filter((a) => a === 'treatment').length
    const nH = Object.values(arms).filter((a) => a === 'holdout').length
    expect(res.body.runs.treatment.total).toBe(nT)
    expect(res.body.runs.holdout.total).toBe(nH)
    expect(res.body.runs.treatment.completionRate).toBe(0)
    const shopify = res.body.actions.find((a: any) => a.actionId === 'connect-shopify')
    // Every subject is ecommerce, so connect-shopify wins the first tick in both arms.
    expect(shopify.treatment).toMatchObject({ chosen: nT, sent: nT })
    expect(shopify.holdout).toMatchObject({ chosen: nH, sent: nH })
    expect(shopify.treatment.evaluated).toBeGreaterThanOrEqual(nT)
    expect(shopify.holdout.evaluated).toBeGreaterThanOrEqual(nH)
    expect(shopify.treatment.satisfied).toBe(0)
    expect(shopify.title).toBe('Connect Shopify')
    expect(res.body.actions.map((a: any) => a.actionId)).toContain('run-playbook')
  })

  it('stats counts satisfied (completedAt) per arm and the completion rate', async () => {
    const id = Object.keys(arms).find((k) => arms[k] === 'treatment')!
    P.facts.set(id, { shopify_connected: true })
    await call('POST', `/programs/${slug}/runs/${id}/tick`)
    const res = await call('GET', `/programs/${slug}/stats`)
    const shopify = res.body.actions.find((a: any) => a.actionId === 'connect-shopify')
    expect(shopify.treatment.satisfied).toBe(1)
    expect(shopify.holdout.satisfied).toBe(0)
  })

  it('abort cancels the run and exits it; 404 without a run; the facade audits it', async () => {
    expect((await call('POST', `/programs/${slug}/runs/ghost/abort`)).status).toBe(404)
    const id = Object.keys(arms)[1]!
    const res = await call('POST', `/programs/${slug}/runs/${id}/abort`, { reason: 'test abort' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, aborted: true })
    const run = await call('GET', `/programs/${slug}/runs/${id}`)
    expect(run.body.run.status).not.toBe('active')
    expect((await audits('program.abort')).length).toBeGreaterThanOrEqual(1)
  })
})

describe('the same routes through the admin API and the agent-embedded admin API', () => {
  it('admin router: list, detail, runs, stats; actor is the admin session', async () => {
    const list = await call('GET', '/api/programs', undefined, '/admin')
    expect(list.status).toBe(200)
    expect(list.body.map((p: any) => p.slug)).toContain('activation')
    expect((await call('GET', '/api/programs/activation', undefined, '/admin')).body.version).toBe(1)
    expect((await call('GET', '/api/programs/activation/runs', undefined, '/admin')).body.total).toBeGreaterThan(0)
    expect((await call('GET', '/api/programs/activation/stats', undefined, '/admin')).body.runs).toBeDefined()

    const made = activation({ slug: 'admin-made', name: 'Admin made' })
    made.actions[0]!.attempts = [{ deliveries: [{ channel: 'email', templateSlug: 'no-such-template' }] }]
    const saved = await call('POST', '/api/programs', made, '/admin')
    expect(saved.status).toBe(201)
    expect((await audits('program.save_draft')).some((a) => a.actor === 'human:admin@example.com')).toBe(true)
    const pub = await call('POST', '/api/programs/admin-made/publish', undefined, '/admin')
    expect(pub.status).toBe(422) // its templates do not exist
    expect(Array.isArray(pub.body.issues)).toBe(true)
  })

  it('agent router embeds the admin API at /api/programs', async () => {
    const res = await call('GET', '/api/programs')
    expect(res.status).toBe(200)
    expect(res.body.map((p: any) => p.slug)).toContain('activation')
  })
})

