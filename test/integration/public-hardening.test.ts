/**
 * HTTP-level hardening tests for the public router (issues #5 and #6).
 *
 * `src/server/api/public.ts` is the package's only unauthenticated surface —
 * every route here is reachable by anyone on the internet — so these go over a
 * real socket rather than calling the handlers directly.
 *
 * Covered:
 *   #5(a) prototype-chain provider names must not resolve to a "provider"
 *   #5(b) a rejecting route answers 500 instead of taking the process down
 *   #6    only http:/https: redirect targets leave the tracking endpoint
 *
 * The wrapper's own semantics (headersSent branch, no-op logger) are unit
 * tested in test/unit/public-wrap.test.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ObjectId } from 'mongodb'

import { createPublicRouter } from '../../src/server/api/public.js'
import type { RouteLogger } from '../../src/server/api/wrap.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<express.Express['listen']>

const logged: Array<{ level: 'error' | 'warn'; fields: Record<string, unknown>; msg?: string }> = []
const logger: RouteLogger = {
  error: (fields, msg) => { logged.push({ level: 'error', fields, msg }) },
  warn: (fields, msg) => { logged.push({ level: 'warn', fields, msg }) },
}

/** Rejections that escaped to the process. Must stay empty. */
const escaped: unknown[] = []
const onUnhandled = (err: unknown) => { escaped.push(err) }

const SEND_ID = new ObjectId()

/**
 * Link URLs a template variable could have smuggled into an href position.
 * `applyTracking` harvests hrefs from *rendered* HTML, so all of these are
 * reachable as stored `links[].url` values.
 */
const LINKS: Array<{ linkId: string; url: string }> = [
  { linkId: 'https', url: 'https://example.com/landing?a=1' },
  { linkId: 'http', url: 'http://example.com/landing' },
  { linkId: 'js', url: 'javascript:alert(document.domain)' },
  { linkId: 'js-upper', url: 'JavaScript:alert(1)' },
  { linkId: 'js-padded', url: '   javascript:alert(1)   ' },
  { linkId: 'js-tabbed', url: 'java\tscript:alert(1)' },
  { linkId: 'data', url: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' },
  { linkId: 'vbscript', url: 'vbscript:msgbox("x")' },
  { linkId: 'protocol-relative', url: '//evil.example.com/phish' },
  { linkId: 'file', url: 'file:///etc/passwd' },
  { linkId: 'empty', url: '' },
  { linkId: 'garbage', url: 'not a url at all' },
]

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)

  H = await createTestMailer()

  await H.mailer.collections.sends.insertOne({
    _id: SEND_ID,
    dedupeKey: `hardening:${SEND_ID.toHexString()}`,
    externalId: 'u1',
    emailAtSend: 'u1@example.com',
    templateId: new ObjectId(),
    templateSlug: 'hardening',
    flowRunId: null,
    broadcastId: null,
    manualSendBy: 'test',
    kind: 'marketing',
    provider: 'null',
    providerMessageId: null,
    fromName: 'Test',
    fromEmail: 'test@example.com',
    subject: 'hi',
    bodyHash: '',
    status: 'sent',
    errorMessage: null,
    bounceType: null,
    bounceReason: null,
    links: LINKS,
    vars: {},
    openedAt: null,
    openCount: 0,
    firstClickAt: null,
    clickCount: 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt: new Date(),
    updatedAt: new Date(),
    sentAt: new Date(),
    deliveredAt: null,
  } as any)

  const app = express()
  app.use('/m', createPublicRouter(H.mailer, { logger }))
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled)
  server?.close()
  if (H) await H.stop()
})

afterEach(() => {
  logged.length = 0
})

function send(
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const data = body ?? ''
    const hdr: Record<string, string> = { 'content-length': String(Buffer.byteLength(data)), ...headers }
    const req = request(`${baseUrl}${path}`, { method, headers: hdr }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: raw,
          location: res.headers.location as string | undefined,
        }),
      )
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const get = (p: string) => send('GET', p)
const postJson = (p: string, b: unknown) =>
  send('POST', p, JSON.stringify(b), { 'content-type': 'application/json' })

const click = (linkId: string) => get(`/m/click/${SEND_ID.toHexString()}/${linkId}`)

// ---------------------------------------------------------------------------
// #6 — redirect target scheme
// ---------------------------------------------------------------------------

describe('GET /click/:sendId/:linkId — redirect target validation', () => {
  it('still redirects to ordinary http and https targets', async () => {
    const https = await click('https')
    expect(https.status).toBe(302)
    expect(https.location).toBe('https://example.com/landing?a=1')

    const http = await click('http')
    expect(http.status).toBe(302)
    expect(http.location).toBe('http://example.com/landing')
  })

  it.each([
    ['javascript:', 'js'],
    ['JavaScript: (mixed case)', 'js-upper'],
    ['javascript: with surrounding whitespace', 'js-padded'],
    ['javascript: split by a tab', 'js-tabbed'],
    ['data:', 'data'],
    ['vbscript:', 'vbscript'],
    ['protocol-relative //host', 'protocol-relative'],
    ['file:', 'file'],
    ['an empty url', 'empty'],
    ['an unparseable url', 'garbage'],
  ])('refuses to redirect to %s', async (_label, linkId) => {
    const res = await click(linkId)
    expect(res.status).toBe(400)
    expect(res.location).toBeUndefined()
  })

  it('does not echo the rejected URL back into the response body', async () => {
    for (const linkId of ['js', 'data', 'protocol-relative']) {
      const res = await click(linkId)
      const url = LINKS.find((l) => l.linkId === linkId)!.url
      expect(res.body).not.toContain(url)
      expect(res.body.toLowerCase()).not.toContain('javascript')
      expect(res.body).not.toContain('evil.example.com')
    }
  })

  it('records the block server-side so it is detectable', async () => {
    await click('js')
    const warn = logged.find((l) => l.level === 'warn')
    expect(warn?.msg).toContain('blocked')
    expect(warn?.fields.linkId).toBe('js')
  })

  it('does not count a blocked click', async () => {
    const before = await H.mailer.collections.sends.findOne({ _id: SEND_ID })
    await click('js')
    await click('data')
    const after = await H.mailer.collections.sends.findOne({ _id: SEND_ID })
    expect(after?.clickCount ?? 0).toBe(before?.clickCount ?? 0)
  })

  it('still 404s an unknown linkId', async () => {
    const res = await click('nope')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// #5(a) — provider lookup
// ---------------------------------------------------------------------------

describe('POST /webhooks/:provider — provider lookup', () => {
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'])(
    'does not resolve the inherited prototype key %s to a provider',
    async (name) => {
      const res = await postJson(`/m/webhooks/${name}`, [{ event: 'delivered' }])
      // 404, not 401/500: the name never named a provider at all.
      expect(res.status).toBe(404)
    },
  )

  it('reaches a real registered provider (which then rejects the signature)', async () => {
    // The test harness registers the null provider, whose verifyWebhook fails
    // closed — a 401 proves the lookup resolved and verification ran.
    const res = await postJson('/m/webhooks/null', [{ event: 'delivered' }])
    expect(res.status).toBe(401)
  })

  it('404s an unknown provider name', async () => {
    const res = await postJson('/m/webhooks/postmark', [{ event: 'delivered' }])
    expect(res.status).toBe(404)
  })

  it('rejects an own key whose value is not a provider', async () => {
    ;(H.mailer.providers as any).broken = { name: 'broken' }
    try {
      const res = await postJson('/m/webhooks/broken', [{ event: 'delivered' }])
      expect(res.status).toBe(404)
    } finally {
      delete (H.mailer.providers as any).broken
    }
  })
})

// ---------------------------------------------------------------------------
// #5(b) — async error handling
// ---------------------------------------------------------------------------

describe('async failures in public routes', () => {
  it('answers 500 when a route rejects before responding', async () => {
    const original = H.mailer.collections.sends.findOne
    ;(H.mailer.collections.sends as any).findOne = async () => {
      throw new Error('mongo is down')
    }
    try {
      const res = await click('https')
      expect(res.status).toBe(500)
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' })
      const err = logged.find((l) => l.level === 'error')
      expect((err?.fields.err as Error).message).toBe('mongo is down')
    } finally {
      ;(H.mailer.collections.sends as any).findOne = original
    }
  })

  it('still serves the open pixel when the follow-up write rejects', async () => {
    const original = H.mailer.collections.sends.findOne
    ;(H.mailer.collections.sends as any).findOne = async () => {
      throw new Error('mongo is down')
    }
    try {
      const res = await get(`/m/open/${SEND_ID.toHexString()}.png`)
      // Respond-before-work: the pixel is delivered regardless (INVARIANT 8).
      expect(res.status).toBe(200)
      expect(logged.some((l) => l.level === 'error')).toBe(true)
    } finally {
      ;(H.mailer.collections.sends as any).findOne = original
    }
  })

  it('lets no rejection escape to the process', async () => {
    await new Promise((r) => setTimeout(r, 50))
    expect(escaped).toEqual([])
  })
})
