/**
 * HTTP tests for the agent router's broadcast surface — the routes a session
 * drives to run a staged broadcast (a newsletter ladder: test contacts, seed
 * inboxes, then capped waves) without the admin SPA.
 *
 * The admin API is mounted under `/api` of the same router, so the admin
 * broadcast routes (which share api/broadcast-ops.ts) are exercised here too:
 * their response shapes are the admin SPA's contract and must not move.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { runTick } from '../../src/server/runner/index.js'

const TOKEN = 'agent-test-token-0123456789abcdef'

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<ReturnType<typeof express>['listen']>

beforeAll(async () => {
  H = await createTestMailer({
    config: { senderDomains: { 'example.com': { kind: 'both' } } },
  })
  await H.seedContact({ externalId: 't1', email: 'qa+one@test.example', tags: ['beta'], fields: { firstName: 'Quinn' } })
  await H.seedContact({ externalId: 't2', email: 'qa+two@test.example', tags: ['beta'], fields: { firstName: 'Tess' } })
  await H.seedContact({ externalId: 'r1', email: 'real@example.com', tags: [], fields: { firstName: 'Rae' } })

  await H.seedTemplate({
    slug: 'news',
    kind: 'marketing',
    fromEmail: 'hello@example.com',
    subject: 'News for {{contact.fields.firstName}}',
    html:
      '<p>Hi {{contact.fields.firstName}}, here is a paragraph long enough to count as real body copy for the checks.</p>' +
      '<a href="https://example.com/news">Read</a> <a href="{{unsubscribeUrl}}">Unsubscribe</a><p>{{senderAddress}}</p>',
  })

  const app = express()
  app.use(
    '/agent',
    createAgentRouter(H.mailer, {
      tokens: [{ token: TOKEN, actor: 'agent:test' }],
      testContacts: /@test\.example$/i,
    }),
  )
  server = app.listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  server?.close()
  if (H) await H.stop()
})

beforeEach(async () => {
  await H.ctx.collections.broadcasts.deleteMany({})
  await H.ctx.collections.sends.deleteMany({})
})

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(data)),
      authorization: `Bearer ${TOKEN}`,
    }
    const req = request(`${baseUrl}/agent${path}`, { method, headers }, (res) => {
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

const SUBSCRIBED = { kind: 'subscriptionStatus', equals: 'subscribed' }

describe('agent broadcasts: create / patch / list / get', () => {
  it('creates a draft with the default segment, audits it, and refuses a taken slug', async () => {
    const res = await call('POST', '/broadcasts', { slug: 'june', name: 'June', templateSlug: 'news' })
    expect(res.status).toBe(201)
    expect(res.body.broadcast).toMatchObject({
      slug: 'june',
      status: 'draft',
      templateSlug: 'news',
      segmentDefinition: { filters: [SUBSCRIBED] },
      createdBy: 'agent:test',
    })
    const audit = await H.ctx.collections.auditLog.findOne({ action: 'broadcast.create', 'resource.slug': 'june' })
    expect(audit?.actor).toBe('agent:test')

    const again = await call('POST', '/broadcasts', { slug: 'june', name: 'June', templateSlug: 'news' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('slug_taken')
  })

  it('validates the body', async () => {
    const res = await call('POST', '/broadcasts', { slug: 'Not A Slug', name: '', templateSlug: 'news' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('validation_failed')
    expect(res.body.message).toMatch(/slug/)
  })

  it('patches a draft, and only a draft', async () => {
    await call('POST', '/broadcasts', { slug: 'june', name: 'June', templateSlug: 'news' })
    const patched = await call('PATCH', '/broadcasts/june', { name: 'June issue', respectRecipientTimezone: true })
    expect(patched.status).toBe(200)
    expect(patched.body.broadcast).toMatchObject({ name: 'June issue', respectRecipientTimezone: true })

    await call('POST', '/broadcasts/june/schedule', { scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), confirmedCount: 3 })
    const late = await call('PATCH', '/broadcasts/june', { name: 'too late' })
    expect(late.status).toBe(409)
    expect(late.body.error).toBe('not_draft')
  })

  it('lists broadcasts with stats and 404s an unknown slug', async () => {
    await call('POST', '/broadcasts', { slug: 'june', name: 'June', templateSlug: 'news' })
    const list = await call('GET', '/broadcasts')
    expect(list.status).toBe(200)
    expect(list.body.map((b: any) => b.slug)).toEqual(['june'])
    expect(list.body[0].stats).toMatchObject({ delivered: 0, opened: 0 })

    const missing = await call('GET', '/broadcasts/nope')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('not_found')
  })
})

describe('agent broadcasts: schedule / dispatch / cancel', () => {
  it('schedules a draft, dispatches it on the tick, and reports sends by status', async () => {
    await call('POST', '/broadcasts', { slug: 'june', name: 'June', templateSlug: 'news' })
    const noCount = await call('POST', '/broadcasts/june/schedule', { scheduledAt: new Date().toISOString() })
    expect(noCount.status).toBe(400)

    const sched = await call('POST', '/broadcasts/june/schedule', {
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      confirmedCount: 3,
    })
    expect(sched.status).toBe(200)
    expect(sched.body.broadcast).toMatchObject({ status: 'scheduled', confirmedCount: 3, confirmedBy: 'agent:test' })

    await runTick(H.ctx)
    const got = await call('GET', '/broadcasts/june')
    expect(got.status).toBe(200)
    expect(got.body.broadcast.status).toBe('sent')
    expect(got.body.broadcast.recipientCount).toBe(3)
    expect(got.body.statusBreakdown).toEqual({ queued: 3 })

    const sends = await H.ctx.collections.sends.find({ broadcastId: { $ne: null } }).toArray()
    expect(sends.map((s) => s.externalId).sort()).toEqual(['r1', 't1', 't2'])
    expect(sends.every((s) => s.dedupeKey === `broadcast:${got.body.broadcast.id}:${s.externalId}`)).toBe(true)
  })

  it('cancels a scheduled broadcast so the tick never dispatches it', async () => {
    await call('POST', '/broadcasts', { slug: 'june', name: 'June', templateSlug: 'news' })
    await call('POST', '/broadcasts/june/schedule', { scheduledAt: new Date(Date.now() - 1000).toISOString(), confirmedCount: 3 })
    const res = await call('POST', '/broadcasts/june/cancel')
    expect(res.status).toBe(200)
    expect(res.body.broadcast.status).toBe('cancelled')
    await runTick(H.ctx)
    expect(await H.ctx.collections.sends.countDocuments({})).toBe(0)
  })

  it('is listed in discovery', async () => {
    const res = await call('GET', '/')
    const paths = res.body.endpoints.map((e: any) => `${e.method} ${e.path}`)
    expect(paths).toEqual(expect.arrayContaining(['GET /broadcasts', 'POST /broadcasts/:slug/schedule', 'POST /broadcasts/:slug/cancel']))
  })
})

describe('agent broadcasts: the true recipient count', () => {
  it('counts what dispatch sends: subscription, suppression, post-filters — and schedule holds it to that', async () => {
    // r1 is subscribed but suppressed; t2 is unsubscribed.
    await H.mailer.suppress('real@example.com', { scope: 'marketing', reason: 'manual', source: 'test' })
    await H.ctx.collections.subscriptions.updateOne({ externalId: 't2' }, { $set: { status: 'unsubscribed' } })
    try {
      await call('POST', '/broadcasts', { slug: 'june', name: 'June', templateSlug: 'news' })
      const count = await call('POST', '/broadcasts/june/count')
      expect(count.status).toBe(200)
      expect(count.body).toMatchObject({ hostMatched: 3, eligible: 1, alreadySent: 0, recipientCount: 1, templateKind: 'marketing' })

      const wrong = await call('POST', '/broadcasts/june/schedule', { scheduledAt: new Date(Date.now() - 1000).toISOString(), confirmedCount: 3 })
      expect(wrong.status).toBe(409)
      expect(wrong.body).toMatchObject({ error: 'count_mismatch', expected: 1, confirmedCount: 3 })
      expect((await H.ctx.collections.broadcasts.findOne({ slug: 'june' }))?.status).toBe('draft')

      const right = await call('POST', '/broadcasts/june/schedule', { scheduledAt: new Date(Date.now() - 1000).toISOString(), confirmedCount: 1 })
      expect(right.status).toBe(200)
      await runTick(H.ctx)
      const sends = await H.ctx.collections.sends.find({ broadcastId: { $ne: null } }).toArray()
      expect(sends.map((s) => s.externalId)).toEqual(['t1'])

      // After dispatch the same count reports the recipient as already sent.
      const after = await call('POST', '/broadcasts/june/count')
      expect(after.body).toMatchObject({ eligible: 1, alreadySent: 1, recipientCount: 0 })
    } finally {
      await H.ctx.collections.suppressions.deleteMany({ email: 'real@example.com' })
      await H.ctx.collections.subscriptions.updateOne({ externalId: 't2' }, { $set: { status: 'subscribed' } })
    }
  })

  it('refuses to count without the template', async () => {
    await call('POST', '/api/broadcasts', { slug: 'ghost', name: 'Ghost', templateSlug: 'no-such-template' })
    const res = await call('POST', '/broadcasts/ghost/count')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('template_not_found')
  })

  it('the admin composer count is exact now, under the key it already reads', async () => {
    await H.mailer.suppress('real@example.com', { scope: 'all', reason: 'manual', source: 'test' })
    try {
      await call('POST', '/api/broadcasts', { slug: 'adm-count', name: 'Adm', templateSlug: 'news' })
      const res = await call('POST', '/api/broadcasts/adm-count/segment/count', {
        segmentDefinition: { filters: [SUBSCRIBED, { kind: 'hasTag', tag: 'beta' }] },
      })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ upperBound: 2, approximate: false, hostMatched: 2, recipientCount: 2 })
      const all = await call('POST', '/api/broadcasts/adm-count/segment/count', { segmentDefinition: { filters: [SUBSCRIBED] } })
      expect(all.body).toMatchObject({ upperBound: 2, hostMatched: 3 })
    } finally {
      await H.ctx.collections.suppressions.deleteMany({ email: 'real@example.com' })
    }
  })
})

describe('agent broadcasts: stats', () => {
  it('reports counts, rates, a status breakdown and cap progress', async () => {
    await call('POST', '/broadcasts', { slug: 'stats', name: 'Stats', templateSlug: 'news', recipientCap: 50 })
    const b = await H.ctx.collections.broadcasts.findOne({ slug: 'stats' })
    const tpl = await H.ctx.collections.templates.findOne({ slug: 'news' })
    const now = new Date()
    const row = (i: number, patch: Record<string, unknown>) => ({
      dedupeKey: `broadcast:${b!._id}:s${i}`,
      externalId: `s${i}`,
      emailAtSend: `s${i}@example.com`,
      templateId: tpl!._id!,
      templateSlug: 'news',
      flowRunId: null,
      broadcastId: b!._id!,
      manualSendBy: null,
      kind: 'marketing' as const,
      provider: 'null',
      providerMessageId: null,
      fromName: 'T',
      fromEmail: 'hello@example.com',
      subject: 's',
      bodyHash: '',
      status: 'queued' as const,
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
      ...patch,
    })
    const delivered = { status: 'delivered', sentAt: now, deliveredAt: now }
    await H.ctx.collections.sends.insertMany([
      // 6 delivered: 3 opened (1 of them clicked), 1 complained, 1 unsubscribed
      row(1, { ...delivered, openedAt: now, firstClickAt: now }),
      row(2, { ...delivered, openedAt: now }),
      row(3, { ...delivered, openedAt: now }),
      row(4, { ...delivered, status: 'complained', complainedAt: now }),
      row(5, { ...delivered, unsubscribedAt: now }),
      row(6, delivered),
      // 2 bounced (1 hard, 1 soft), 1 still queued, 1 suppressed at send time
      row(7, { status: 'bounced', sentAt: now, bounceType: 'hard' }),
      row(8, { status: 'bounced', sentAt: now, bounceType: 'soft' }),
      row(9, {}),
      row(10, { status: 'suppressed' }),
    ] as any)
    // A test send for the same template carries no broadcastId and never counts.
    await H.ctx.collections.sends.insertOne({ ...row(11, delivered), broadcastId: null, dedupeKey: 'oneoff:test' } as any)

    const res = await call('GET', '/broadcasts/stats')
    expect(res.status).toBe(200)
    expect(res.body.stats).toMatchObject({
      total: 10,
      accepted: 8,
      delivered: 6,
      bounced: 2,
      hardBounced: 1,
      softBounced: 1,
      complained: 1,
      unsubscribed: 1,
      opened: 3,
      clicked: 1,
      outcomes: 8,
    })
    expect(res.body.stats.rates).toEqual({
      deliveryRatePct: 75,
      bounceRatePct: 25,
      hardBounceRatePct: 12.5,
      complaintRatePct: 12.5,
      unsubscribeRatePct: 12.5,
      openRatePct: 50,
      clickRatePct: 16.67,
    })
    expect(res.body.statusBreakdown).toEqual({ delivered: 5, complained: 1, bounced: 2, queued: 1, suppressed: 1 })
    expect(res.body.capProgress).toEqual({ recipientCap: 50, sendsSoFar: 10, remaining: 40 })
    expect(res.body.broadcast.pauseReason).toBeNull()

    // The admin list keeps its keys (now a superset).
    const list = await call('GET', '/api/broadcasts')
    expect(list.body.find((x: any) => x.slug === 'stats').stats).toMatchObject({ delivered: 6, opened: 3, clicked: 1, bounced: 2 })
  })
})

describe('agent broadcasts: the subscribed-only guard', () => {
  it('refuses a segment without a top-level subscriptionStatus: subscribed filter', async () => {
    const bare = await call('POST', '/broadcasts', {
      slug: 'everyone',
      name: 'Everyone',
      templateSlug: 'news',
      segmentDefinition: { filters: [{ kind: 'hasTag', tag: 'beta' }] },
    })
    expect(bare.status).toBe(422)
    expect(bare.body.error).toBe('segment_requires_subscribed')

    // Nested inside `any` it restricts nothing, so it does not count.
    const nested = await call('POST', '/broadcasts', {
      slug: 'nested',
      name: 'Nested',
      templateSlug: 'news',
      segmentDefinition: { filters: [{ kind: 'any', filters: [SUBSCRIBED, { kind: 'hasTag', tag: 'beta' }] }] },
    })
    expect(nested.status).toBe(422)

    const other = await call('POST', '/broadcasts', {
      slug: 'unsubs',
      name: 'Unsubs',
      templateSlug: 'news',
      segmentDefinition: { filters: [{ kind: 'subscriptionStatus', equals: 'unsubscribed' }] },
    })
    expect(other.status).toBe(422)
    expect(await H.ctx.collections.broadcasts.countDocuments({})).toBe(0)
  })

  it('refuses a patch that drops the filter', async () => {
    await call('POST', '/broadcasts', { slug: 'june', name: 'June', templateSlug: 'news' })
    const res = await call('PATCH', '/broadcasts/june', { segmentDefinition: { filters: [{ kind: 'hasTag', tag: 'beta' }] } })
    expect(res.status).toBe(422)
    const stored = await H.ctx.collections.broadcasts.findOne({ slug: 'june' })
    expect(stored?.segmentDefinition.filters).toEqual([SUBSCRIBED])
  })

  it('refuses to schedule an admin-created draft that lacks it, while the admin path still may', async () => {
    await call('POST', '/api/broadcasts', {
      slug: 'adm-all',
      name: 'Adm',
      templateSlug: 'news',
      segmentDefinition: { filters: [{ kind: 'hasTag', tag: 'beta' }] },
    })
    const res = await call('POST', '/broadcasts/adm-all/schedule', { scheduledAt: new Date().toISOString(), confirmedCount: 2 })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('segment_requires_subscribed')
    expect((await H.ctx.collections.broadcasts.findOne({ slug: 'adm-all' }))?.status).toBe('draft')
  })
})

describe('admin broadcast routes keep their response shapes', () => {
  it('create / patch / schedule / cancel answer as before', async () => {
    const created = await call('POST', '/api/broadcasts', { slug: 'adm', name: 'Adm', templateSlug: 'news' })
    expect(created.body).toEqual({ ok: true, slug: 'adm' })
    expect((await call('POST', '/api/broadcasts', { slug: 'adm', name: 'Adm', templateSlug: 'news' })).body.error).toBe('slug_taken')
    expect((await call('POST', '/api/broadcasts', { name: 'x' })).status).toBe(400)

    expect((await call('PATCH', '/api/broadcasts/adm', { name: 'Adm 2' })).body).toEqual({ ok: true })
    expect((await call('PATCH', '/api/broadcasts/nope', { name: 'x' })).status).toBe(404)

    const noDate = await call('POST', '/api/broadcasts/adm/schedule', { confirmedCount: 3 })
    expect(noDate.status).toBe(400)
    expect(noDate.body.error).toBe('scheduledAt_required')
    expect((await call('POST', '/api/broadcasts/adm/schedule', { scheduledAt: new Date().toISOString() })).body.error).toBe(
      'confirmedCount_required',
    )
    const ok = await call('POST', '/api/broadcasts/adm/schedule', { scheduledAt: new Date(Date.now() + 60_000).toISOString(), confirmedCount: 3 })
    expect(ok.body).toEqual({ ok: true })
    expect((await call('PATCH', '/api/broadcasts/adm', { name: 'x' })).body.error).toBe('not_draft')

    expect((await call('POST', '/api/broadcasts/adm/cancel')).body).toEqual({ ok: true })
    const got = await call('GET', '/api/broadcasts/adm')
    expect(got.body.status).toBe('cancelled')
    expect(got.body.stats).toMatchObject({ delivered: 0 })
  })
})
