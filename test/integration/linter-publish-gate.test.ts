/**
 * The template publish endpoint runs the content linter and refuses with
 * 422 when there are errors. Warnings/infos pass through but do not block.
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
    seedContacts: [],
    config: {
      senderDomains: { 'news.example.com': { kind: 'marketing' } },
      fromDefaults: { name: 'Test', email: 'hello@news.example.com' },
    },
  })

  const app = express()
  app.use(express.json())
  app.use('/admin/mailer', createAdminRouter(H.mailer))
  server = app.listen(0)
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
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

async function createTemplate(slug: string, kind: 'marketing' | 'transactional' = 'marketing') {
  const res = await post('/admin/mailer/api/templates', {
    slug,
    name: slug,
    kind,
    fromEmail: 'hello@news.example.com',
  })
  expect(res.status).toBe(200)
}

describe('template publish — linter gate', () => {
  it('refuses publish with 422 when marketing template lacks unsubscribe', async () => {
    await createTemplate('no-unsub')
    await patch('/admin/mailer/api/templates/no-unsub/draft', {
      subject: 'Welcome',
      preheader: 'Glad to have you',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hello, welcome aboard, here is your getting-started guide.</mj-text></mj-column></mj-section></mj-body></mjml>',
    })
    const res = await post('/admin/mailer/api/templates/no-unsub/publish', {})
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('lint_failed')
    expect(res.body.lint.errors.some((e: any) => e.rule === 'missing_unsubscribe_tag')).toBe(true)
  })

  it('refuses publish with 422 when body uses a URL shortener', async () => {
    await createTemplate('shortener')
    await patch('/admin/mailer/api/templates/shortener/draft', {
      subject: 'Update',
      preheader: 'Read more',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hello there — full update here: <a href="https://bit.ly/abc">read more</a> and <a href="{{unsubscribeUrl}}">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>',
    })
    const res = await post('/admin/mailer/api/templates/shortener/publish', {})
    expect(res.status).toBe(422)
    expect(res.body.lint.errors.some((e: any) => e.rule === 'url_shortener')).toBe(true)
  })

  it('allows publish but surfaces warnings when subject is too long', async () => {
    await createTemplate('long-subject')
    await patch('/admin/mailer/api/templates/long-subject/draft', {
      subject: 'a'.repeat(80),
      preheader: 'Glad to have you',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hello there, here is your getting-started guide for the week.</mj-text><mj-text><a href="{{unsubscribeUrl}}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
    })
    const res = await post('/admin/mailer/api/templates/long-subject/publish', {})
    expect(res.status).toBe(200)
    expect(res.body.lint.warnings.some((w: any) => w.rule === 'subject_too_long')).toBe(true)
  })

  it('rejects template create when fromEmail kind mismatches registry (sender check runs before lint)', async () => {
    const res = await post('/admin/mailer/api/templates', {
      slug: 'clean-txn',
      name: 'Clean transactional',
      kind: 'transactional',
      fromEmail: 'support@news.example.com',
    })
    // 'news.example.com' is registered marketing-only. The sender-domain
    // check fires at template-create time, so we never reach the publish
    // gate. Asserting that the kind mismatch is caught here, not at publish.
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('wrong_kind')
  })
})
