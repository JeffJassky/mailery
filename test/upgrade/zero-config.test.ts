/**
 * Upgrade safety (0.21): with none of `categories`, `contactPolicy`,
 * `factsAdapter`, `programs` set, a 0.21 mailer must produce exactly what
 * 0.20 produced — same provider calls (headers and bodies), same send-row
 * shapes (key sets included, so no new field appears where nothing asked for
 * it), same flow-run histories, same unsubscribe page and writes, same
 * webhook effects.
 *
 * `__snapshots__/zero-config.json` was generated on 0.20.0 (the commit
 * before any 0.21 code) and is the contract. Never update it to make this
 * test pass; a diff here is an upgrade that changes behaviour for hosts that
 * did not opt in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ObjectId } from 'mongodb'

import { createPublicRouter } from '../../src/server/api/public.js'
import { applyWebhookEvent, runTick } from '../../src/server/runner/index.js'
import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { advance, DAY, freezeAt, MINUTE, restoreClock } from '../matrix/clock.js'

let H: TestMailerHarness
let base: string
let server: ReturnType<express.Express['listen']>

beforeAll(async () => {
  H = await createTestMailer()
  const app = express()
  app.use('/m', createPublicRouter(H.mailer, { logger: { error: () => {}, warn: () => {}, info: () => {} } }))
  server = app.listen(0)
  await new Promise<void>((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  restoreClock()
  server?.close()
  if (H) await H.stop()
})

function normalize(value: unknown): unknown {
  const s = JSON.stringify(value, (_k, v) => (v instanceof Date ? `<date:${v.toISOString()}>` : v))
  return JSON.parse(
    s
      .replace(/\/unsub\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '/unsub/<token>')
      .replace(/\/open\/[a-f0-9]{24}\.[A-Za-z0-9_-]{12}\.png/g, '/open/<id>.<sig>.png')
      .replace(/\/click\/[a-f0-9]{24}\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]{12}/g, '/click/<id>/<link>/<sig>')
      .replace(/[a-f0-9]{24}/g, '<id>')
      .replace(/null-[A-Za-z0-9-]+/g, '<provider-id>'),
  )
}

function http(method: 'GET' | 'POST', p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${p}`, { method, headers: { 'content-length': '0' } }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('0.21 with no new config behaves as 0.20', () => {
  it('flows, one-offs, a broadcast, tracking, webhooks and unsubscribe produce the 0.20 transcript', async () => {
    freezeAt('2026-03-10T15:00:00Z')
    const { mailer } = H
    const ctx = H.ctx

    for (const [id, first] of [['u1', 'Alice'], ['u2', 'Bob'], ['u3', 'Cara']] as const) {
      await H.seedContact({ externalId: id, email: `${id}@example.com`, tags: [], fields: { firstName: first } })
    }
    await H.seedTemplate({
      slug: 'welcome',
      kind: 'marketing',
      subject: 'Welcome {{contact.fields.firstName}}',
      html: '<p>Hi {{contact.fields.firstName}}</p><a href="https://example.com/start">Start</a><a href="{{unsubscribeUrl}}">Unsubscribe</a>',
      trackOpens: true,
      trackClicks: true,
    })
    await H.seedTemplate({ slug: 'nudge', kind: 'marketing', subject: 'Still there?', text: 'Nudge {{contact.fields.firstName}}' })
    await H.seedTemplate({ slug: 'receipt', kind: 'transactional', subject: 'Receipt', text: 'Thanks' })
    await H.seedTemplate({ slug: 'plain', kind: 'marketing', bodyFormat: 'text_only', subject: 'Plain', plainText: 'Just text {{unsubscribeUrl}}', text: 'x' })

    await H.seedFlow({
      slug: 'onboarding',
      eventName: 'Created',
      steps: [
        step.send('welcome'),
        step.wait(2, 'days'),
        { type: 'condition', test: { hasTag: 'vip' }, ifFalse: 'continue' },
        step.send('nudge'),
        step.tag(['onboarded']),
      ],
    })
    mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })

    // Flow entry for two contacts.
    await mailer.fire('Created', 'u1')
    await mailer.fire('Created', 'u2')
    await H.drain()

    // One-offs: transactional and text-only marketing.
    await mailer.sendOneOff({ templateSlug: 'receipt', externalId: 'u3', dedupeKey: 'r1' })
    await mailer.sendOneOff({ templateSlug: 'plain', externalId: 'u3', dedupeKey: 'p1' })
    await H.drain()

    // A broadcast to everyone.
    await ctx.collections.broadcasts.insertOne({
      slug: 'march-news',
      name: 'March news',
      templateSlug: 'nudge',
      segmentDefinition: { filters: [] },
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - MINUTE),
      startedAt: null,
      completedAt: null,
      confirmationRequired: false,
      confirmedCount: null,
      confirmedAt: null,
      confirmedBy: null,
      recipientCount: null,
      stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
      createdAt: new Date(),
      createdBy: 'test',
      updatedAt: new Date(),
    })
    await runTick(ctx)
    await H.drain()

    // Webhooks against the first welcome send.
    const welcome = await ctx.collections.sends.findOne({ templateSlug: 'welcome', externalId: 'u1' })
    const msgId = welcome!.providerMessageId!
    advance(MINUTE)
    await applyWebhookEvent({ type: 'delivered', providerEventId: 'e1', providerMessageId: msgId, email: 'u1@example.com', occurredAt: new Date(), details: {} }, ctx)
    await applyWebhookEvent({ type: 'open', providerEventId: 'e2', providerMessageId: msgId, email: 'u1@example.com', occurredAt: new Date(), details: { userAgent: 'Mozilla/5.0' } }, ctx)
    const welcome2 = await ctx.collections.sends.findOne({ templateSlug: 'welcome', externalId: 'u2' })
    await applyWebhookEvent({ type: 'bounce', providerEventId: 'e3', providerMessageId: welcome2!.providerMessageId!, email: 'u2@example.com', occurredAt: new Date(), details: { bounceType: 'hard', bounceReason: '550' } }, ctx)

    // Unsubscribe page + one-click for u1, using the URL that went out.
    const header = H.provider.sent.find((s) => s.to === 'u1@example.com')!.headers!['List-Unsubscribe']!
    const unsubPath = new URL(header.slice(1, -1)).pathname
    const page = await http('GET', unsubPath)
    const oneClick = await http('POST', unsubPath)

    // Time passes; the flow continues for whoever is still deliverable.
    advance(2 * DAY + MINUTE)
    await H.drain()

    const sends = await ctx.collections.sends.find({}).sort({ queuedAt: 1, templateSlug: 1, emailAtSend: 1 }).toArray()
    const runs = await ctx.collections.flowRuns.find({}).sort({ externalId: 1 }).toArray()
    const suppressions = await ctx.collections.suppressions.find({}).sort({ email: 1, scope: 1 }).toArray()

    const transcript = normalize({
      provider: H.provider.sent.map((s) => ({
        to: s.to,
        from: `${s.fromName} <${s.fromEmail}>`,
        replyTo: s.replyTo ?? null,
        subject: s.subject,
        headers: s.headers ?? {},
        html: s.html ?? null,
        text: s.text,
        meta: Object.keys(s.messageMeta ?? {}).sort(),
      })),
      sends: sends.map((d) => ({
        keys: Object.keys(d).sort(),
        templateSlug: d.templateSlug,
        to: d.emailAtSend,
        kind: d.kind,
        status: d.status,
        errorMessage: d.errorMessage,
        bounceType: d.bounceType,
        openCount: d.openCount,
        origin: d.broadcastId ? 'broadcast' : d.flowRunId ? 'flow' : 'oneoff',
      })),
      runs: runs.map((r) => ({
        externalId: r.externalId,
        status: r.status,
        step: r.currentStepIndex,
        history: r.history.map((h) => h.action),
        exitReason: r.exitReason,
      })),
      suppressions: suppressions.map((s) => ({ keys: Object.keys(s).sort(), email: s.email, scope: s.scope, reason: s.reason, source: s.source })),
      unsubscribe: { getStatus: page.status, getBody: page.body, postStatus: oneClick.status, postBody: oneClick.body },
      subscriptions: (await ctx.collections.subscriptions.find({}).sort({ externalId: 1 }).toArray()).map((s) => ({
        externalId: s.externalId,
        status: s.status,
      })),
    })

    await expect(JSON.stringify(transcript, null, 2)).toMatchFileSnapshot('./__snapshots__/zero-config.json')
  })
})
