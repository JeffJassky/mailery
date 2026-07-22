/**
 * Mail-Tester integration:
 *  - POST .../mail-tester-check provisions + sends; returns pending
 *  - GET .../mail-tester-result polls; persists when ready
 *  - publish gate blocks when cached score < minScore
 *  - bypassMailTester=true overrides
 *  - cache hit on identical content returns cached score
 *  - not_configured when apiKey is absent
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAdminRouter } from '../../src/server/api/admin.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import type { MailTesterClient, MailTesterResult } from '../../src/server/runner/mail-tester.js'

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<typeof express>['listen'] extends (...a: any) => infer R ? R : never

// Stub Mail-Tester client. Tests configure these to drive scenarios.
const stub = {
  provisionReturns: { checkId: 'chk-1', emailAddress: 'test-chk-1@mail-tester.com' },
  resultReturns: { ready: true, score: 9.2, feedback: [], rawSummary: null } as MailTesterResult,
  provisionCalls: 0,
  fetchCalls: 0,
}

const client: MailTesterClient = {
  async provisionCheck() { stub.provisionCalls++; return stub.provisionReturns },
  async fetchResult() { stub.fetchCalls++; return stub.resultReturns },
}

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      senderDomains: { 'news.example.com': { kind: 'marketing' } },
      fromDefaults: { name: 'Test', email: 'hello@news.example.com' },
      mailTester: { apiKey: 'mt-test', minScore: 8.0, cacheHours: 24 },
    },
  })
  const app = express()
  app.use(express.json())
  app.use('/admin/mailer', createAdminRouter(H.mailer, { mailTesterClient: client }))
  server = app.listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  server?.close()
  if (H) await H.stop()
})

function sendTo(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const req = request(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
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
const send = (method: string, p: string, b?: unknown) => sendTo(baseUrl, method, p, b)
const post = (p: string, b?: unknown) => send('POST', p, b)
const patch = (p: string, b: unknown) => send('PATCH', p, b)
const get = (p: string) => send('GET', p)

const DRAFT = {
  subject: 'Welcome to our newsletter',
  preheader: 'Glad to have you',
  mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Welcome — here is what to expect.</mj-text><mj-text><a href="{{unsubscribeUrl}}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
}

async function makeTemplate(slug: string) {
  await post('/admin/mailer/api/templates', {
    slug, name: slug, kind: 'marketing', fromEmail: 'hello@news.example.com',
  })
  await patch(`/admin/mailer/api/templates/${slug}/draft`, DRAFT)
}

async function resetState() {
  stub.provisionCalls = 0
  stub.fetchCalls = 0
  stub.resultReturns = { ready: true, score: 9.2, feedback: [], rawSummary: null }
  await H.mailer.collections.mailTesterScores.deleteMany({})
  await H.mailer.collections.templates.deleteMany({})
  await H.mailer.collections.templateVersions.deleteMany({})
}

describe('Mail-Tester flow', () => {
  it('provisions a check, returns pending, then ready on poll, and caches', async () => {
    await resetState()
    await makeTemplate('mt-flow')

    // Make first poll return not-ready so we exercise the pending path.
    stub.resultReturns = { ready: false, score: 0, feedback: [], rawSummary: null }
    const start = await post('/admin/mailer/api/templates/mt-flow/mail-tester-check')
    expect(start.status).toBe(200)
    expect(start.body.status).toBe('pending')
    expect(start.body.cached).toBe(false)
    expect(start.body.checkId).toBe('chk-1')
    expect(stub.provisionCalls).toBe(1)

    const stillPending = await get(`/admin/mailer/api/templates/mt-flow/mail-tester-result?checkId=${start.body.checkId}&contentKey=${start.body.contentKey}`)
    expect(stillPending.body.status).toBe('pending')

    // Now make Mail-Tester report ready.
    stub.resultReturns = { ready: true, score: 9.2, feedback: [{ category: 'auth', severity: 'info', message: 'SPF/DKIM aligned' }], rawSummary: 'all good' }
    const ready = await get(`/admin/mailer/api/templates/mt-flow/mail-tester-result?checkId=${start.body.checkId}&contentKey=${start.body.contentKey}`)
    expect(ready.body.status).toBe('ready')
    expect(ready.body.score.score).toBeCloseTo(9.2)

    // Cache hit on second start — no second provision.
    const cachedStart = await post('/admin/mailer/api/templates/mt-flow/mail-tester-check')
    expect(cachedStart.body.cached).toBe(true)
    expect(cachedStart.body.status).toBe('ready')
    expect(stub.provisionCalls).toBe(1) // unchanged
  })

  it('returns not_configured when apiKey absent', async () => {
    const H2 = await createTestMailer({
      config: { fromDefaults: { name: 'T', email: 'hi@news.example.com' }, senderDomains: { 'news.example.com': { kind: 'marketing' } } },
    })
    const app = express()
    app.use(express.json())
    app.use('/admin/mailer', createAdminRouter(H2.mailer))
    const srv = app.listen(0)
    const port = (srv.address() as AddressInfo).port
    try {
      // Create a draft
      await new Promise<void>((r) => {
        const data = JSON.stringify({ slug: 'mt-none', name: 'mt-none', kind: 'marketing', fromEmail: 'hi@news.example.com' })
        const req = request(`http://127.0.0.1:${port}/admin/mailer/api/templates`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { res.on('data', () => {}); res.on('end', () => r()) })
        req.write(data); req.end()
      })
      const res = await new Promise<{ status: number; body: any }>((resolve) => {
        const req = request(`http://127.0.0.1:${port}/admin/mailer/api/templates/mt-none/mail-tester-check`, { method: 'POST' }, (r) => {
          let raw = ''; r.on('data', (c) => { raw += c }); r.on('end', () => resolve({ status: r.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }))
        })
        req.end()
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('not_configured')
    } finally {
      srv.close()
      await H2.stop()
    }
  }, 60_000)
})

describe('Mail-Tester publish gate', () => {
  it('blocks publish when cached score is below minScore', async () => {
    await resetState()
    await makeTemplate('mt-low')
    stub.resultReturns = { ready: true, score: 6.5, feedback: [], rawSummary: null }
    const start = await post('/admin/mailer/api/templates/mt-low/mail-tester-check')
    await get(`/admin/mailer/api/templates/mt-low/mail-tester-result?checkId=${start.body.checkId}&contentKey=${start.body.contentKey}`)

    const pub = await post('/admin/mailer/api/templates/mt-low/publish')
    expect(pub.status).toBe(422)
    expect(pub.body.error).toBe('mail_tester_blocked')
    expect(pub.body.score.score).toBeCloseTo(6.5)
  })

  it('allows publish when bypassMailTester=true', async () => {
    await resetState()
    await makeTemplate('mt-bypass')
    stub.resultReturns = { ready: true, score: 5.0, feedback: [], rawSummary: null }
    const start = await post('/admin/mailer/api/templates/mt-bypass/mail-tester-check')
    await get(`/admin/mailer/api/templates/mt-bypass/mail-tester-result?checkId=${start.body.checkId}&contentKey=${start.body.contentKey}`)

    const pub = await post('/admin/mailer/api/templates/mt-bypass/publish', { bypassMailTester: true })
    expect(pub.status).toBe(200)
    expect(pub.body.version).toBe(1)
  })

  it('allows publish when no cached score exists (silent pass)', async () => {
    await resetState()
    await makeTemplate('mt-uncached')
    const pub = await post('/admin/mailer/api/templates/mt-uncached/publish')
    expect(pub.status).toBe(200)
  })

  it('allows publish when cached score is above minScore', async () => {
    await resetState()
    await makeTemplate('mt-good')
    stub.resultReturns = { ready: true, score: 9.5, feedback: [], rawSummary: null }
    const start = await post('/admin/mailer/api/templates/mt-good/mail-tester-check')
    await get(`/admin/mailer/api/templates/mt-good/mail-tester-result?checkId=${start.body.checkId}&contentKey=${start.body.contentKey}`)
    const pub = await post('/admin/mailer/api/templates/mt-good/publish')
    expect(pub.status).toBe(200)
  })
})

/**
 * `requireScore: true` turns the ratchet into a real gate: unchecked content
 * is refused, and because the content key covers body + subject + fromEmail,
 * editing after a check invalidates the score rather than slipping past it.
 */
describe('Mail-Tester publish gate — requireScore', () => {
  let H2: TestMailerHarness
  let srv: ReturnType<express.Express['listen']>
  let url2: string

  beforeAll(async () => {
    H2 = await createTestMailer({
      config: {
        senderDomains: { 'news.example.com': { kind: 'marketing' } },
        fromDefaults: { name: 'Test', email: 'hello@news.example.com' },
        mailTester: { apiKey: 'mt-test', minScore: 8.0, cacheHours: 24, requireScore: true },
      },
    })
    const app = express()
    app.use(express.json())
    app.use('/admin/mailer', createAdminRouter(H2.mailer, { mailTesterClient: client }))
    srv = app.listen(0)
    url2 = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  }, 60_000)

  afterAll(async () => {
    srv?.close()
    if (H2) await H2.stop()
  })

  const send2 = (method: string, path: string, body?: unknown) =>
    sendTo(url2, method, path, body)

  async function makeTemplate2(slug: string) {
    await send2('POST', '/admin/mailer/api/templates', {
      slug, name: slug, kind: 'marketing', fromEmail: 'hello@news.example.com',
    })
    await send2('PATCH', `/admin/mailer/api/templates/${slug}/draft`, DRAFT)
  }

  it('blocks publish when the content has never been checked', async () => {
    await makeTemplate2('mtr-unchecked')
    const pub = await send2('POST', '/admin/mailer/api/templates/mtr-unchecked/publish')
    expect(pub.status).toBe(422)
    expect(pub.body.error).toBe('mail_tester_blocked')
    expect(pub.body.code).toBe('no_score')
    expect(pub.body.score).toBeNull()
    expect(pub.body.hint).toContain('mail-tester-check')
  })

  it('allows publish once a passing score exists for that content', async () => {
    await makeTemplate2('mtr-checked')
    stub.resultReturns = { ready: true, score: 9.1, feedback: [], rawSummary: null }
    const start = await send2('POST', '/admin/mailer/api/templates/mtr-checked/mail-tester-check')
    await send2('GET', `/admin/mailer/api/templates/mtr-checked/mail-tester-result?checkId=${start.body.checkId}&contentKey=${start.body.contentKey}`)

    const pub = await send2('POST', '/admin/mailer/api/templates/mtr-checked/publish')
    expect(pub.status).toBe(200)
  })

  it('re-blocks after an edit invalidates the score', async () => {
    await makeTemplate2('mtr-edited')
    stub.resultReturns = { ready: true, score: 9.1, feedback: [], rawSummary: null }
    const start = await send2('POST', '/admin/mailer/api/templates/mtr-edited/mail-tester-check')
    await send2('GET', `/admin/mailer/api/templates/mtr-edited/mail-tester-result?checkId=${start.body.checkId}&contentKey=${start.body.contentKey}`)

    // Same body, different subject → different content key → cache miss.
    await send2('PATCH', '/admin/mailer/api/templates/mtr-edited/draft', { ...DRAFT, subject: 'Welcome to our newsletter!' })
    const pub = await send2('POST', '/admin/mailer/api/templates/mtr-edited/publish')
    expect(pub.status).toBe(422)
    expect(pub.body.code).toBe('no_score')
  })

  it('still honours bypassMailTester', async () => {
    await makeTemplate2('mtr-bypass')
    const pub = await send2('POST', '/admin/mailer/api/templates/mtr-bypass/publish', { bypassMailTester: true })
    expect(pub.status).toBe(200)
  })
})
