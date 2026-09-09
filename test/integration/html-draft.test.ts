/**
 * Regression: templates published as raw compiled HTML (body.html set,
 * body.mjml === '', body.editorJson === null — the shape written by the
 * deploy script and by `PUT /templates/:slug` on the agent API) must be
 * draftable, lintable, and publishable from the admin UI. Before this, every
 * draft-compile site only understood editorJson or mjml, so an HTML-authored
 * template could never be edited or republished from a draft.
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

const SLUG = 'html-authored-tpl'

beforeAll(async () => {
  H = await createTestMailer({ seedContacts: [] })

  const seeded: TemplateDoc = {
    slug: SLUG,
    name: 'HTML Authored',
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

function send(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<{ status: number; body: any }> {
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

function post(path: string, body: unknown) {
  return send('POST', path, body)
}

function patch(path: string, body: unknown) {
  return send('PATCH', path, body)
}

const EDITED_HTML = '<html><body><p>Edited body with a <a href="https://app.example.com/x">link</a> and enough words to satisfy the linter.</p></body></html>'

describe('HTML-authored template draft round trip', () => {
  it('saves an html draft field via PATCH .../draft', async () => {
    const res = await patch(`/admin/mailer/api/templates/${SLUG}/draft`, { html: EDITED_HTML })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const stored = await H.db.collection('mailer_templates').findOne({ slug: SLUG })
    expect(stored?.draft?.html).toBe(EDITED_HTML)
  })

  it('lints the saved draft.html with no missing_plain_text error', async () => {
    const res = await post(`/admin/mailer/api/templates/${SLUG}/lint`, {})
    expect(res.status).toBe(200)
    expect(res.body.errors).toEqual([])
  })

  it('reports html_unbalanced_tags for malformed inline html', async () => {
    const res = await post(`/admin/mailer/api/templates/${SLUG}/lint`, { html: '<div><span>broken</div>' })
    expect(res.status).toBe(200)
    const rules = [...res.body.errors, ...res.body.warnings].map((i: any) => i.rule)
    expect(rules).toContain('html_unbalanced_tags')
  })

  it('falls back to the published body when html is an empty string', async () => {
    const res = await post(`/admin/mailer/api/templates/${SLUG}/lint`, { html: '' })
    expect(res.status).toBe(200)
    const rules = [...res.body.errors, ...res.body.warnings].map((i: any) => i.rule)
    expect(rules).not.toContain('html_empty')
  })

  it('publishes the html draft, replacing the stored body', async () => {
    const res = await post(`/admin/mailer/api/templates/${SLUG}/publish`, {})
    expect(res.status).toBe(200)
    expect(res.body.version).toBe(1)

    const stored = await H.db.collection('mailer_templates').findOne({ slug: SLUG })
    expect(stored?.body?.html).toBe(EDITED_HTML)
    expect(stored?.body?.mjml).toBe('')
    expect(stored?.body?.editorJson).toBeNull()
    expect(stored?.draft).toBeNull()
    expect(stored?.body?.plainText).toBeTruthy()
  })

  it('previews using a newly staged html draft', async () => {
    const newDraftHtml = '<html><body><p>Preview me, this text is unique to the preview draft.</p></body></html>'
    const patchRes = await patch(`/admin/mailer/api/templates/${SLUG}/draft`, { html: newDraftHtml })
    expect(patchRes.status).toBe(200)

    const res = await post(`/admin/mailer/api/templates/${SLUG}/preview`, { useDraft: true })
    expect(res.status).toBe(200)
    expect(res.body.html).toContain('Preview me, this text is unique to the preview draft.')
  })

  it('refuses to publish a draft with no body source at all', async () => {
    await H.db.collection('mailer_templates').updateOne(
      { slug: SLUG },
      { $set: { draft: { subject: 'x', preheader: '', mjml: '', editorJson: null, notes: '', lastModifiedBy: 'test', lastModifiedAt: new Date() } } },
    )
    const res = await post(`/admin/mailer/api/templates/${SLUG}/publish`, {})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('empty_draft')
  })

  // The preview must render what the editor currently holds, not what was last
  // saved — and must not write a draft to do it.
  it('previews inline html without touching the stored draft', async () => {
    const before = await H.db.collection('mailer_templates').findOne({ slug: SLUG })

    const res = await post(`/admin/mailer/api/templates/${SLUG}/preview`, {
      useDraft: true,
      html: '<html><body><p>INLINE ONLY, never saved anywhere.</p></body></html>',
    })
    expect(res.status).toBe(200)
    expect(res.body.html).toContain('INLINE ONLY')

    const after = await H.db.collection('mailer_templates').findOne({ slug: SLUG })
    expect(after?.draft).toEqual(before?.draft)
    expect(after?.body.html).toBe(before?.body.html)
  })

  it('falls back to the stored draft when no inline body is supplied', async () => {
    await post(`/admin/mailer/api/templates/${SLUG}/preview`, { useDraft: true })
    const res = await post(`/admin/mailer/api/templates/${SLUG}/preview`, { useDraft: true })
    expect(res.status).toBe(200)
    expect(res.body.html.length).toBeGreaterThan(0)
  })

  it('returns 422 rather than 500 when an inline source will not compile', async () => {
    const res = await post(`/admin/mailer/api/templates/${SLUG}/preview`, {
      useDraft: true,
      mjml: '<mjml><mj-body><mj-column>',
    })
    expect([200, 422]).toContain(res.status)
    if (res.status === 422) expect(res.body.error).toBe('compile_failed')
  })
})
