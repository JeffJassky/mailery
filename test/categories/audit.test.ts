/**
 * Category/preference cases added by the PR 1 untested-surface audit:
 * rows the recipient did not write survive a save, idempotent opt-outs,
 * template category rule, circuit breaker keys on kind, undeclared token
 * categories, unconfigured routes, journal replay after a failed save.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ObjectId } from 'mongodb'

import { createPublicRouter } from '../../src/server/api/public.js'
import { drainPendingUnsubscribes } from '../../src/server/runner/pending-unsubs.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { templateCategoryIssue } from '../../src/server/templates/category.js'
import { healthBucketId } from '../../src/server/models/index.js'
import { sha256Hex, signUnsubscribeToken } from '../../src/server/tokens.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

const C = 'lifecycle.onboarding'
const P = 'product.updates'
const CATS = [{ id: C, label: 'Tips' }, { id: P, label: 'Updates' }]
const quiet = { error: () => {}, warn: () => {}, info: () => {} }

let H: TestMailerHarness
let dir: string
const servers: Array<ReturnType<express.Express['listen']>> = []

beforeAll(async () => {
  H = await createTestMailer({ config: { categories: CATS } })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailery-audit-'))
  ;(H.mailer.config as any).pendingUnsubsPath = path.join(dir, 'j.jsonl')
}, 120_000)

afterAll(async () => {
  for (const s of servers) s.close()
  fs.rmSync(dir, { recursive: true, force: true })
  if (H) await H.stop()
})

afterEach(async () => {
  await H.mailer.collections.suppressions.deleteMany({})
})

async function mount(h: TestMailerHarness = H): Promise<string> {
  const app = express()
  app.use('/m', createPublicRouter(h.mailer, { logger: quiet }))
  const server = app.listen(0)
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function post(base: string, p: string, form: Array<[string, string]> = []): Promise<{ status: number; body: string }> {
  const payload = new URLSearchParams(form).toString()
  return new Promise((resolve, reject) => {
    const req = request(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}
function get(base: string, p: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    request(`${base}${p}`, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
    }).on('error', reject).end()
  })
}

const token = (email: string, category?: string, secret = H.mailer.config.unsubscribeSecret) =>
  signUnsubscribeToken({ email, scope: 'marketing', ...(category ? { category } : {}), expiresAt: new Date(Date.now() + 86_400_000) }, secret)

async function row(email: string, scope: string, reason: string, hashedOnly = false) {
  await H.mailer.collections.suppressions.insertOne({
    email: hashedOnly ? null : email, emailHash: sha256Hex(email), scope: scope as any, reason: reason as any,
    source: 'test', notes: null, addedAt: new Date(), expiresAt: null,
  })
}
const scopes = async (email: string) =>
  (await H.mailer.collections.suppressions.find({ emailHash: sha256Hex(email) }).toArray()).map((r) => `${r.scope}/${r.reason}`).sort()

describe('a save never deletes rows the recipient did not write', () => {
  it('complaint, manual and GDPR rows at marketing/all survive save and setPreferences', async () => {
    const e = 'keep@example.com'
    await row(e, 'marketing', 'complaint')
    await row(e, 'all', 'manual')
    await row(e, 'all', 'gdpr_forget', true)
    const base = await mount()
    await post(base, `/m/unsub/${token(e, C)}/preferences`, [['action', 'save'], ['category', C], ['category', P]])
    await H.mailer.setPreferences(e, { marketing: true })
    expect(await scopes(e)).toEqual(['all/gdpr_forget', 'all/manual', 'marketing/complaint'])
    expect((await H.mailer.getPreferences(e)).marketing).toBe(false)
  })

  it('an all-scope unsubscribe row is kept by save and cleared by resubscribe', async () => {
    const e = 'allunsub@example.com'
    await row(e, 'all', 'unsubscribed')
    const base = await mount()
    await post(base, `/m/unsub/${token(e, C)}/preferences`, [['action', 'save'], ['category', C], ['category', P]])
    expect(await scopes(e)).toEqual(['all/unsubscribed'])
    await post(base, `/m/unsub/${token(e, C)}/preferences`, [['action', 'resubscribe'], ['category', C], ['category', P]])
    expect(await scopes(e)).toEqual([])
  })
})

describe('opt-outs are idempotent', () => {
  it('repeated one-click, repeated unsubscribe, and save over an existing opt-out → one row, no 5xx', async () => {
    const e = 'twice@example.com'
    const base = await mount()
    for (let i = 0; i < 2; i++) {
      expect((await post(base, `/m/unsub/${token(e, C)}`, [['List-Unsubscribe', 'One-Click']])).status).toBe(200)
      await H.mailer.unsubscribe(e, { scope: `category:${C}`, reason: 'user_request', source: 'api' })
      expect((await post(base, `/m/unsub/${token(e, C)}/preferences`, [['action', 'save'], ['category', P]])).status).toBe(200)
    }
    expect(await scopes(e)).toEqual([`category:${C}/unsubscribed`])
  })
})

describe('template category rule', () => {
  it('templateCategoryIssue', () => {
    expect(templateCategoryIssue('marketing', null, CATS)).toBeNull()
    expect(templateCategoryIssue('marketing', C, CATS)).toBeNull()
    expect(templateCategoryIssue('marketing', 'nope', CATS)).toMatch(/not declared/)
    expect(templateCategoryIssue('marketing', C, undefined)).toMatch(/not declared/)
    expect(templateCategoryIssue('transactional', C, CATS)).toMatch(/transactional/)
    expect(templateCategoryIssue('transactional', null, CATS)).toBeNull()
  })
})

describe('undeclared categories', () => {
  it('a token whose category is no longer declared: page renders, one-click still opts out of that category', async () => {
    const e = 'gone-cat@example.com'
    const base = await mount()
    const t = token(e, 'retired.category')
    expect((await get(base, `/m/unsub/${t}`)).status).toBe(200)
    expect((await post(base, `/m/unsub/${t}`, [['List-Unsubscribe', 'One-Click']])).status).toBe(200)
    expect(await scopes(e)).toEqual(['category:retired.category/unsubscribed'])
  })

  it('unsubscribe with an undeclared category scope is still honoured (an opt-out is never refused)', async () => {
    await H.mailer.unsubscribe('u@example.com', { scope: 'category:old.one', reason: 'user_request', source: 'api' })
    expect(await scopes('u@example.com')).toEqual(['category:old.one/unsubscribed'])
  })
})

describe('without categories configured', () => {
  it('POST /unsub/:token/preferences is not mounted (404) and writes nothing', async () => {
    const plain = await createTestMailer()
    try {
      const base = await mount(plain)
      const t = token('x@example.com', undefined, plain.mailer.config.unsubscribeSecret)
      const res = await post(base, `/m/unsub/${t}/preferences`, [['action', 'unsubscribe-all']])
      expect(res.status).toBe(404)
      expect(await plain.mailer.collections.suppressions.countDocuments({})).toBe(0)
    } finally {
      await plain.stop()
    }
  }, 120_000)
})

describe('journal replay after a failed save', () => {
  it('opt-outs journaled by a 503 save are applied by the drain', async () => {
    const e = 'replay-save@example.com'
    const base = await mount()
    const coll = H.mailer.collections.suppressions as any
    const up = coll.updateOne.bind(coll)
    const del = coll.deleteMany.bind(coll)
    coll.updateOne = () => Promise.reject(new Error('down'))
    coll.deleteMany = () => Promise.reject(new Error('down'))
    try {
      expect((await post(base, `/m/unsub/${token(e, C)}/preferences`, [['action', 'save'], ['category', C]])).status).toBe(503)
    } finally {
      coll.updateOne = up
      coll.deleteMany = del
    }
    await drainPendingUnsubscribes(H.ctx)
    expect(await scopes(e)).toEqual([`category:${P}/unsubscribed`])
  })
})

describe('circuit breaker keys on kind, not category (§3.3)', () => {
  it('tripped marketing bucket holds categorised and uncategorised marketing; transactional goes', async () => {
    await H.seedContact({ externalId: 'cb', email: 'cb@example.com', tags: [], fields: {} })
    await H.seedTemplate({ slug: 'cb-cat', kind: 'marketing', category: C })
    await H.seedTemplate({ slug: 'cb-plain', kind: 'marketing' })
    await H.seedTemplate({ slug: 'cb-tx', kind: 'transactional' })
    await H.mailer.collections.health.updateOne(
      { _id: healthBucketId('example.com', 'marketing') },
      { $set: { senderDomain: 'example.com', kind: 'marketing', status: 'tripped', trippedAt: new Date(), trippedReason: 'test', updatedAt: new Date() } },
      { upsert: true },
    )
    const out: Record<string, string> = {}
    for (const slug of ['cb-cat', 'cb-plain', 'cb-tx']) {
      await H.mailer.sendOneOff({ templateSlug: slug, externalId: 'cb', dedupeKey: slug })
      const r = await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:${slug}` })
      await dispatchSend(r!._id as ObjectId, H.ctx)
      out[slug] = (await H.mailer.collections.sends.findOne({ _id: r!._id }))!.status
    }
    expect(out).toEqual({ 'cb-cat': 'queued', 'cb-plain': 'queued', 'cb-tx': 'sent' })
  })
})
