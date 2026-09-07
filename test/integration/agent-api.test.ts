/**
 * HTTP tests for the agent router — the bearer-token surface an automated
 * caller drives: verification matrices, real pipeline sends with delivery
 * waits, flow simulation, step-by-step run control, arm/gate, test-contact
 * resets and the composite status document.
 *
 * Module-level behaviour (arm/gate/simulate) is exercised through the routes
 * because the routes are the contract; the guard against non-test contacts
 * is asserted on every mutating route that has one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { verifyUnsubscribeToken } from '../../src/server/tokens.js'
import { runTick } from '../../src/server/runner/index.js'

const TOKEN = 'agent-test-token-0123456789abcdef'
const DAY_MS = 24 * 60 * 60 * 1000

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<ReturnType<typeof express>['listen']>

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      senderDomains: { 'example.com': { kind: 'both' } },
    },
  })
  await H.seedContact({ externalId: 't1', email: 'qa+one@test.example', tags: ['Created'], fields: { firstName: 'Quinn' } })
  await H.seedContact({ externalId: 't2', email: 'qa+two@test.example', tags: ['Created'], fields: { firstName: 'Tess' } })
  await H.seedContact({ externalId: 'r1', email: 'real@example.com', tags: ['Created'], fields: { firstName: 'Rae' } })

  await H.seedTemplate({
    slug: 'welcome',
    kind: 'marketing',
    fromEmail: 'hello@example.com',
    subject: 'Welcome {{contact.fields.firstName}}',
    preheader: 'Three things to try',
    html:
      '<p>Hi {{contact.fields.firstName}}, welcome aboard. Here is a paragraph long enough to count as real body copy.</p>' +
      '<a href="https://example.com/start">Start</a> ' +
      '<a href="{{unsubscribeUrl}}">Unsubscribe</a><p>{{senderAddress}}</p>',
  })
  await H.seedTemplate({
    slug: 'broken',
    kind: 'marketing',
    fromEmail: 'hello@example.com',
    subject: 'Hello {{nope.missing}}',
    html: '<p>{{contact.fields.firstName}}</p><a href="/relative">rel</a>',
  })
  await H.seedTemplate({
    slug: 'receipt',
    kind: 'transactional',
    fromEmail: 'hello@example.com',
    subject: 'Your receipt',
    html: '<p>Thanks {{contact.fields.firstName}}, this is your receipt for the order you placed today.</p>',
  })

  await H.seedFlow({
    slug: 'onboard',
    eventName: 'Created',
    once: true,
    enabled: false,
    steps: [
      step.wait(1, 'days'),
      { type: 'condition', test: { hasTag: 'Created' }, ifFalse: 'exit' },
      step.send('welcome'),
      step.exit('sequence_complete'),
    ],
  })

  H.mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
  H.mailer.registerEvent({ name: 'Ping', dedupePolicy: 'every-time' })

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

function call(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) }
    if (token) headers.authorization = `Bearer ${token}`
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

describe('construction', () => {
  it('refuses to build without a token, or with a weak one', () => {
    expect(() => createAgentRouter(H.mailer, { tokens: [] })).toThrow(/at least one bearer token/)
    expect(() => createAgentRouter(H.mailer, { tokens: [{ token: 'short', actor: 'a' }] })).toThrow(/at least 24 characters/)
    expect(() => createAgentRouter(H.mailer, { tokens: [{ token: TOKEN, actor: '' }] })).toThrow(/actor/)
  })
})

describe('auth + discovery', () => {
  it('401s without a token, and with the wrong one', async () => {
    expect((await call('GET', '/', undefined, null)).status).toBe(401)
    expect((await call('GET', '/', undefined, 'not-the-token-not-the-token-x')).status).toBe(401)
  })

  it('describes itself with the actor behind the token', async () => {
    const res = await call('GET', '/')
    expect(res.status).toBe(200)
    expect(res.body.actor).toBe('agent:test')
    expect(res.body.testContactsConfigured).toBe(true)
    expect(res.body.endpoints.some((e: any) => e.path.startsWith('/flows/:slug/simulate'))).toBe(true)
  })

  it('exposes the admin JSON API under /api with the same token', async () => {
    const res = await call('GET', '/api/flows')
    expect(res.status).toBe(200)
    expect(res.body.map((f: any) => f.slug)).toContain('onboard')
  })

  it('answers unknown routes with JSON', async () => {
    const res = await call('GET', '/nope')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })
})

describe('templates: verify / render', () => {
  it('passes a well-formed marketing template rendered as a real contact', async () => {
    const res = await call('POST', '/templates/welcome/verify', { contactId: 't1', includeRendered: true })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const by = Object.fromEntries(res.body.checks.map((k: any) => [k.id, k.status]))
    expect(by.render).toBe('pass')
    expect(by.unresolved_placeholders).toBe('pass')
    expect(by.unsubscribe_link).toBe('pass')
    expect(by.sender_address).toBe('pass')
    expect(by.links_absolute).toBe('pass')
    expect(by.from_domain).toBe('pass')
    expect(res.body.rendered.subject).toBe('Welcome Quinn')
    expect(res.body.rendered.html).toContain('/m/unsub/')
  })

  it('fails a template with leftover placeholders, relative links and no unsubscribe', async () => {
    const res = await call('POST', '/templates/broken/verify', { contactId: 't1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    const failed = res.body.checks.filter((k: any) => k.status === 'fail').map((k: any) => k.id)
    // Handlebars renders an unknown path as an empty string — no braces are
    // left behind — so the check that catches this class is the one that
    // compares referenced paths against the render context.
    expect(failed).toContain('unknown_variables')
    expect(failed).toContain('links_absolute')
    expect(failed).toContain('unsubscribe_link')
    expect(failed).toContain('lint')
    const uv = res.body.checks.find((k: any) => k.id === 'unknown_variables')
    expect(uv.detail.missing).toEqual(['nope.missing'])
    expect(res.body.checks.find((k: any) => k.id === 'unresolved_placeholders').status).toBe('pass')
  })

  it('ignores placeholders that only appear inside HTML comments', async () => {
    await H.seedTemplate({
      slug: 'commented',
      kind: 'transactional',
      fromEmail: 'hello@example.com',
      subject: 'Commented',
      html: '<!-- not {{preferenceCenterUrl}}, and {{ghost.var}} is fine here --><p>Hello {{contact.fields.firstName}}, a body long enough to count.</p>',
    })
    const res = await call('POST', '/templates/commented/verify', { contactId: 't1' })
    expect(res.body.ok).toBe(true)
    expect(res.body.checks.find((k: any) => k.id === 'unknown_variables').detail.missing).toEqual([])
    expect(res.body.checks.find((k: any) => k.id === 'empty_variables').status).toBe('pass')
  })

  it('does not require an unsubscribe link on a transactional template', async () => {
    const res = await call('POST', '/templates/receipt/verify', { contactId: 't1' })
    expect(res.body.ok).toBe(true)
    expect(res.body.checks.find((k: any) => k.id === 'unsubscribe_link')).toBeUndefined()
  })

  it('accepts a sampleContact instead of a contactId, and validates input', async () => {
    const ok = await call('POST', '/templates/welcome/verify', { sampleContact: { email: 'sample@example.com', fields: { firstName: 'Sam' } } })
    expect(ok.status).toBe(200)
    expect(ok.body.rendered.subject).toBe('Welcome Sam')
    expect((await call('POST', '/templates/welcome/verify', {})).status).toBe(400)
    expect((await call('POST', '/templates/missing/verify', { contactId: 't1' })).status).toBe(404)
    expect((await call('POST', '/templates/welcome/verify', { contactId: 'ghost' })).status).toBe(404)
  })

  it('verify-all produces a template × contact matrix', async () => {
    const res = await call('POST', '/templates/verify-all', { contactIds: ['t1', 't2'], slugs: ['welcome', 'broken'] })
    expect(res.status).toBe(200)
    expect(res.body.verified).toBe(4)
    expect(res.body.failing).toBe(2)
    expect(res.body.ok).toBe(false)
    expect(res.body.results.filter((r: any) => r.slug === 'broken').every((r: any) => !r.ok)).toBe(true)
  })

  it('render returns the full rendered parts and a signed unsubscribe URL', async () => {
    const res = await call('POST', '/templates/welcome/render', { contactId: 't2' })
    expect(res.status).toBe(200)
    expect(res.body.html).toContain('Hi Tess')
    expect(res.body.plainText).toContain('Tess')
    expect(res.body.unsubscribeUrl).toMatch(/\/m\/unsub\/[^/]+\.[^/]+$/)
  })
})

describe('templates: real sends', () => {
  it('sends through the real pipeline to a test contact and reports delivery state', async () => {
    H.provider.reset()
    const res = await call('POST', '/templates/welcome/send', { contactId: 't1' })
    expect(res.status).toBe(201)
    expect(res.body.dispatched).toBe(true)
    expect(res.body.send.status).toBe('sent')
    expect(H.provider.sent).toHaveLength(1)
    expect(H.provider.sent[0]!.to).toBe('qa+one@test.example')
    expect(H.provider.sent[0]!.subject).toBe('Welcome Quinn')

    const wait = await call('GET', `/sends/${res.body.sendId}/wait?status=sent&timeoutMs=1000`)
    expect(wait.status).toBe(200)
    expect(wait.body.reached).toBe(true)
    const notDelivered = await call('GET', `/sends/${res.body.sendId}/wait?status=delivered&timeoutMs=0`)
    expect(notDelivered.body.reached).toBe(false)
  })

  it('refuses to send to a contact outside the test pattern', async () => {
    const res = await call('POST', '/templates/welcome/send', { contactId: 'r1' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('not_a_test_contact')
  })

  it('can queue without dispatching, then dispatch on demand', async () => {
    H.provider.reset()
    const res = await call('POST', '/templates/receipt/send', { contactId: 't2', dispatch: 'queue' })
    expect(res.status).toBe(201)
    expect(res.body.send.status).toBe('queued')
    expect(H.provider.sent).toHaveLength(0)
    const d = await call('POST', `/sends/${res.body.sendId}/dispatch`)
    expect(d.status).toBe(200)
    expect(d.body.send.status).toBe('sent')
    expect(H.provider.sent).toHaveLength(1)
  })

  it('dedupes a repeated send on the caller-supplied key', async () => {
    const a = await call('POST', '/templates/receipt/send', { contactId: 't2', dedupeKey: 'once' })
    const b = await call('POST', '/templates/receipt/send', { contactId: 't2', dedupeKey: 'once' })
    expect(a.body.sendId).toBe(b.body.sendId)
  })
})

describe('events', () => {
  it('fires a registered event for a test contact, and only for one', async () => {
    const ok = await call('POST', '/events', { name: 'Ping', externalId: 't1', properties: { n: 1 } })
    expect(ok.status).toBe(201)
    expect(ok.body.event.name).toBe('Ping')
    expect((await call('POST', '/events', { name: 'Ping', externalId: 'r1' })).status).toBe(403)
    const unregistered = await call('POST', '/events', { name: 'Mystery', externalId: 't1' })
    expect(unregistered.status).toBe(400)
    expect(unregistered.body.error).toBe('fire_failed')
  })
})

describe('flows: simulate', () => {
  it('walks the path with a virtual clock and explains why the trigger would not enter', async () => {
    const at = new Date('2026-09-08T12:00:00.000Z')
    const res = await call('POST', '/flows/onboard/simulate', { contactId: 't1', at: at.toISOString() })
    expect(res.status).toBe(200)
    expect(res.body.wouldEnter.ok).toBe(false)
    expect(res.body.wouldEnter.reasons.join(' ')).toMatch(/disabled/)
    expect(res.body.path.map((p: any) => p.outcome)).toEqual(['waited', 'passed', 'send', 'exited'])
    expect(res.body.sends).toHaveLength(1)
    expect(new Date(res.body.sends[0].at).getTime()).toBe(at.getTime() + DAY_MS)
    expect(res.body.durationMs).toBe(DAY_MS)
    expect(res.body.terminal.kind).toBe('exited')
    expect(res.body.terminal.reason).toBe('sequence_complete')
  })

  it('exits at a failing gate and sends nothing', async () => {
    await H.seedContact({ externalId: 't3', email: 'qa+three@test.example', tags: [], fields: {} })
    const res = await call('POST', '/flows/onboard/simulate', { contactId: 't3' })
    expect(res.body.path.map((p: any) => p.outcome)).toEqual(['waited', 'exited'])
    expect(res.body.sends).toHaveLength(0)
    expect(res.body.terminal.reason).toBe('condition_false')
  })
})

describe('flows: arm', () => {
  it('requires confirmation, stamps the watermark, and skips events fired before it', async () => {
    // An event fired BEFORE arming must never enter the flow. Backdated past
    // the scanner's 30-second overlap window, which is the runner's own
    // concurrency guard and is documented to admit events that recent.
    const old = new Date(Date.now() - 60_000)
    await H.mailer.collections.events.insertOne({
      externalId: 't1', name: 'Created', properties: {}, dedupeKey: 't1:Created', occurredAt: old, createdAt: old,
    })

    const noConfirm = await call('POST', '/flows/onboard/arm', {})
    expect(noConfirm.status).toBe(400)
    expect(noConfirm.body.error).toBe('confirm_required')

    const res = await call('POST', '/flows/onboard/arm', { confirm: true })
    expect(res.status).toBe(200)
    expect(res.body.armed).toBe(true)
    expect(res.body.skippedEvents).toBe(1)
    expect(res.body.watermark).toBeTruthy()

    await runTick(H.ctx)
    expect(await H.mailer.collections.flowRuns.countDocuments({ externalId: 't1' })).toBe(0)

    // An event fired AFTER arming enters on the next tick.
    await H.mailer.fire('Created', 't2')
    await runTick(H.ctx)
    expect(await H.mailer.collections.flowRuns.countDocuments({ externalId: 't2', status: 'active' })).toBe(1)

    const again = await call('POST', '/flows/onboard/arm', { confirm: true })
    expect(again.body.armed).toBe(false)
    expect(again.body.alreadyEnabled).toBe(true)
  })

  it('refuses a flow with no published steps', async () => {
    await H.seedFlow({ slug: 'empty', eventName: 'Ping', enabled: false, steps: [] })
    const res = await call('POST', '/flows/empty/arm', { confirm: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('no_live_steps')
  })
})

describe('runs: advance / cancel', () => {
  it('walks a test contact through the wait, the gate and the send, dispatching inline', async () => {
    H.provider.reset()
    const run = await H.mailer.collections.flowRuns.findOne({ externalId: 't2', flowSlug: 'onboard' })
    expect(run).not.toBeNull()
    // The tick's sweep has processed the wait step: parked a day out.
    expect(run!.nextActionAt.getTime()).toBeGreaterThan(Date.now() + DAY_MS / 2)

    const res = await call('POST', `/runs/${run!._id}/advance`, { steps: 3 })
    expect(res.status).toBe(200)
    expect(res.body.historyAdded.some((h: any) => h.action === 'wait_completed' && h.details.forcedBy === 'agent:test')).toBe(true)
    expect(res.body.sends).toHaveLength(1)
    expect(res.body.sends[0].status).toBe('sent')
    expect(res.body.run.status).toBe('exited')
    expect(res.body.run.exitReason).toBe('sequence_complete')
    expect(H.provider.sent.map((s) => s.to)).toEqual(['qa+two@test.example'])

    const done = await call('POST', `/runs/${run!._id}/advance`, {})
    expect(done.status).toBe(409)
  })

  it('will not step a real contact, but will cancel any run', async () => {
    await H.mailer.fire('Created', 'r1')
    await runTick(H.ctx)
    const run = await H.mailer.collections.flowRuns.findOne({ externalId: 'r1', status: 'active' })
    expect(run).not.toBeNull()
    expect((await call('POST', `/runs/${run!._id}/advance`, {})).status).toBe(403)

    const cancel = await call('POST', `/runs/${run!._id}/cancel`)
    expect(cancel.status).toBe(200)
    expect(cancel.body.run.status).toBe('exited')
    expect(cancel.body.run.exitReason).toBe('aborted_by_host:agent:test')

    const listed = await call('GET', '/runs?externalId=r1')
    expect(listed.body).toHaveLength(1)
    const one = await call('GET', `/runs/${run!._id}`)
    expect(one.body.run.status).toBe('exited')
  })
})

describe('flows: gate / ungate', () => {
  it('publishes a gated version, keeps the flow state, and restores the real steps', async () => {
    const before = await H.mailer.collections.flows.findOne({ slug: 'onboard' })
    const gate = await call('POST', '/flows/onboard/gate', { tag: 'Canary' })
    expect(gate.status).toBe(200)
    expect(gate.body.version).toBe(before!.version + 1)
    expect(gate.body.enabled).toBe(true)

    // A contact without the tag exits at step 0; with it, the real steps run.
    const blocked = await call('POST', '/flows/onboard/simulate', { contactId: 't1' })
    expect(blocked.body.path[0]).toMatchObject({ stepIndex: 0, type: 'condition', outcome: 'exited' })
    expect(blocked.body.sends).toHaveLength(0)
    H.memoryAdapter!.upsert({ externalId: 't1', email: 'qa+one@test.example', tags: ['Created', 'Canary'], fields: { firstName: 'Quinn' } })
    const allowed = await call('POST', '/flows/onboard/simulate', { contactId: 't1' })
    expect(allowed.body.sends).toHaveLength(1)

    expect((await call('POST', '/flows/onboard/gate', { tag: 'Canary' })).status).toBe(409)

    const ungate = await call('POST', '/flows/onboard/ungate')
    expect(ungate.status).toBe(200)
    expect(ungate.body.restoredFrom).toBe(before!.version)
    const after = await H.mailer.collections.flows.findOne({ slug: 'onboard' })
    expect(after!.steps).toEqual(before!.steps)
    expect(after!.enabled).toBe(true)
    expect((await call('POST', '/flows/onboard/ungate')).status).toBe(409)

    const status = await call('GET', '/status')
    expect(status.body.flows.find((f: any) => f.slug === 'onboard').gated).toBeNull()
  })
})

describe('contacts', () => {
  it('returns detail by id and by email, with the test-contact verdict', async () => {
    const byId = await call('GET', '/contacts/t1')
    expect(byId.status).toBe(200)
    expect(byId.body.isTestContact).toBe(true)
    expect(byId.body.subscription.status).toBe('subscribed')
    const byEmail = await call('GET', '/contacts/by-email/real@example.com')
    expect(byEmail.body.contact.externalId).toBe('r1')
    expect(byEmail.body.isTestContact).toBe(false)
  })

  it('hands out a verifiable unsubscribe URL and flips subscription state', async () => {
    const url = await call('GET', '/contacts/t2/unsubscribe-url')
    expect(url.status).toBe(200)
    const token = url.body.unsubscribeUrl.split('/m/unsub/')[1]
    const payload = verifyUnsubscribeToken(token, H.mailer.config.unsubscribeSecret)
    expect(payload?.email).toBe('qa+two@test.example')
    expect((await call('GET', '/contacts/r1/unsubscribe-url')).status).toBe(403)

    const off = await call('POST', '/contacts/t2/unsubscribe')
    expect(off.body.subscription.status).toBe('unsubscribed')
    const on = await call('POST', '/contacts/t2/subscribe')
    expect(on.body.subscription.status).toBe('subscribed')
  })

  it('resets a test contact so a once-only flow can run again', async () => {
    const res = await call('POST', '/contacts/t2/reset')
    expect(res.status).toBe(200)
    expect(res.body.removed.runs).toBe(1)
    expect(res.body.removed.sends).toBeGreaterThanOrEqual(1)
    expect(res.body.removed.events).toBeGreaterThanOrEqual(1)
    expect(res.body.removed.suppressions).toBe(1)
    expect(res.body.subscription.status).toBe('subscribed')
    expect(await H.mailer.collections.flowRuns.countDocuments({ externalId: 't2' })).toBe(0)
    expect((await call('POST', '/contacts/r1/reset')).status).toBe(403)
  })
})

describe('runner + status', () => {
  it('runs a tick and reports status and webhook ingest', async () => {
    const tick = await call('POST', '/tick')
    expect(tick.status).toBe(200)
    expect(tick.body.ok).toBe(true)

    const status = await call('GET', '/status')
    expect(status.status).toBe(200)
    expect(status.body.testContactsConfigured).toBe(true)
    expect(status.body.flows.find((f: any) => f.slug === 'onboard')).toMatchObject({ enabled: true, liveSteps: 4 })
    expect(status.body.templates.map((t: any) => t.slug).sort()).toEqual(['broken', 'commented', 'receipt', 'welcome'])
    expect(status.body.counts.sendsLast24h.sent).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(status.body.setup.checks)).toBe(true)

    const wh = await call('GET', '/webhooks/status')
    expect(wh.status).toBe(200)
    expect(wh.body.lastReceivedAt).toBeNull()
    expect(wh.body.unprocessed).toBe(0)
  })
})
