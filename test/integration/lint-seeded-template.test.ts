/**
 * Regression: script-seeded templates (body.html + body.plainText inserted
 * directly, no editorJson / mjml draft source) must lint against the stored
 * body — not report missing_plain_text for content that demonstrably exists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAdminRouter } from '../../src/server/api/admin.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import type { TemplateDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness
let baseUrl: string
let server: any

beforeAll(async () => {
  H = await createTestMailer({ seedContacts: [] })

  const seeded: TemplateDoc = {
    slug: 'seeded-tpl',
    name: 'Seeded',
    description: '',
    kind: 'transactional',
    fromName: 'Test',
    fromEmail: 'hello@example.com',
    replyTo: null,
    providerOverride: null,
    subject: 'Your access is here',
    preheader: 'Ready when you are',
    body: {
      mjml: '',
      editorJson: null,
      html: '<html><body><p>Hi {{contact.fields.firstName}}, your access is ready. <a href="https://app.example.com/start">Open it</a>.</p></body></html>',
      plainText: 'Hi, your access is ready: open the app to get started.',
      compiledAt: new Date(),
    },
    variablesSchema: {},
    draft: null,
    tags: [],
    trackOpens: false,
    trackClicks: false,
    stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, lastSentAt: null },
    publishedAt: new Date(),
    publishedBy: 'seed-script',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  await H.db.collection('mailer_templates').insertOne(seeded)

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

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
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

describe('lint on a script-seeded template', () => {
  it('judges the stored body when the draft has no source (editorJson null)', async () => {
    const res = await post('/admin/mailer/api/templates/seeded-tpl/lint', {
      subject: 'Your access is here',
      preheader: 'Ready when you are',
      editorJson: null,
      kind: 'transactional',
    })
    expect(res.status).toBe(200)
    const rules = [...res.body.errors, ...res.body.warnings].map((i: any) => i.rule)
    expect(rules).not.toContain('missing_plain_text')
    expect(rules).not.toContain('image_only_body')
  })
})
