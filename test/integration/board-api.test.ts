/**
 * HTTP surface of the program board (plans/16-program-board.md §8): the
 * extended program detail, simulate, lint, and the template preview's
 * `program` option — on the admin API and the agent router.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createAdminApiRouter } from '../../src/server/api/admin.js'
import { restoreClock } from '../matrix/clock.js'
import {
  activation,
  CATEGORY,
  DECLARE,
  programHarness,
  seedProgramWithTemplates,
  startClock,
  subject,
  type ProgramHarness,
} from '../programs/helpers.js'

const TOKEN = 'board-api-token-0123456789abcdef0'
let P: ProgramHarness
let baseUrl: string
let server: ReturnType<ReturnType<typeof express>['listen']>

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(P.H, activation())
  await P.H.seedTemplate({ slug: 'facts-tpl', kind: 'marketing', category: CATEGORY, subject: 'Hi {{facts.business_type}} {{action.title}}', text: 'x' })

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

function call(method: string, path: string, body?: unknown, prefix = '/admin/api') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) }
    if (prefix === '/agent') headers.authorization = `Bearer ${TOKEN}`
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

describe('GET /programs/:slug (board fields)', () => {
  it('includes the declared facts and every referenced template, sorted by slug', async () => {
    const res = await call('GET', '/programs/activation')
    expect(res.status).toBe(200)
    expect(res.body.facts).toEqual(DECLARE)
    const slugs = res.body.templates.map((t: any) => t.slug)
    expect(slugs).toEqual([...slugs].sort())
    expect(slugs).toContain('connect-shopify-1')
    expect(res.body.templates.find((t: any) => t.slug === 'connect-shopify-1')).toEqual({
      slug: 'connect-shopify-1',
      name: expect.any(String),
      subject: 'connect-shopify-1: {{action.title}} {{attempt.n}}/{{attempt.total}}',
      kind: 'marketing',
      category: CATEGORY,
      published: true,
    })
  })
})

describe('POST /programs/:slug/simulate', () => {
  it('returns a simulation (ISO dates) on both surfaces, and does not audit', async () => {
    startClock()
    const before = await P.H.mailer.collections.auditLog.countDocuments({})
    for (const prefix of ['/admin/api', '/agent']) {
      const res = await call('POST', '/programs/activation/simulate', { facts: { business_type: 'saas' } }, prefix)
      expect(res.status).toBe(200)
      expect(res.body.next).toMatchObject({ reason: 'send', actionId: 'connect-ga4', attempt: 1 })
      expect(typeof res.body.now).toBe('string')
      expect(res.body.sequence.length).toBeGreaterThan(0)
    }
    expect(await P.H.mailer.collections.auditLog.countDocuments({})).toBe(before)
  })

  it('accepts a subject and a now', async () => {
    startClock()
    const { subjectId } = await subject(P, { shopify_connected: true })
    const now = new Date(Date.now() + 3600_000).toISOString()
    const res = await call('POST', '/programs/activation/simulate', { subjectId, now })
    expect(res.status).toBe(200)
    expect(res.body.subjectId).toBe(subjectId)
    expect(res.body.now).toBe(now)
    expect(res.body.next.actionId).toBe('connect-ga4')
  })

  it.each([
    ['/programs/nope/simulate', {}, 404, 'not_found'],
    ['/programs/activation/simulate', { source: 'draft' }, 409, 'no_definition'],
    ['/programs/activation/simulate', { horizonDays: 9999 }, 400, 'validation_failed'],
    ['/programs/activation/simulate', { source: 'other' }, 400, 'validation_failed'],
    ['/programs/activation/simulate', { now: 'garbage' }, 400, 'validation_failed'],
    ['/programs/activation/simulate', { subjectId: 'x'.repeat(300) }, 400, 'validation_failed'],
  ])('%s %j → %i %s', async (path, body, status, error) => {
    const res = await call('POST', path, body)
    expect(res.status).toBe(status)
    expect(res.body.error).toBe(error)
  })
})

describe('GET /programs/:slug/lint', () => {
  it('lints the published definition when there is no draft', async () => {
    const res = await call('GET', '/programs/activation/lint')
    expect(res.status).toBe(200)
    expect(res.body.source).toBe('published')
    expect(Array.isArray(res.body.issues)).toBe(true)
    // activation(): connect-ga4, install-agent and run-playbook have no cta.
    expect(res.body.issues.filter((i: any) => i.code === 'no-cta').map((i: any) => i.actionId)).toEqual([
      'connect-ga4',
      'install-agent',
      'run-playbook',
    ])
  })

  it('defaults to the draft when one exists; reports missing templates as errors', async () => {
    const draft = activation()
    draft.actions[0]!.attempts[0]!.deliveries[0]!.templateSlug = 'missing-one'
    expect((await call('PATCH', '/programs/activation', draft)).status).toBe(200)
    try {
      const res = await call('GET', '/programs/activation/lint', undefined, '/agent')
      expect(res.body.source).toBe('draft')
      expect(res.body.issues[0]).toMatchObject({ severity: 'error', code: 'invalid', actionId: 'connect-shopify', attempt: 1 })
      const pub = await call('GET', '/programs/activation/lint?source=published')
      expect(pub.body.source).toBe('published')
      expect(pub.body.issues.some((i: any) => i.severity === 'error')).toBe(false)
    } finally {
      await P.H.mailer.collections.programs.updateOne({ slug: 'activation' }, { $set: { draft: null } })
    }
  })

  it.each([
    ['/programs/nope/lint', 404, 'not_found'],
    ['/programs/activation/lint?source=draft', 409, 'no_definition'],
    ['/programs/activation/lint?source=bogus', 400, 'validation_failed'],
  ])('%s → %i %s', async (path, status, error) => {
    const res = await call('GET', path)
    expect(res.status).toBe(status)
    expect(res.body.error).toBe(error)
  })
})

describe('POST /templates/:slug/preview with `program`', () => {
  it('renders action and attempt vars', async () => {
    const res = await call('POST', '/templates/connect-ga4-2/preview', {
      useDraft: false,
      program: { slug: 'activation', actionId: 'connect-ga4', attempt: 2 },
    })
    expect(res.status).toBe(200)
    expect(res.body.subject).toBe('connect-ga4-2: Connect GA4 2/2')
  })

  it('renders given facts, or the subject\'s resolved facts', async () => {
    const given = await call('POST', '/templates/facts-tpl/preview', {
      useDraft: false,
      program: { slug: 'activation', actionId: 'connect-ga4', attempt: 1, facts: { business_type: 'saas' } },
    })
    expect(given.body.subject).toBe('Hi saas Connect GA4')
    const { subjectId } = await subject(P, { business_type: 'agency' })
    const resolved = await call('POST', '/templates/facts-tpl/preview', {
      useDraft: false,
      program: { slug: 'activation', actionId: 'connect-ga4', attempt: 1, subjectId },
    })
    expect(resolved.body.subject).toBe('Hi agency Connect GA4')
  })

  it('uses the draft definition when source is draft', async () => {
    const draft = activation()
    draft.actions.find((a) => a.id === 'connect-ga4')!.title = 'Hook up GA4'
    await call('PATCH', '/programs/activation', draft)
    try {
      const res = await call('POST', '/templates/connect-ga4-1/preview', {
        useDraft: false,
        program: { slug: 'activation', source: 'draft', actionId: 'connect-ga4', attempt: 1 },
      })
      expect(res.body.subject).toBe('connect-ga4-1: Hook up GA4 1/2')
    } finally {
      await P.H.mailer.collections.programs.updateOne({ slug: 'activation' }, { $set: { draft: null } })
    }
  })

  it('404s for an unknown program; 400 for a malformed program option', async () => {
    const unknown = await call('POST', '/templates/connect-ga4-1/preview', { useDraft: false, program: { slug: 'nope', actionId: 'a', attempt: 1 } })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('program_not_found')
    const bad = await call('POST', '/templates/connect-ga4-1/preview', { useDraft: false, program: { slug: 'activation', attempt: 0 } })
    expect(bad.status).toBe(400)
  })
})

describe('agent discovery', () => {
  it('lists simulate and lint', async () => {
    const d = await call('GET', '/', undefined, '/agent')
    const paths = d.body.endpoints.map((e: any) => e.path)
    expect(paths.some((p: string) => p.startsWith('/programs/:slug/simulate'))).toBe(true)
    expect(paths.some((p: string) => p.startsWith('/programs/:slug/lint'))).toBe(true)
  })
})
