/**
 * Template category rule and category surfaces on the admin + agent APIs
 * (0.21). Driven through the agent router, which also serves the admin API
 * under /api.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

const TOKEN = 'agent-test-token-0123456789abcdef'
const C = 'lifecycle.onboarding'
const P = 'product.updates'

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<ReturnType<typeof express>['listen']>

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      senderDomains: { 'example.com': { kind: 'both' } },
      categories: [
        { id: C, label: 'Getting-started tips', description: 'Setup help' },
        { id: P, label: 'Product updates' },
      ],
    },
  })
  await H.seedContact({ externalId: 'c1', email: 'cat@test.example', tags: [], fields: {} })
  const app = express()
  app.use('/agent', createAgentRouter(H.mailer, { tokens: [{ token: TOKEN, actor: 'agent:test' }], testContacts: /@test\.example$/i }))
  server = app.listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  server?.close()
  if (H) await H.stop()
})

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const req = request(
      `${baseUrl}/agent${path}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(data)),
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }) }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }) }
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const tpl = (slug: string) => H.mailer.collections.templates.findOne({ slug })

const publishBody = (over: Record<string, unknown> = {}) => ({
  name: 'Tips',
  kind: 'marketing',
  fromName: 'Team',
  fromEmail: 'hello@example.com',
  subject: 'Tips',
  body: {
    html:
      '<p>Hello there, this is a paragraph long enough to count as real body copy for the linter.</p>' +
      '<a href="https://example.com/start">Start</a> <a href="{{unsubscribeUrl}}">Unsubscribe</a><p>{{senderAddress}}</p>',
  },
  ...over,
})

describe('GET /categories', () => {
  it('agent router lists the declared categories', async () => {
    const res = await call('GET', '/categories')
    expect(res.status).toBe(200)
    expect(res.body.map((c: any) => c.id)).toEqual([C, P])
    expect(res.body[0].label).toBe('Getting-started tips')
  })

  it('admin API lists them too', async () => {
    const res = await call('GET', '/api/categories')
    expect(res.status).toBe(200)
    expect(res.body.map((c: any) => c.id)).toEqual([C, P])
  })
})

describe('admin: create and edit', () => {
  it('creates a marketing template with a declared category', async () => {
    const res = await call('POST', '/api/templates', { slug: 'adm-ok', name: 'x', kind: 'marketing', category: C, fromEmail: 'hello@example.com' })
    expect(res.status).toBe(200)
    expect((await tpl('adm-ok'))?.category).toBe(C)
  })

  it('rejects an undeclared category with 400', async () => {
    const res = await call('POST', '/api/templates', { slug: 'adm-bad', name: 'x', kind: 'marketing', category: 'nope', fromEmail: 'hello@example.com' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/not declared/)
    expect(await tpl('adm-bad')).toBeNull()
  })

  it('rejects a category on a transactional template with 400', async () => {
    const res = await call('POST', '/api/templates', { slug: 'adm-tx', name: 'x', kind: 'transactional', category: C, fromEmail: 'hello@example.com' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/transactional/)
  })

  it('creating without a category stores none', async () => {
    await call('POST', '/api/templates', { slug: 'adm-plain', name: 'x', kind: 'marketing', fromEmail: 'hello@example.com' })
    expect('category' in ((await tpl('adm-plain')) as object)).toBe(false)
  })

  it('PATCH draft sets, changes and clears the category; rejects bad ones without writing', async () => {
    await call('POST', '/api/templates', { slug: 'adm-patch', name: 'x', kind: 'marketing', fromEmail: 'hello@example.com' })
    expect((await call('PATCH', '/api/templates/adm-patch/draft', { category: P })).status).toBe(200)
    expect((await tpl('adm-patch'))?.category).toBe(P)
    expect((await call('PATCH', '/api/templates/adm-patch/draft', { category: 'nope' })).status).toBe(400)
    expect((await tpl('adm-patch'))?.category).toBe(P)
    expect((await call('PATCH', '/api/templates/adm-patch/draft', { category: null })).status).toBe(200)
    expect((await tpl('adm-patch'))?.category ?? null).toBeNull()
  })

  it('PATCH draft refuses to turn a categorised template transactional', async () => {
    await call('POST', '/api/templates', { slug: 'adm-flip', name: 'x', kind: 'marketing', category: C, fromEmail: 'hello@example.com' })
    const res = await call('PATCH', '/api/templates/adm-flip/draft', { kind: 'transactional' })
    expect(res.status).toBe(400)
    expect((await tpl('adm-flip'))?.kind).toBe('marketing')
  })

  it('publish re-checks the stored category (a hand-edited undeclared one is refused)', async () => {
    await call('POST', '/api/templates', { slug: 'adm-pub', name: 'x', kind: 'marketing', fromEmail: 'hello@example.com' })
    await call('PATCH', '/api/templates/adm-pub/draft', {
      html: publishBody().body.html,
      subject: 'Hi',
    })
    await H.mailer.collections.templates.updateOne({ slug: 'adm-pub' }, { $set: { category: 'retired.one' } })
    const res = await call('POST', '/api/templates/adm-pub/publish', { bypassMailTester: true })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/not declared/)
  })

  it('publish accepts a category supplied with it', async () => {
    await call('POST', '/api/templates', { slug: 'adm-pub2', name: 'x', kind: 'marketing', fromEmail: 'hello@example.com' })
    await call('PATCH', '/api/templates/adm-pub2/draft', { html: publishBody().body.html, subject: 'Hi' })
    const res = await call('POST', '/api/templates/adm-pub2/publish', { bypassMailTester: true, category: C })
    expect(res.status).toBe(200)
    expect((await tpl('adm-pub2'))?.category).toBe(C)
  })

  it('lists the category on GET /templates', async () => {
    const res = await call('GET', '/api/templates')
    expect(res.body.find((t: any) => t.slug === 'adm-ok').category).toBe(C)
  })
})

describe('agent: PUT /templates/:slug', () => {
  it('publishes a categorised template', async () => {
    const res = await call('PUT', '/templates/agent-ok', publishBody({ category: C }))
    expect(res.status).toBe(201)
    expect((await tpl('agent-ok'))?.category).toBe(C)
  })

  it('rejects undeclared and transactional categories with 400', async () => {
    const bad = await call('PUT', '/templates/agent-bad', publishBody({ category: 'nope' }))
    expect(bad.status).toBe(400)
    const tx = await call('PUT', '/templates/agent-tx', publishBody({ kind: 'transactional', category: C }))
    expect(tx.status).toBe(400)
    expect(await tpl('agent-bad')).toBeNull()
    expect(await tpl('agent-tx')).toBeNull()
  })

  it('a republish without a category clears the previous one', async () => {
    await call('PUT', '/templates/agent-clear', publishBody({ category: P }))
    expect((await tpl('agent-clear'))?.category).toBe(P)
    await call('PUT', '/templates/agent-clear', publishBody())
    expect((await tpl('agent-clear'))?.category ?? null).toBeNull()
  })
})

describe('contact detail carries preference state', () => {
  it('admin and agent contact detail include preferences', async () => {
    await H.mailer.setPreferences('cat@test.example', { categories: { [P]: false } })
    const agent = await call('GET', '/contacts/c1')
    expect(agent.body.preferences).toEqual({ marketing: true, categories: { [C]: true, [P]: false } })
    const admin = await call('GET', '/api/contacts/c1')
    expect(admin.body.preferences).toEqual({ marketing: true, categories: { [C]: true, [P]: false } })
  })
})

describe('without categories configured', () => {
  it('GET /categories is empty and contact detail has no preferences', async () => {
    const plain = await createTestMailer({ config: { senderDomains: { 'example.com': { kind: 'both' } } } })
    const app = express()
    app.use('/agent', createAgentRouter(plain.mailer, { tokens: [{ token: TOKEN, actor: 'agent:test' }] }))
    const s = app.listen(0)
    const prev = baseUrl
    baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    try {
      await plain.seedContact({ externalId: 'p1', email: 'p@test.example', tags: [], fields: {} })
      expect((await call('GET', '/categories')).body).toEqual([])
      expect((await call('GET', '/contacts/p1')).body.preferences).toBeUndefined()
      expect((await call('GET', '/api/contacts/p1')).body.preferences).toBeUndefined()
    } finally {
      baseUrl = prev
      s.close()
      await plain.stop()
    }
  }, 120_000)
})
