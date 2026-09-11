/**
 * Things that would have broken a first production broadcast, each fixed
 * alongside the broadcast-readiness work:
 *
 *  - cancel stopped future enqueues only; every queued send still went out
 *  - a transactional template could be broadcast (no List-Unsubscribe, no
 *    marketing opt-outs, no circuit breaker)
 *  - time-zone delays were relative to scheduledAt, so a wave dispatched days
 *    later reached every recipient at once, at whatever local hour
 *  - the open pixel overwrote 'bounced' / 'complained' with 'delivered'
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'
import { ObjectId } from 'mongodb'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createPublicRouter } from '../../src/server/api/public.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { dispatchSend, runTick } from '../../src/server/runner/index.js'
import { recipientSlotMs } from '../../src/server/runner/broadcasts.js'

const TOKEN = 'agent-test-token-0123456789abcdef'
const HOUR = 3_600_000

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<ReturnType<typeof express>['listen']>

beforeAll(async () => {
  H = await createTestMailer()
  await H.seedContact({ externalId: 'a', email: 'qa+a@test.example', tags: [], fields: {}, timezone: 'America/New_York' })
  await H.seedContact({ externalId: 'b', email: 'qa+b@test.example', tags: [], fields: {}, timezone: 'Europe/Berlin' })
  await H.seedContact({ externalId: 'c', email: 'qa+c@test.example', tags: [], fields: {} })
  await H.seedTemplate({ slug: 'news', kind: 'marketing', subject: 'News', html: '<p>News body.</p><a href="{{unsubscribeUrl}}">u</a>' })
  await H.seedTemplate({ slug: 'receipt', kind: 'transactional', subject: 'Receipt', html: '<p>Your receipt.</p>' })
  const app = express()
  app.use('/agent', createAgentRouter(H.mailer, { tokens: [{ token: TOKEN, actor: 'agent:test' }], testContacts: /@test\.example$/i }))
  app.use('/m', createPublicRouter(H.mailer))
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
  await H.ctx.collections.templates.updateOne({ slug: 'news' }, { $set: { kind: 'marketing' } })
})

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const req = request(
      `${baseUrl}${path}`,
      { method, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), authorization: `Bearer ${TOKEN}` } },
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

async function launch(slug: string, extra: Record<string, unknown> = {}, scheduledAt = new Date(Date.now() - 1000)) {
  expect((await call('POST', '/agent/broadcasts', { slug, name: slug, templateSlug: 'news', ...extra })).status).toBe(201)
  const count = await call('POST', `/agent/broadcasts/${slug}/count`)
  expect((await call('POST', `/agent/broadcasts/${slug}/schedule`, { scheduledAt: scheduledAt.toISOString(), confirmedCount: count.body.recipientCount })).status).toBe(200)
  await runTick(H.ctx)
}

describe('cancel', () => {
  it('cancels the queued sends too, and a cancelled send never reaches the provider', async () => {
    await launch('c1')
    const res = await call('POST', '/agent/broadcasts/c1/cancel')
    expect(res.status).toBe(200)
    expect(res.body.cancelledSends).toBe(3)
    const rows = await H.ctx.collections.sends.find({}).toArray()
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true)
    const before = H.provider.sent.length
    for (const r of rows) await dispatchSend(r._id!, H.ctx)
    expect(H.provider.sent.length).toBe(before)
    // Cancelling again is a no-op.
    expect((await call('POST', '/agent/broadcasts/c1/cancel')).body.cancelledSends).toBe(0)
  })

  it('a send whose job was already in flight is cancelled at dispatch', async () => {
    await launch('c2')
    const b = await H.ctx.collections.broadcasts.findOne({ slug: 'c2' })
    // Flip the broadcast without the send sweep, as a concurrent cancel would.
    await H.ctx.collections.broadcasts.updateOne({ _id: b!._id }, { $set: { status: 'cancelled' } })
    const row = await H.ctx.collections.sends.findOne({ broadcastId: b!._id })
    await dispatchSend(row!._id!, H.ctx)
    expect((await H.ctx.collections.sends.findOne({ _id: row!._id }))?.status).toBe('cancelled')
  })

  it('refuses to cancel a broadcast that has nothing left to send', async () => {
    await launch('c3')
    for (const r of await H.ctx.collections.sends.find({}).toArray()) await dispatchSend(r._id!, H.ctx)
    const res = await call('POST', '/agent/broadcasts/c3/cancel')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('already_finished')
  })
})

describe('marketing templates only', () => {
  it('refuses a transactional template at create, patch and schedule', async () => {
    const created = await call('POST', '/agent/broadcasts', { slug: 't1', name: 't1', templateSlug: 'receipt' })
    expect(created.status).toBe(409)
    expect(created.body.error).toBe('template_not_marketing')
    expect((await call('POST', '/agent/api/broadcasts', { slug: 't1', name: 't1', templateSlug: 'receipt' })).body.error).toBe('template_not_marketing')

    await call('POST', '/agent/broadcasts', { slug: 't2', name: 't2', templateSlug: 'news' })
    expect((await call('PATCH', '/agent/broadcasts/t2', { templateSlug: 'receipt' })).body.error).toBe('template_not_marketing')

    // A draft pointing at a template that does not exist yet can be saved, not scheduled.
    await call('POST', '/agent/api/broadcasts', { slug: 't3', name: 't3', templateSlug: 'later' })
    const sched = await call('POST', '/agent/api/broadcasts/t3/schedule', { scheduledAt: new Date().toISOString(), confirmedCount: 0 })
    expect(sched.status).toBe(409)
    expect(sched.body.error).toBe('template_not_found')
  })

  it('fails a dispatch whose template turned transactional after scheduling, with the reason', async () => {
    await call('POST', '/agent/broadcasts', { slug: 't4', name: 't4', templateSlug: 'news' })
    await call('POST', '/agent/broadcasts/t4/schedule', { scheduledAt: new Date(Date.now() - 1000).toISOString(), confirmedCount: 3 })
    await H.ctx.collections.templates.updateOne({ slug: 'news' }, { $set: { kind: 'transactional' } })
    await runTick(H.ctx)
    const got = await call('GET', '/agent/broadcasts/t4')
    expect(got.body.broadcast).toMatchObject({ status: 'failed', failureReason: 'template "news" is transactional, not marketing' })
    expect(got.body.stats.total).toBe(0)
  })
})

describe('recipient time zones', () => {
  const at = (iso: string) => Date.parse(iso)

  it('lands at the scheduled wall-clock time in the recipient\'s zone', () => {
    const scheduled = at('2026-09-17T10:00:00Z')
    expect(recipientSlotMs(scheduled, 'America/New_York', scheduled)).toBe(at('2026-09-17T14:00:00Z'))
    // East of UTC the slot has passed: the next one, tomorrow.
    expect(recipientSlotMs(scheduled, 'Europe/Berlin', scheduled)).toBe(at('2026-09-18T08:00:00Z'))
    // Tick lag inside the grace window still sends now.
    expect(recipientSlotMs(scheduled, 'UTC', scheduled + 60_000)).toBe(scheduled)
  })

  it('a wave dispatched days later goes at each recipient\'s next slot, not all at once', () => {
    const scheduled = at('2026-09-17T10:00:00Z')
    // Resumed Monday 15:00Z = 11:00 in New York: their next 10:00 is Tuesday.
    expect(recipientSlotMs(scheduled, 'America/New_York', at('2026-09-21T15:00:00Z'))).toBe(at('2026-09-22T14:00:00Z'))
    // Resumed at 09:50 New York: 10 minutes from now.
    expect(recipientSlotMs(scheduled, 'America/New_York', at('2026-09-21T13:50:00Z'))).toBe(at('2026-09-21T14:00:00Z'))
  })

  it('keeps the local time across a DST change', () => {
    // Scheduled while New York is on EDT (UTC-4), dispatched after it moved to EST (UTC-5).
    const scheduled = at('2026-10-30T10:00:00Z')
    expect(recipientSlotMs(scheduled, 'America/New_York', at('2026-11-03T12:00:00Z'))).toBe(at('2026-11-03T15:00:00Z'))
  })

  it('dispatch stamps each send with its slot; a contact without a zone goes now', async () => {
    const scheduled = new Date(Date.now() - 3 * 24 * HOUR)
    await launch('tz', { respectRecipientTimezone: true }, scheduled)
    const rows = await H.ctx.collections.sends.find({}).toArray()
    const byId = Object.fromEntries(rows.map((r) => [r.externalId, r.notBefore!.getTime()]))
    const now = Date.now()
    for (const id of ['a', 'b']) {
      expect(byId[id]!).toBeGreaterThanOrEqual(now - 16 * 60_000)
      expect(byId[id]! - now).toBeLessThanOrEqual(24 * HOUR)
    }
    const localHour = (ms: number, tz: string) =>
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(ms)
    const want = localHour(scheduled.getTime(), 'UTC')
    expect(localHour(byId.a!, 'America/New_York')).toBe(want)
    expect(localHour(byId.b!, 'Europe/Berlin')).toBe(want)
    expect(Math.abs(byId.c! - now)).toBeLessThan(60_000)
  })
})

describe('open pixel', () => {
  it('does not turn a bounced or complained send back into delivered', async () => {
    const tpl = await H.ctx.collections.templates.findOne({ slug: 'news' })
    const base = {
      externalId: 'a', emailAtSend: 'qa+a@test.example', templateId: tpl!._id!, templateSlug: 'news', flowRunId: null, broadcastId: null,
      manualSendBy: null, kind: 'marketing' as const, provider: 'null', providerMessageId: 'p', fromName: 'T', fromEmail: 'hello@example.com',
      subject: 's', bodyHash: '', errorMessage: null, bounceReason: null, links: [], vars: {}, openedAt: null, openCount: 0,
      firstClickAt: null, clickCount: 0, clickedLinks: [], unsubscribedAt: null, complainedAt: null, queuedAt: new Date(), updatedAt: new Date(),
      sentAt: new Date(), deliveredAt: null,
    }
    const ids = { bounced: new ObjectId(), complained: new ObjectId(), sent: new ObjectId() }
    await H.ctx.collections.sends.insertMany([
      { ...base, _id: ids.bounced, dedupeKey: 'px:1', status: 'bounced', bounceType: 'hard' },
      { ...base, _id: ids.complained, dedupeKey: 'px:2', status: 'complained', bounceType: null, complainedAt: new Date() },
      { ...base, _id: ids.sent, dedupeKey: 'px:3', status: 'sent', bounceType: null },
    ] as any)
    for (const id of Object.values(ids)) expect((await call('GET', `/m/open/${id}.png`)).status).toBe(200)
    for (let i = 0; i < 50; i += 1) {
      const opened = await H.ctx.collections.sends.countDocuments({ openedAt: { $ne: null } })
      if (opened === 3) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const status = async (id: ObjectId) => (await H.ctx.collections.sends.findOne({ _id: id }))?.status
    expect(await status(ids.bounced)).toBe('bounced')
    expect(await status(ids.complained)).toBe('complained')
    expect(await status(ids.sent)).toBe('delivered')
  })
})
