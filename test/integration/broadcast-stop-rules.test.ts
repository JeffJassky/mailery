/**
 * Per-broadcast stop rules, pause/hold and resume.
 *
 * A breach (hard bounce, complaint or unsubscribe rate over threshold, once
 * the minimum sample of sends with an outcome is in) pauses the broadcast:
 * nothing more is enqueued, queued sends are held (and a held send never
 * reaches the provider), and the reason is recorded. Only an explicit resume
 * re-opens it — and not while the rules, as they will stand, still fire.
 * The circuit breaker and an operator pause use the same machinery.
 *
 * The harness sets `broadcastStopRules.minSample` to 5 so a dozen contacts
 * are enough; the defaults themselves are checked in the unit block.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'
import { ObjectId } from 'mongodb'
import crypto from 'node:crypto'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createPublicRouter } from '../../src/server/api/public.js'
import { createTestMailer, dispatchQueued, type TestMailerHarness } from '../../src/testing/index.js'
import { applyWebhookEvent, dispatchSend, runTick } from '../../src/server/runner/index.js'
import { evaluateStopRules, emptyBroadcastStats } from '../../src/server/runner/broadcast-control.js'
import { BROADCAST_STOP_RULE_DEFAULTS } from '../../src/server/config.js'
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../../src/server/tokens.js'
import type { SendDoc } from '../../src/server/models/index.js'

const TOKEN = 'agent-test-token-0123456789abcdef'
const N = 12

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<ReturnType<typeof express>['listen']>

beforeAll(async () => {
  H = await createTestMailer({ config: { broadcastStopRules: { minSample: 5 } } })
  for (let i = 0; i < N; i += 1) {
    await H.seedContact({ externalId: `s${String(i).padStart(2, '0')}`, email: `qa+s${i}@test.example`, tags: [], fields: {} })
  }
  await H.seedTemplate({
    slug: 'news',
    kind: 'marketing',
    subject: 'News',
    html: '<p>News long enough to be a body.</p><a href="{{unsubscribeUrl}}">Unsubscribe</a><p>{{senderAddress}}</p>',
  })
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
  const c = H.ctx.collections
  await Promise.all([
    c.broadcasts.deleteMany({}),
    c.sends.deleteMany({}),
    c.suppressions.deleteMany({}),
    c.health.deleteMany({}),
    c.webhookEvents.deleteMany({}),
    c.subscriptions.updateMany({}, { $set: { status: 'subscribed' } }),
  ])
})

function http(method: string, path: string, body?: unknown, form = false): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : form ? String(body) : JSON.stringify(body)
    const req = request(
      `${baseUrl}${path}`,
      {
        method,
        headers: {
          'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
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
const agent = (method: string, path: string, body?: unknown) => http(method, `/agent${path}`, body)

/** Create, count, schedule (now) and dispatch via the tick. */
async function launch(slug: string, extra: Record<string, unknown> = {}): Promise<void> {
  expect((await agent('POST', '/broadcasts', { slug, name: slug, templateSlug: 'news', ...extra })).status).toBe(201)
  const { body } = await agent('POST', `/broadcasts/${slug}/count`)
  const sched = await agent('POST', `/broadcasts/${slug}/schedule`, {
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    confirmedCount: body.recipientCount,
  })
  expect(sched.status).toBe(200)
  await runTick(H.ctx)
}

async function sendsOf(slug: string): Promise<SendDoc[]> {
  const b = await H.ctx.collections.broadcasts.findOne({ slug })
  return H.ctx.collections.sends.find({ broadcastId: b!._id }).sort({ externalId: 1 }).toArray()
}

/** Dispatch the first `n` sends through the real pipeline; returns them as stored after. */
async function dispatchFirst(slug: string, n: number): Promise<SendDoc[]> {
  const rows = (await sendsOf(slug)).slice(0, n)
  for (const s of rows) await dispatchSend(s._id!, H.ctx)
  return H.ctx.collections.sends.find({ _id: { $in: rows.map((r) => r._id!) } }).sort({ externalId: 1 }).toArray()
}

async function webhook(send: SendDoc, type: 'delivered' | 'bounce' | 'complaint', details: Record<string, unknown> = {}) {
  await applyWebhookEvent(
    {
      type,
      providerEventId: crypto.randomUUID(),
      providerMessageId: send.providerMessageId!,
      email: send.emailAtSend,
      occurredAt: new Date(),
      details,
    },
    H.ctx,
  )
}

async function get(slug: string) {
  return (await agent('GET', `/broadcasts/${slug}`)).body
}

describe('stop rules fire, pause, and hold', () => {
  it('a hard-bounce rate over threshold pauses the broadcast and holds its queued sends', async () => {
    await launch('bounce')
    const out = await dispatchFirst('bounce', 6)
    for (const s of out.slice(0, 5)) await webhook(s, 'delivered')
    expect((await get('bounce')).broadcast.status).toBe('sent')
    await webhook(out[5]!, 'bounce', { bounceType: 'hard', bounceReason: '550 no such user' })

    const g = await get('bounce')
    expect(g.broadcast.status).toBe('paused')
    expect(g.broadcast.pauseReason).toMatchObject({ code: 'stop_rule' })
    expect(g.broadcast.pauseReason.details.breaches[0]).toMatchObject({ rule: 'hardBounceRatePct', count: 1, thresholdPct: 2 })
    expect(g.stopRules).toMatchObject({ evaluated: true, sample: 6 })
    expect(g.statusBreakdown).toMatchObject({ held: 6, delivered: 5, bounced: 1 })
    const audit = await H.ctx.collections.auditLog.findOne({ action: 'broadcast.pause', 'resource.slug': 'bounce' })
    expect(audit?.diffSummary).toMatch(/stop_rule/)

    // A held send never reaches the provider, even if its job fires.
    const held = (await sendsOf('bounce')).find((s) => s.status === 'held')!
    const before = H.provider.sent.length
    await dispatchSend(held._id!, H.ctx)
    expect(H.provider.sent.length).toBe(before)
    expect((await H.ctx.collections.sends.findOne({ _id: held._id }))?.status).toBe('held')

    // Resume is refused while the rules, as they stand, still fire.
    const refused = await agent('POST', '/broadcasts/bounce/resume', { confirmedCount: 6 })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('stop_rule_still_breached')
    expect(refused.body.evaluation.breaches[0].rule).toBe('hardBounceRatePct')

    // Overriding the threshold in the same call; the count is new (0) + held (6).
    const wrong = await agent('POST', '/broadcasts/bounce/resume', { stopRules: { hardBounceRatePct: 50 }, confirmedCount: 5 })
    expect(wrong.status).toBe(409)
    expect(wrong.body).toMatchObject({ error: 'count_mismatch', expected: 6, recipientCount: 0, heldSends: 6 })
    const ok = await agent('POST', '/broadcasts/bounce/resume', { stopRules: { hardBounceRatePct: 50 }, confirmedCount: 6 })
    expect(ok.status).toBe(200)
    const after = await get('bounce')
    expect(after.broadcast).toMatchObject({ status: 'sent', pauseReason: null, stopRules: { hardBounceRatePct: 50 } })
    expect(after.statusBreakdown.held).toBeUndefined()
    expect(after.statusBreakdown.queued).toBe(6)
    await dispatchQueued(H.ctx)
    expect((await sendsOf('bounce')).every((s) => ['sent', 'delivered', 'bounced'].includes(s.status))).toBe(true)
  })

  it('does nothing below the minimum sample', async () => {
    await launch('small')
    const out = await dispatchFirst('small', 3)
    await webhook(out[0]!, 'delivered')
    await webhook(out[1]!, 'delivered')
    await webhook(out[2]!, 'bounce', { bounceType: 'hard' })
    const g = await get('small')
    expect(g.broadcast.status).toBe('sent')
    expect(g.stopRules).toMatchObject({ evaluated: false, sample: 3, breaches: [] })
  })

  it('stopRules {enabled: false} on the broadcast turns them off', async () => {
    await launch('quiet', { stopRules: { enabled: false } })
    const out = await dispatchFirst('quiet', 6)
    for (const s of out) await webhook(s, 'delivered')
    await webhook(out[0]!, 'complaint')
    const g = await get('quiet')
    expect(g.broadcast.status).toBe('sent')
    expect(g.stats.complained).toBe(1)
    expect(g.stopRules.evaluated).toBe(false)
  })

  it('a one-click unsubscribe from the email is attributed to its send, and counts', async () => {
    await launch('unsub')
    const out = await dispatchFirst('unsub', 6)
    for (const s of out) await webhook(s, 'delivered')

    // The List-Unsubscribe header the provider was handed carries the send id.
    const first = out[0]!
    const args = [...H.provider.sent].reverse().find((a) => a.to === first.emailAtSend)!
    const url = /^<(.+)>$/.exec(args.headers!['List-Unsubscribe']!)![1]!
    const token = url.split('/m/unsub/')[1]!
    expect(verifyUnsubscribeToken(token, H.mailer.config.unsubscribeSecret)?.sendId).toBe(String(first._id))

    const res = await http('POST', `/m/unsub/${token}`, 'List-Unsubscribe=One-Click', true)
    expect(res.status).toBe(200)
    // Attribution runs after the answer; give it a moment.
    for (let i = 0; i < 50; i += 1) {
      if ((await H.ctx.collections.sends.findOne({ _id: first._id }))?.unsubscribedAt) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const g = await get('unsub')
    expect(g.stats.unsubscribed).toBe(1)
    expect(g.broadcast.status).toBe('paused')
    expect(g.broadcast.pauseReason.details.breaches.map((b: any) => b.rule)).toContain('unsubscribeRatePct')
  })

  it('the tick catches a rate that reached the minimum sample on delivered events alone', async () => {
    await launch('late')
    const out = await dispatchFirst('late', 6)
    await webhook(out[0]!, 'bounce', { bounceType: 'hard' }) // sample 1: too early to judge
    for (const s of out.slice(1)) await webhook(s, 'delivered')
    expect((await get('late')).broadcast.status).toBe('sent')
    await runTick(H.ctx)
    const g = await get('late')
    expect(g.broadcast.status).toBe('paused')
    expect(g.broadcast.pauseReason.code).toBe('stop_rule')
  })

  it('records a breach it cannot act on once everything has gone out', async () => {
    await launch('done')
    const out = await dispatchFirst('done', N)
    for (const s of out.slice(0, 10)) await webhook(s, 'delivered')
    await webhook(out[10]!, 'bounce', { bounceType: 'hard' })
    const g = await get('done')
    expect(g.broadcast.status).toBe('sent')
    expect(g.broadcast.stopRuleBreach.breaches[0].rule).toBe('hardBounceRatePct')
  })
})

describe('pause precedence, manual pause, circuit breaker', () => {
  it('a wave parked at its cap that then crosses a rule is re-labelled stop_rule', async () => {
    await launch('capped', { recipientCap: 6 })
    expect((await get('capped')).broadcast.pauseReason.code).toBe('cap_reached')
    const out = await dispatchFirst('capped', 6)
    // Parked at the cap is not a hold: the wave's queued sends go out.
    expect(out.map((s) => s.status)).toEqual(Array(6).fill('sent'))
    for (const s of out.slice(0, 5)) await webhook(s, 'delivered')
    await webhook(out[5]!, 'complaint')
    const g = await get('capped')
    expect(g.broadcast.pauseReason.code).toBe('stop_rule')
    const raise = await agent('POST', '/broadcasts/capped/resume', { recipientCap: 12, confirmedCount: 6 })
    expect(raise.status).toBe(409)
    expect(raise.body.error).toBe('stop_rule_still_breached')
  })

  it('an operator pause holds queued sends until resume', async () => {
    await launch('manual')
    const paused = await agent('POST', '/broadcasts/manual/pause', { reason: 'checking the copy' })
    expect(paused.status).toBe(200)
    expect(paused.body.heldSends).toBe(N)
    expect(paused.body.broadcast.pauseReason).toMatchObject({ code: 'manual', message: 'checking the copy' })
    expect((await agent('POST', '/broadcasts/manual/pause')).status).toBe(409)

    const res = await agent('POST', '/broadcasts/manual/resume', { confirmedCount: N })
    expect(res.status).toBe(200)
    expect((await get('manual')).statusBreakdown).toEqual({ queued: N })
  })

  it('a tripped breaker mid-send pauses the broadcast instead of looping every send on a retry', async () => {
    await launch('breaker')
    await H.ctx.collections.health.insertOne({
      _id: 'd:example.com|k:marketing',
      senderDomain: 'example.com',
      kind: 'marketing',
      status: 'tripped',
      trippedReason: 'hard bounce rate 3.00% >= 2%',
    } as any)
    const first = (await sendsOf('breaker'))[0]!
    await dispatchSend(first._id!, H.ctx)
    let g = await get('breaker')
    expect(g.broadcast.pauseReason).toMatchObject({ code: 'circuit_breaker' })
    expect(g.statusBreakdown).toEqual({ held: N })

    const refused = await agent('POST', '/broadcasts/breaker/resume', { confirmedCount: N })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('circuit_breaker_tripped')

    await H.ctx.collections.health.updateOne({ _id: 'd:example.com|k:marketing' as any }, { $set: { status: 'healthy' } })
    expect((await agent('POST', '/broadcasts/breaker/resume', { confirmedCount: N })).status).toBe(200)
    g = await get('breaker')
    expect(g.statusBreakdown).toEqual({ queued: N })
  })

  it('a breaker already tripped at dispatch enqueues nothing', async () => {
    await H.ctx.collections.health.insertOne({
      _id: 'd:example.com|k:marketing',
      senderDomain: 'example.com',
      kind: 'marketing',
      status: 'tripped',
      trippedReason: 'test',
    } as any)
    await launch('early')
    const g = await get('early')
    expect(g.broadcast.pauseReason.code).toBe('circuit_breaker')
    expect(g.stats.total).toBe(0)
  })
})

describe('unit', () => {
  it('the defaults: 2% hard bounce, 0.1% complaint, 1% unsubscribe, 100 outcomes, strictly greater than', () => {
    expect(BROADCAST_STOP_RULE_DEFAULTS).toEqual({
      enabled: true,
      hardBounceRatePct: 2,
      complaintRatePct: 0.1,
      unsubscribeRatePct: 1,
      minSample: 100,
    })
    const stats = (patch: Record<string, number>) => ({ ...emptyBroadcastStats(), ...patch }) as any
    expect(evaluateStopRules(stats({ outcomes: 99, hardBounced: 50 }), BROADCAST_STOP_RULE_DEFAULTS).evaluated).toBe(false)
    expect(evaluateStopRules(stats({ outcomes: 100, hardBounced: 2 }), BROADCAST_STOP_RULE_DEFAULTS).breaches).toEqual([])
    expect(evaluateStopRules(stats({ outcomes: 100, hardBounced: 3 }), BROADCAST_STOP_RULE_DEFAULTS).breaches[0]).toMatchObject({
      rule: 'hardBounceRatePct',
      ratePct: 3,
    })
    expect(evaluateStopRules(stats({ outcomes: 1000, complained: 1 }), BROADCAST_STOP_RULE_DEFAULTS).breaches).toEqual([])
    expect(evaluateStopRules(stats({ outcomes: 1000, complained: 2 }), BROADCAST_STOP_RULE_DEFAULTS).breaches[0]?.rule).toBe('complaintRatePct')
    expect(evaluateStopRules(stats({ outcomes: 100, unsubscribed: 1 }), BROADCAST_STOP_RULE_DEFAULTS).breaches).toEqual([])
  })

  it('unsubscribe tokens carry an optional send id; tokens without one verify as before', () => {
    const secret = 'unit-secret-unit-secret-unit-secret'
    const expiresAt = new Date(Date.now() + 60_000)
    const id = new ObjectId().toHexString()
    expect(verifyUnsubscribeToken(signUnsubscribeToken({ email: 'A@b.co', scope: 'marketing', expiresAt, sendId: id }, secret), secret)).toMatchObject({
      email: 'a@b.co',
      sendId: id,
    })
    const plain = verifyUnsubscribeToken(signUnsubscribeToken({ email: 'a@b.co', scope: 'marketing', expiresAt }, secret), secret)
    expect(plain).toEqual({ email: 'a@b.co', scope: 'marketing', expiresAt })
    const junk = verifyUnsubscribeToken(signUnsubscribeToken({ email: 'a@b.co', scope: 'marketing', expiresAt, sendId: 'not-an-id' }, secret), secret)
    expect(junk?.sendId).toBeUndefined()
  })
})
