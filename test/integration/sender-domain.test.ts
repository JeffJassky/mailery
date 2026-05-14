/**
 * sender-domain enforcement, end-to-end through the admin REST router.
 *
 * Covers: create rejects bad domain, draft-patch rejects bad domain, publish
 * rejects a template whose fromEmail no longer matches the registry, and the
 * happy path through to publish.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
      senderDomains: {
        'news.example.com': { kind: 'marketing' },
        'mail.example.com': { kind: 'transactional' },
      },
      fromDefaults: { name: 'Test', email: 'hello@news.example.com' },
      transactionalFromDefaults: { name: 'Test', email: 'noreply@mail.example.com' },
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

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request(`${baseUrl}${path}`, {
      method: 'POST',
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

async function patch(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request(`${baseUrl}${path}`, {
      method: 'PATCH',
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

describe('senderDomains enforcement', () => {
  it('rejects template create with wrong-kind domain', async () => {
    const res = await post('/admin/mailer/api/templates', {
      slug: 'bad-create',
      name: 'Bad',
      kind: 'transactional',
      fromEmail: 'hi@news.example.com',          // marketing-only domain
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('sender_domain_invalid')
    expect(res.body.code).toBe('wrong_kind')
  })

  it('rejects template create with unregistered domain', async () => {
    const res = await post('/admin/mailer/api/templates', {
      slug: 'bad-create-2',
      name: 'Bad',
      kind: 'marketing',
      fromEmail: 'hi@random.com',
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('unregistered_domain')
  })

  it('allows template create with matching domain', async () => {
    const res = await post('/admin/mailer/api/templates', {
      slug: 'good-marketing',
      name: 'Marketing Welcome',
      kind: 'marketing',
      fromEmail: 'hello@news.example.com',
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('rejects draft-patch that flips fromEmail to wrong domain', async () => {
    const res = await patch('/admin/mailer/api/templates/good-marketing/draft', {
      fromEmail: 'hi@mail.example.com',          // transactional, but this is a marketing template
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('wrong_kind')
  })

  it('rejects draft-patch that flips kind so existing fromEmail is invalid', async () => {
    const res = await patch('/admin/mailer/api/templates/good-marketing/draft', {
      kind: 'transactional',                      // existing fromEmail is on a marketing domain
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('wrong_kind')
  })

  it('publish endpoint short-circuits with 400 sender_domain_invalid before the lint gate', async () => {
    // Create a marketing template with a valid registry domain, then
    // PATCH the fromEmail to an invalid one and stage a publish. The
    // publish endpoint must return 400 sender_domain_invalid (not 422
    // lint_failed) so external callers can rely on the prior contract.
    await post('/admin/mailer/api/templates', {
      slug: 'short-circuit',
      name: 'Short circuit',
      kind: 'marketing',
      fromEmail: 'hello@news.example.com',
    })
    // Bypass kind-check on patch by setting both — registry still rejects.
    await H.mailer.collections.templates.updateOne(
      { slug: 'short-circuit' },
      { $set: { fromEmail: 'hello@unregistered.example.com' } },
    )
    await patch('/admin/mailer/api/templates/short-circuit/draft', {
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi — welcome.</mj-text><mj-text><a href="{{unsubscribeUrl}}">u</a></mj-text></mj-column></mj-section></mj-body></mjml>',
    })
    const res = await post('/admin/mailer/api/templates/short-circuit/publish', {})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('sender_domain_invalid')
  })

  it('publishes a valid template', async () => {
    // Add MJML with enough body text and an unsubscribe link so the content
    // linter passes (marketing templates require {{unsubscribeUrl}}).
    const draftRes = await patch('/admin/mailer/api/templates/good-marketing/draft', {
      subject: 'Welcome to our newsletter',
      preheader: 'Glad to have you',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Welcome — here is what to expect from our weekly newsletter.</mj-text><mj-text><a href="{{unsubscribeUrl}}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
    })
    expect(draftRes.status).toBe(200)
    const pubRes = await post('/admin/mailer/api/templates/good-marketing/publish', {})
    expect(pubRes.status).toBe(200)
    expect(pubRes.body.version).toBe(1)
    expect(pubRes.body.lint?.errors ?? []).toEqual([])
  })
})
