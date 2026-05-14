/**
 * Live-lint endpoint: returns issues for the supplied draft, falls back to
 * the saved draft when fields are missing, handles compile failures.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAdminRouter } from '../../src/server/api/admin.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<typeof express>['listen'] extends (...a: any) => infer R ? R : never

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      senderDomains: { 'news.example.com': { kind: 'marketing' } },
      fromDefaults: { name: 'Test', email: 'hello@news.example.com' },
    },
  })
  const app = express()
  app.use(express.json())
  app.use('/admin/mailer', createAdminRouter(H.mailer))
  server = app.listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  server?.close()
  if (H) await H.stop()
})

function send(method: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request(`${baseUrl}${path}`, {
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
    req.write(data)
    req.end()
  })
}
const post = (p: string, b: unknown) => send('POST', p, b)
const patch = (p: string, b: unknown) => send('PATCH', p, b)

async function createTemplate(slug: string) {
  const res = await post('/admin/mailer/api/templates', {
    slug,
    name: slug,
    kind: 'marketing',
    fromEmail: 'hello@news.example.com',
  })
  expect(res.status).toBe(200)
}

describe('POST /templates/:slug/lint', () => {
  it('flags a marketing template missing unsubscribe + plain-text', async () => {
    await createTemplate('lint-bad')
    const res = await post('/admin/mailer/api/templates/lint-bad/lint', {
      subject: 'Welcome',
      preheader: 'Glad to have you',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
    })
    expect(res.status).toBe(200)
    expect(res.body.errors.some((e: any) => e.rule === 'missing_unsubscribe_tag')).toBe(true)
    expect(res.body.compileFailed).toBe(false)
  })

  it('returns clean lint for a well-formed draft', async () => {
    await createTemplate('lint-good')
    const res = await post('/admin/mailer/api/templates/lint-good/lint', {
      subject: 'Welcome to our newsletter',
      preheader: 'Glad to have you',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Welcome — here is what to expect.</mj-text><mj-text><a href="{{unsubscribeUrl}}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
    })
    expect(res.status).toBe(200)
    expect(res.body.errors).toEqual([])
  })

  it('reports compile failure inline rather than HTTP error', async () => {
    await createTemplate('lint-compile')
    const res = await post('/admin/mailer/api/templates/lint-compile/lint', {
      subject: 'Hello',
      preheader: '',
      mjml: '<mjml><not-valid-mjml',
    })
    expect(res.status).toBe(200)
    expect(res.body.compileFailed).toBe(true)
    expect(res.body.errors[0].rule).toBe('compile_failed')
  })

  it('falls back to saved draft when fields are missing in request', async () => {
    await createTemplate('lint-saved')
    // Save a draft that has issues
    await patch('/admin/mailer/api/templates/lint-saved/draft', {
      subject: 'Welcome',
      preheader: '',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
    })
    const res = await post('/admin/mailer/api/templates/lint-saved/lint', {})
    expect(res.status).toBe(200)
    // Should still detect missing unsubscribe tag from the saved draft.
    expect(res.body.errors.some((e: any) => e.rule === 'missing_unsubscribe_tag')).toBe(true)
  })

  it('404 when template does not exist', async () => {
    const res = await post('/admin/mailer/api/templates/nonexistent/lint', {
      subject: 'x',
      mjml: '<mjml><mj-body></mj-body></mjml>',
    })
    expect(res.status).toBe(404)
  })
})
