/**
 * Guarded provider lookup at the three non-public call sites.
 *
 * `test/unit/provider-lookup.test.ts` pins the helper itself; this file pins
 * what each *site* does when the lookup comes back empty, which is deliberately
 * not the same thing in each place:
 *
 *   POST /api/templates/:slug/mail-tester-check  → 400 naming the provider,
 *                                                  before a credit is spent
 *   POST /api/templates/:slug/send-test          → 400 naming the provider
 *   dispatchSend()                               → that one send fails with a
 *                                                  readable reason; every other
 *                                                  queued send still goes out
 *
 * Unlike the public webhook route, none of these take the provider name from a
 * request: it comes from `providerOverride` on a stored template or from
 * `send.provider` on a stored send row, both written behind the host's admin
 * gate. The failure being fixed here is a misconfiguration (stale, renamed or
 * mistyped name) surfacing as a 500 or an `undefined is not a function`, not an
 * attacker-reachable one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ObjectId } from 'mongodb'

import { createAdminRouter } from '../../src/server/api/admin.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import type { MailTesterClient, MailTesterResult } from '../../src/server/runner/mail-tester.js'
import type { SendDoc, TemplateDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<express.Express['listen']>

const stub = {
  provisionCalls: 0,
  result: { ready: true, score: 9.2, feedback: [], rawSummary: null } as MailTesterResult,
}
const mailTesterClient: MailTesterClient = {
  async provisionCheck() {
    stub.provisionCalls++
    return { checkId: `chk-${stub.provisionCalls}`, emailAddress: `t-${stub.provisionCalls}@mail-tester.com` }
  },
  async fetchResult() {
    return stub.result
  },
}

/**
 * Names that must not resolve. Three flavours, because they fail three
 * different ways under a bare `providers[name]`:
 *   - `postmark`      — simply absent; the honest "unknown name" case.
 *   - prototype keys  — truthy non-providers inherited from Object.prototype.
 *   - `half-built`    — an *own* key whose value was never a provider, which
 *                       `Object.hasOwn` alone would happily admit.
 */
const UNRESOLVABLE: Array<[label: string, name: string]> = [
  ['an unregistered name', 'postmark'],
  ['the prototype key constructor', 'constructor'],
  ['the prototype key __proto__', '__proto__'],
  ['the prototype key toString', 'toString'],
  ['an own key that is not a provider', 'half-built'],
]

const DRAFT = {
  subject: 'Draft subject',
  preheader: 'preheader',
  mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>',
}

beforeAll(async () => {
  H = await createTestMailer({
    config: { mailTester: { apiKey: 'mt-test', minScore: 8.0, cacheHours: 24 } },
  })

  // An own key whose value never implemented MailProvider — the case a bare
  // `Object.hasOwn` gate would let through.
  ;(H.mailer.providers as any)['half-built'] = { name: 'half-built' }

  const app = express()
  app.use(express.json())
  app.use('/admin/mailer', createAdminRouter(H.mailer, { mailTesterClient }))
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  await H.seedContact({ externalId: 'u1', email: 'u1@example.com', tags: [], fields: { firstName: 'Alice' } })
}, 120_000)

afterAll(async () => {
  server?.close()
  if (H) await H.stop()
})

function http(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const req = request(
      `${baseUrl}${path}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) },
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
const post = (p: string, b?: unknown) => http('POST', p, b)

/** A published template pinned to `providerOverride`, with a saved draft. */
async function seedTemplate(slug: string, providerOverride: string | null): Promise<TemplateDoc> {
  const tpl = await H.seedTemplate({ slug, providerOverride, text: 'Hello {{contact.fields.firstName}}' })
  await H.mailer.collections.templates.updateOne({ _id: tpl._id }, { $set: { draft: DRAFT as any } })
  return tpl
}

// ---------------------------------------------------------------------------
// Admin: POST /api/templates/:slug/mail-tester-check
// ---------------------------------------------------------------------------

describe('POST /mail-tester-check — unresolvable provider', () => {
  it.each(UNRESOLVABLE)('400s on %s', async (label, name) => {
    const slug = `mt-${name.replace(/\W/g, '')}`
    await seedTemplate(slug, name)
    const before = stub.provisionCalls

    const res = await post(`/admin/mailer/api/templates/${slug}/mail-tester-check`)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('provider_unknown')
    expect(res.body.provider).toBe(name)
    // Actionable: says which name failed, where it came from, and what exists.
    expect(res.body.message).toContain(name)
    expect(res.body.message).toContain(slug)
    expect(res.body.registeredProviders).toEqual(['null'])
    expect(res.body.message).toContain('null')
    // Resolution happens before provisioning, so a misconfigured template
    // never burns a Mail-Tester credit.
    expect(stub.provisionCalls).toBe(before)
  })

  it('still runs the check for a registered provider', async () => {
    await seedTemplate('mt-ok', null)
    const before = stub.provisionCalls
    const res = await post('/admin/mailer/api/templates/mt-ok/mail-tester-check')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('pending')
    expect(stub.provisionCalls).toBe(before + 1)
  })
})

// ---------------------------------------------------------------------------
// Admin: POST /api/templates/:slug/send-test
// ---------------------------------------------------------------------------

describe('POST /send-test — unresolvable provider', () => {
  it.each(UNRESOLVABLE)('400s on %s', async (label, name) => {
    const slug = `st-${name.replace(/\W/g, '')}`
    await seedTemplate(slug, name)
    const sentBefore = H.provider.sent.length

    const res = await post(`/admin/mailer/api/templates/${slug}/send-test`, { to: 'qa@example.com' })

    // Not a 500: the server is healthy, the stored template is what's wrong.
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('provider_unknown')
    expect(res.body.provider).toBe(name)
    expect(res.body.message).toContain(name)
    expect(res.body.registeredProviders).toEqual(['null'])
    expect(H.provider.sent.length).toBe(sentBefore)
  })

  it('names the configured default when the template has no override', async () => {
    await seedTemplate('st-default', null)
    const original = H.mailer.config.defaultProvider
    ;(H.mailer.config as any).defaultProvider = 'gone-away'
    try {
      const res = await post('/admin/mailer/api/templates/st-default/send-test', { to: 'qa@example.com' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('provider_unknown')
      expect(res.body.provider).toBe('gone-away')
      expect(res.body.message).toContain('defaultProvider')
    } finally {
      ;(H.mailer.config as any).defaultProvider = original
    }
  })

  it('still sends for a registered provider', async () => {
    await seedTemplate('st-ok', null)
    const res = await post('/admin/mailer/api/templates/st-ok/send-test', { to: 'qa@example.com' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(H.provider.sent.at(-1)?.to).toBe('qa@example.com')
  })
})

// ---------------------------------------------------------------------------
// Runner: dispatchSend
// ---------------------------------------------------------------------------

function queuedSend(templateId: ObjectId, provider: string): SendDoc {
  const now = new Date()
  return {
    _id: new ObjectId(),
    dedupeKey: `provider-res:${provider}:${now.getTime()}:${Math.random()}`,
    externalId: 'u1',
    emailAtSend: 'u1@example.com',
    templateId,
    templateSlug: 'runner-tpl',
    flowRunId: null,
    broadcastId: null,
    manualSendBy: 'test',
    kind: 'marketing',
    provider,
    providerMessageId: null,
    fromName: 'Test',
    fromEmail: 'hello@example.com',
    subject: 'hi',
    bodyHash: '',
    status: 'queued',
    errorMessage: null,
    bounceType: null,
    bounceReason: null,
    links: [],
    vars: {},
    openedAt: null,
    openCount: 0,
    firstClickAt: null,
    clickCount: 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt: now,
    updatedAt: now,
    sentAt: null,
    deliveredAt: null,
  } as SendDoc
}

describe('dispatchSend — unresolvable send.provider', () => {
  it('fails only the affected sends and keeps dispatching the rest', async () => {
    const tpl = await seedTemplate('runner-tpl', null)
    await H.mailer.collections.sends.deleteMany({})

    const bad = UNRESOLVABLE.map(([, name]) => queuedSend(tpl._id!, name))
    const good = [queuedSend(tpl._id!, 'null'), queuedSend(tpl._id!, 'null')]
    // Interleaved so a bad row can't simply be "the last one tried".
    const rows = [bad[0]!, good[0]!, bad[1]!, bad[2]!, good[1]!, bad[3]!, bad[4]!]
    await H.mailer.collections.sends.insertMany(rows as any[])

    const sentBefore = H.provider.sent.length
    const result = await H.drain()

    // A misconfigured provider name is not a transient fault, so dispatchSend
    // records and returns rather than throwing: no retry budget is burned and
    // nothing propagates out of the dispatch loop.
    expect(result.errors).toEqual([])
    expect(result.settled).toBe(true)

    for (const row of bad) {
      const doc = await H.mailer.collections.sends.findOne({ _id: row._id })
      expect(doc?.status).toBe('failed')
      expect(doc?.errorMessage).toContain('provider_unknown')
      // Human-readable: the offending name plus what is actually registered.
      expect(doc?.errorMessage).toContain(`"${row.provider}"`)
      expect(doc?.errorMessage).toContain('Registered providers: null')
      expect(doc?.providerMessageId ?? null).toBeNull()
    }

    for (const row of good) {
      const doc = await H.mailer.collections.sends.findOne({ _id: row._id })
      expect(doc?.status).toBe('sent')
    }

    // The two healthy sends reached the provider; none of the bad ones did.
    expect(H.provider.sent.length).toBe(sentBefore + good.length)
  }, 120_000)

  it('does not silently substitute the default provider', async () => {
    const tpl = await H.mailer.collections.templates.findOne({ slug: 'runner-tpl' })
    await H.mailer.collections.sends.deleteMany({})

    const row = queuedSend(tpl!._id!, 'sendgird') // a plausible typo
    await H.mailer.collections.sends.insertOne(row as any)

    const sentBefore = H.provider.sent.length
    await H.drain()

    const doc = await H.mailer.collections.sends.findOne({ _id: row._id })
    expect(doc?.status).toBe('failed')
    expect(doc?.errorMessage).toContain('sendgird')
    // Routing it through `defaultProvider` instead would have sent the mail
    // from the wrong reputation and hidden the typo forever.
    expect(H.provider.sent.length).toBe(sentBefore)
  }, 120_000)
})
