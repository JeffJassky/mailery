/**
 * R1 compliance fixes (0.21): template drift vs Programs, preference Save vs a
 * global opt-out, lenient opt-out addresses, forgetSubject, plain-page wording,
 * agent preview token category. INVARIANTS 3, 4, 8, 9, 22.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createPublicRouter } from '../../src/server/api/public.js'
import { drainPendingUnsubscribes } from '../../src/server/runner/pending-unsubs.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { sha256Hex, signUnsubscribeToken, verifyUnsubscribeToken } from '../../src/server/tokens.js'
import { readClaim } from '../../src/server/unsub-journal.js'
import { createTestMailer, tickProgram } from '../../src/testing/index.js'
import { restoreClock } from '../matrix/clock.js'
import {
  activation,
  CATEGORY,
  decisionsFor,
  dispatch,
  enter,
  getRun,
  programHarness,
  programSends,
  seedProgramWithTemplates,
  startClock,
  subject,
  type ProgramHarness,
} from '../programs/helpers.js'

const OTHER = 'product.updates'
const AGENT_TOKEN = 'r1-agent-token-0123456789abcdef'
const quiet = { error: () => {}, warn: () => {}, info: () => {} }

let P: ProgramHarness
let dir: string
let journal: string
let base: string
const servers: Array<ReturnType<express.Express['listen']>> = []

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0)
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(async () => {
  P = await programHarness()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailery-r1-'))
  journal = path.join(dir, 'j.jsonl')
  ;(P.H.mailer.config as any).pendingUnsubsPath = journal
  await seedProgramWithTemplates(P.H, activation())
  const app = express()
  app.use('/m', createPublicRouter(P.H.mailer, { logger: quiet }))
  app.use('/agent', createAgentRouter(P.H.mailer, { tokens: [{ token: AGENT_TOKEN, actor: 'agent:r1' }], testContacts: /@test\.example$/i }))
  base = await listen(app)
}, 120_000)

afterAll(async () => {
  for (const s of servers) s.close()
  fs.rmSync(dir, { recursive: true, force: true })
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => {
  restoreClock()
  restoreMongo()
})

const col = () => P.H.mailer.collections
async function json(method: string, p: string, body?: unknown) {
  const res = await fetch(`${base}/agent${p}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* html */ }
  return { status: res.status, body: parsed }
}
async function form(p: string, fields: Array<[string, string]> = []) {
  const res = await fetch(`${base}/m${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
  return { status: res.status, body: await res.text() }
}
async function page(p: string) {
  const res = await fetch(`${base}/m${p}`)
  return { status: res.status, body: await res.text() }
}
const token = (email: string, category?: string, secret = P.H.mailer.config.unsubscribeSecret) =>
  signUnsubscribeToken({ email, scope: 'marketing', ...(category ? { category } : {}), expiresAt: new Date(Date.now() + 86_400_000) }, secret)
const scopes = async (email: string) =>
  (await col().suppressions.find({ emailHash: sha256Hex(email) }).toArray()).map((r) => `${r.scope}/${r.reason}`).sort()
async function seedRow(email: string, scope: string) {
  await col().suppressions.insertOne({
    email, emailHash: sha256Hex(email), scope: scope as any, reason: 'unsubscribed', source: 'test', notes: null, addedAt: new Date(), expiresAt: null,
  })
}

let originalUpdateOne: any = null
function breakMongo() {
  const coll = col().suppressions as any
  originalUpdateOne ??= coll.updateOne.bind(coll)
  coll.updateOne = () => Promise.reject(new Error('MongoServerSelectionError: no primary'))
}
function restoreMongo() {
  if (originalUpdateOne) (col().suppressions as any).updateOne = originalUpdateOne
  originalUpdateOne = null
}

// ---------------------------------------------------------------------------
// 1. Template drift vs Programs
// ---------------------------------------------------------------------------

describe('1a. dispatch cancels a program send whose template drifted', () => {
  async function driftAndDispatch(patch: Record<string, unknown>, unset: Record<string, ''> = {}) {
    startClock()
    const { subjectId, owners } = await subject(P)
    await enter(P, 'activation', subjectId)
    await tickProgram(P.H.ctx, 'activation', subjectId)
    const [queued] = await programSends(P, subjectId)
    const original = (await col().templates.findOne({ slug: queued!.templateSlug }))!
    await col().templates.updateOne({ slug: original.slug }, { $set: patch, ...(Object.keys(unset).length ? { $unset: unset } : {}) })
    try {
      const before = P.H.provider.sent.length
      await dispatch(P)
      expect(P.H.provider.sent.length).toBe(before)
      void owners
      return (await programSends(P, subjectId))[0]!
    } finally {
      await col().templates.replaceOne({ slug: original.slug }, original)
    }
  }

  it('template no longer marketing', async () => {
    const send = await driftAndDispatch({ kind: 'transactional' }, { category: '' })
    expect(send).toMatchObject({ status: 'cancelled', exitReason: 'ineligible_before_send' })
    expect(send.errorMessage).toMatch(/connect-shopify-1.*marketing/)
  })

  it('template moved to another category', async () => {
    const send = await driftAndDispatch({ category: OTHER })
    expect(send).toMatchObject({ status: 'cancelled', exitReason: 'ineligible_before_send' })
    expect(send.errorMessage).toMatch(/category/)
  })
})

describe('1b. tick does not send from a drifted template', () => {
  it('records the candidate as ineligible and creates no send', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const original = (await col().templates.findOne({ slug: 'connect-shopify-1' }))!
    await col().templates.updateOne({ slug: 'connect-shopify-1' }, { $set: { category: OTHER } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await enter(P, 'activation', subjectId)
      await tickProgram(P.H.ctx, 'activation', subjectId)
      expect(await programSends(P, subjectId)).toHaveLength(0)
      const [d] = await decisionsFor(P, 'activation', subjectId)
      expect(d!.candidates.find((c) => c.actionId === 'connect-shopify')!.blockedBy).toBe('ineligible')
      expect(d!.sendIds).toEqual([])
      expect(err.mock.calls.flat().join(' ')).toMatch(/activation.*connect-shopify-1/)
    } finally {
      err.mockRestore()
      await col().templates.replaceOne({ slug: 'connect-shopify-1' }, original)
    }
  })
})

describe('1c. template write paths protect program templates', () => {
  const BODY_HTML =
    '<p>Hello there. This paragraph is long enough to count as real body copy for the linter, which wants more than a stub.</p>' +
    '<a href="https://example.com/start">Start</a> <a href="{{unsubscribeUrl}}">Unsubscribe</a><p>{{senderAddress}}</p>'
  const doc = {
    name: 'x', description: '', kind: 'marketing', category: CATEGORY, fromName: 'Q', fromEmail: 'hello@example.com',
    subject: 'Hi', preheader: 'pre', body: { mjml: '', editorJson: null, html: BODY_HTML, plainText: '' },
  }

  it('admin PATCH: kind away from marketing → 409 naming the program', async () => {
    const res = await json('PATCH', '/api/templates/connect-shopify-1/draft', { kind: 'transactional' })
    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/activation/)
  })
  it('admin PATCH: category change → 409; same category passes', async () => {
    const bad = await json('PATCH', '/api/templates/connect-shopify-1/draft', { category: OTHER })
    expect(bad.status).toBe(409)
    expect((await col().templates.findOne({ slug: 'connect-shopify-1' }))!.category).toBe(CATEGORY)
    const ok = await json('PATCH', '/api/templates/connect-shopify-1/draft', { category: CATEGORY, notes: 'n' })
    expect(ok.status).toBe(200)
  })
  it('admin publish with a different category → 409', async () => {
    await col().templates.updateOne({ slug: 'connect-shopify-1' }, { $set: { draft: { subject: 'S', preheader: '', mjml: '', html: BODY_HTML, editorJson: null, notes: '', lastModifiedBy: 'x', lastModifiedAt: new Date() } } })
    const res = await json('POST', '/api/templates/connect-shopify-1/publish', { category: OTHER })
    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/activation/)
    await col().templates.updateOne({ slug: 'connect-shopify-1' }, { $set: { draft: null } })
  })
  it('agent PUT: dropping the category or going transactional → 409', async () => {
    const { category: _c, ...noCat } = doc
    expect((await json('PUT', '/templates/connect-shopify-1', noCat)).status).toBe(409)
    expect((await json('PUT', '/templates/connect-shopify-1', { ...noCat, kind: 'transactional' })).status).toBe(409)
    expect((await col().templates.findOne({ slug: 'connect-shopify-1' }))!.category).toBe(CATEGORY)
    expect((await json('PUT', '/templates/connect-shopify-1', doc)).status).toBe(200)
  })
  it('a template no program references can change freely', async () => {
    await P.H.seedTemplate({ slug: 'free-tpl', kind: 'marketing', category: CATEGORY, subject: 'F' })
    const res = await json('PATCH', '/api/templates/free-tpl/draft', { category: OTHER })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 2. Preference page vs a global opt-out
// ---------------------------------------------------------------------------

describe('2. Save never erases a global opt-out', () => {
  it('the page shows a notice and a resubscribe button when globally opted out', async () => {
    await seedRow('gp1@example.com', 'marketing')
    const out = await page(`/unsub/${token('gp1@example.com', CATEGORY)}`)
    expect(out.body).toContain("You're unsubscribed from all marketing email")
    expect(out.body).toContain('value="resubscribe"')
    expect(out.body).toContain('Resubscribe to the topics below')
    expect(out.body).not.toContain('disabled')
    const normal = await page(`/unsub/${token('gp2@example.com', CATEGORY)}`)
    expect(normal.body).not.toContain('value="resubscribe"')
    expect(normal.body).not.toContain("You're unsubscribed from all")
  })

  it('save keeps marketing and all opt-outs and still writes category opt-outs', async () => {
    const e = 'gp3@example.com'
    await seedRow(e, 'marketing')
    await seedRow(e, 'all')
    const res = await form(`/unsub/${token(e, CATEGORY)}/preferences`, [['action', 'save'], ['category', CATEGORY]])
    expect(res.status).toBe(200)
    expect(await scopes(e)).toEqual(['all/unsubscribed', `category:${OTHER}/unsubscribed`, 'marketing/unsubscribed'])
  })

  it('resubscribe clears the marketing-wide opt-outs', async () => {
    const e = 'gp4@example.com'
    await seedRow(e, 'marketing')
    await seedRow(e, 'all')
    await form(`/unsub/${token(e, CATEGORY)}/preferences`, [['action', 'resubscribe'], ['category', CATEGORY], ['category', OTHER]])
    expect(await scopes(e)).toEqual([])
  })

  it('resubscribe with Mongo down journals its opt-outs and answers 503', async () => {
    const e = 'gp5@example.com'
    breakMongo()
    const res = await form(`/unsub/${token(e, CATEGORY)}/preferences`, [['action', 'resubscribe'], ['category', CATEGORY]])
    expect(res.status).toBe(503)
    expect(readClaim(journal).entries.map((x) => x.scope)).toContain(`category:${OTHER}`)
    restoreMongo()
    await drainPendingUnsubscribes(P.H.ctx)
    expect(await scopes(e)).toEqual([`category:${OTHER}/unsubscribed`])
  })
})

// ---------------------------------------------------------------------------
// 4. Lenient opt-out addresses
// ---------------------------------------------------------------------------

describe('4. an opt-out is never lost to address validation', () => {
  const odd = 'a&b@example.com'

  it('one-click for a&b@example.com → 200 and a suppression row', async () => {
    const res = await form(`/unsub/${token(odd, CATEGORY)}`, [['List-Unsubscribe', 'One-Click']])
    expect(res.status).toBe(200)
    expect(await scopes(odd)).toEqual([`category:${CATEGORY}/unsubscribed`])
  })

  it('Mongo down: journaled, and the drain replays it', async () => {
    const e = 'x&y@example.com'
    breakMongo()
    const res = await form(`/unsub/${token(e)}`, [['List-Unsubscribe', 'One-Click']])
    expect(res.status).toBe(200)
    expect(readClaim(journal).entries.map((x) => x.email)).toEqual([e])
    restoreMongo()
    await drainPendingUnsubscribes(P.H.ctx)
    expect(await scopes(e)).toEqual(['marketing/unsubscribed'])
  })

  it('an unusable address is a 400, never a successful unsubscribe, and is not journaled', async () => {
    fs.rmSync(journal, { force: true })
    const res = await form(`/unsub/${token('not an address')}`, [['List-Unsubscribe', 'One-Click']])
    expect(res.status).toBe(400)
    expect(res.body).not.toMatch(/You are unsubscribed/)
    expect(fs.existsSync(journal)).toBe(false)
  })

  it('mailer.unsubscribe / suppress accept the address; emailSchema stays strict', async () => {
    await P.H.mailer.unsubscribe('P&Q@Example.com', { scope: 'marketing', reason: 'user_request', source: 'api' })
    await P.H.mailer.suppress('p&q2@example.com', { scope: 'marketing', reason: 'manual', source: 'api' })
    expect(await scopes('p&q@example.com')).toEqual(['marketing/unsubscribed'])
    expect(await scopes('p&q2@example.com')).toEqual(['marketing/manual'])
    const { emailSchema } = await import('../../src/shared/schemas.js')
    expect(emailSchema.safeParse(odd).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. forgetSubject
// ---------------------------------------------------------------------------

describe('5. forgetSubject', () => {
  it('deletes the subject’s runs and decisions only, and audits', async () => {
    startClock()
    const a = await subject(P)
    const b = await subject(P)
    for (const s of [a, b]) {
      await enter(P, 'activation', s.subjectId)
      await tickProgram(P.H.ctx, 'activation', s.subjectId)
    }
    expect((await decisionsFor(P, 'activation', a.subjectId)).length).toBeGreaterThan(0)
    const res = await P.H.mailer.forgetSubject(a.subjectId)
    expect(res.runs).toBe(1)
    expect(res.decisions).toBeGreaterThan(0)
    expect(await getRun(P, 'activation', a.subjectId)).toBeNull()
    expect(await decisionsFor(P, 'activation', a.subjectId)).toHaveLength(0)
    expect(await getRun(P, 'activation', b.subjectId)).not.toBeNull()
    expect((await decisionsFor(P, 'activation', b.subjectId)).length).toBeGreaterThan(0)
    expect(await col().auditLog.findOne({ action: 'gdpr.forget_subject' })).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 6. Plain page wording
// ---------------------------------------------------------------------------

describe('6. plain unsubscribe page (no categories)', () => {
  it('says "these emails" for a categorised token and keeps the 0.20 wording otherwise', async () => {
    const plain = await createTestMailer()
    try {
      const url = await listen(express().use('/m', createPublicRouter(plain.mailer, { logger: quiet })))
      const tok = (c?: string) =>
        signUnsubscribeToken({ email: 'z@example.com', scope: 'marketing', ...(c ? { category: c } : {}), expiresAt: new Date(Date.now() + 86_400_000) }, plain.mailer.config.unsubscribeSecret)
      const withC = await (await fetch(`${url}/m/unsub/${tok('lifecycle.onboarding')}`)).text()
      expect(withC).toContain('from these emails')
      expect(withC).not.toContain('from marketing emails')
      const without = await (await fetch(`${url}/m/unsub/${tok()}`)).text()
      expect(without).toContain('from marketing emails')
    } finally {
      await plain.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Agent preview signs with the template category
// ---------------------------------------------------------------------------

describe('7. agent render', () => {
  it('signs the unsubscribe URL with the template’s category', async () => {
    await P.H.seedContact({ externalId: 'tc1', email: 'qa@test.example', tags: [], fields: {} })
    await P.H.seedTemplate({ slug: 'cat-preview', kind: 'marketing', category: CATEGORY, subject: 'C' })
    await P.H.seedTemplate({ slug: 'nocat-preview', kind: 'marketing', subject: 'N' })
    const withCat = await json('POST', '/templates/cat-preview/render', { contactId: 'tc1' })
    const tokenOf = (u: string) => verifyUnsubscribeToken(u.split('/m/unsub/')[1]!, P.H.mailer.config.unsubscribeSecret)!
    expect(tokenOf(withCat.body.unsubscribeUrl).category).toBe(CATEGORY)
    const noCat = await json('POST', '/templates/nocat-preview/render', { contactId: 'tc1' })
    expect(tokenOf(noCat.body.unsubscribeUrl).category).toBeUndefined()
  })
})

void dispatchSend
