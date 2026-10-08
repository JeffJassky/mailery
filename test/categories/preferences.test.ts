/**
 * The preference page and the preference API (0.21), INVARIANTS 8 and 22.
 *
 * Form contract for `POST /unsub/:token/preferences` (urlencoded):
 *   action=save            + `category=<id>` once per CHECKED category.
 *                          Unchecked declared categories are opted out,
 *                          checked ones opted back in. Never clears a
 *                          marketing-wide (`marketing`/`all`) opt-out.
 *   action=resubscribe     as save, and also clears the marketing/all opt-out
 *                          (the only action that does).
 *   action=unsubscribe-all  marketing opt-out; categories ignored.
 *
 * Durability mirrors one-click (INVARIANT 8): opt-outs that cannot reach
 * Mongo are journaled. `unsubscribe-all` is a pure opt-out, so a journaled
 * write answers 200 exactly like one-click. `save` may also contain opt-ins,
 * which cannot be journaled, so a failed save answers 503 — after journaling
 * its opt-outs — rather than claim the page was saved.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createPublicRouter } from '../../src/server/api/public.js'
import { drainPendingUnsubscribes } from '../../src/server/runner/pending-unsubs.js'
import { signUnsubscribeToken } from '../../src/server/tokens.js'
import { readClaim } from '../../src/server/unsub-journal.js'
import { sha256Hex } from '../../src/server/tokens.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

const C = 'lifecycle.onboarding'
const P = 'product.updates'
const W = 'insights.weekly'

let H: TestMailerHarness
let dir: string
let journal: string
const servers: Array<ReturnType<express.Express['listen']>> = []
const quiet = { error: () => {}, warn: () => {}, info: () => {} }

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      categories: [
        { id: C, label: 'Getting-started tips', description: 'Help setting up your account' },
        { id: P, label: 'Product updates' },
        { id: W, label: 'Weekly insights' },
      ],
    },
  })
  await H.seedContact({ externalId: 'u1', email: 'alice@example.com', tags: [], fields: {} })
}, 120_000)

afterAll(async () => {
  for (const s of servers) s.close()
  if (H) await H.stop()
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailery-prefs-'))
  journal = path.join(dir, 'pending-unsubs.jsonl')
  ;(H.mailer.config as any).pendingUnsubsPath = journal
})

afterEach(async () => {
  restoreMongo()
  fs.rmSync(dir, { recursive: true, force: true })
  await H.mailer.collections.suppressions.deleteMany({})
})

// --- helpers ---------------------------------------------------------------

let originalUpdateOne: any = null
let originalDeleteMany: any = null
function breakMongo() {
  const coll = H.mailer.collections.suppressions as any
  originalUpdateOne ??= coll.updateOne.bind(coll)
  originalDeleteMany ??= coll.deleteMany.bind(coll)
  coll.updateOne = () => Promise.reject(new Error('MongoServerSelectionError: no primary'))
  coll.deleteMany = () => Promise.reject(new Error('MongoServerSelectionError: no primary'))
}
function restoreMongo() {
  const coll = H.mailer.collections.suppressions as any
  if (originalUpdateOne) coll.updateOne = originalUpdateOne
  if (originalDeleteMany) coll.deleteMany = originalDeleteMany
  originalUpdateOne = null
  originalDeleteMany = null
}

async function mount(): Promise<string> {
  const app = express()
  app.use('/m', createPublicRouter(H.mailer, { logger: quiet }))
  const server = app.listen(0)
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function http(
  base: string,
  method: 'GET' | 'POST',
  p: string,
  form?: Array<[string, string]>,
): Promise<{ status: number; body: string }> {
  const payload = form ? new URLSearchParams(form).toString() : ''
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}${p}`,
      {
        method,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

function token(email: string, category?: string): string {
  return signUnsubscribeToken(
    { email, scope: 'marketing', ...(category ? { category } : {}), expiresAt: new Date(Date.now() + 86_400_000) },
    H.mailer.config.unsubscribeSecret,
  )
}

const rows = (email: string) =>
  H.mailer.collections.suppressions.find({ email }).project({ _id: 0, scope: 1, reason: 1, source: 1 }).toArray()

async function optOut(email: string, scope: string, reason: 'unsubscribed' | 'manual' = 'unsubscribed') {
  await H.mailer.collections.suppressions.insertOne({
    email,
    emailHash: sha256Hex(email),
    scope: scope as any,
    reason,
    source: 'test',
    notes: null,
    addedAt: new Date(),
    expiresAt: null,
  })
}

// --- API -------------------------------------------------------------------

describe('mailer.getPreferences', () => {
  it('everything on by default; transactional never listed', async () => {
    const prefs = await H.mailer.getPreferences('fresh@example.com')
    expect(prefs).toEqual({ marketing: true, categories: { [C]: true, [P]: true, [W]: true } })
    expect(JSON.stringify(prefs)).not.toContain('transactional')
  })

  it('reflects a category opt-out', async () => {
    await optOut('cat@example.com', `category:${P}`)
    expect(await H.mailer.getPreferences('cat@example.com')).toEqual({
      marketing: true,
      categories: { [C]: true, [P]: false, [W]: true },
    })
  })

  it('a marketing or all opt-out turns every category off', async () => {
    await optOut('mkt@example.com', 'marketing')
    await optOut('all@example.com', 'all')
    for (const email of ['mkt@example.com', 'all@example.com']) {
      const prefs = await H.mailer.getPreferences(email)
      expect(prefs.marketing).toBe(false)
      expect(Object.values(prefs.categories).every((v) => v === false)).toBe(true)
    }
  })

  it('a hashed (GDPR) all row reads as opted out', async () => {
    await H.mailer.collections.suppressions.insertOne({
      email: null,
      emailHash: sha256Hex('gone@example.com'),
      scope: 'all',
      reason: 'gdpr_forget',
      source: 'gdpr_request',
      notes: null,
      addedAt: new Date(),
      expiresAt: null,
    })
    expect((await H.mailer.getPreferences('gone@example.com')).marketing).toBe(false)
  })

  it('is case-insensitive on the address', async () => {
    await optOut('mixed@example.com', `category:${C}`)
    expect((await H.mailer.getPreferences('Mixed@Example.com')).categories[C]).toBe(false)
  })
})

describe('mailer.setPreferences', () => {
  it('category off writes a category:<id> row with the given source', async () => {
    await H.mailer.setPreferences('s1@example.com', { categories: { [P]: false } }, { source: 'settings' })
    expect(await rows('s1@example.com')).toEqual([{ scope: `category:${P}`, reason: 'unsubscribed', source: 'settings' }])
  })

  it('category on deletes only the unsubscribed row for that category', async () => {
    await optOut('s2@example.com', `category:${P}`)
    await optOut('s2@example.com', `category:${W}`)
    await H.mailer.setPreferences('s2@example.com', { categories: { [P]: true } })
    expect((await rows('s2@example.com')).map((r) => r.scope)).toEqual([`category:${W}`])
  })

  it('opting in never deletes a row the recipient did not write (manual, bounce, GDPR)', async () => {
    await optOut('s3@example.com', `category:${P}`, 'manual')
    await H.mailer.setPreferences('s3@example.com', { categories: { [P]: true } })
    expect(await rows('s3@example.com')).toHaveLength(1)
  })

  it('marketing:false writes a marketing opt-out and ignores categories', async () => {
    await H.mailer.setPreferences('s4@example.com', { marketing: false, categories: { [P]: true } })
    expect((await rows('s4@example.com')).map((r) => r.scope)).toEqual(['marketing'])
  })

  it('marketing:true clears marketing opt-outs written by unsubscribes', async () => {
    await optOut('s5@example.com', 'marketing')
    await H.mailer.setPreferences('s5@example.com', { marketing: true })
    expect(await rows('s5@example.com')).toEqual([])
  })

  it('an undeclared category is rejected and nothing is written', async () => {
    await expect(H.mailer.setPreferences('s6@example.com', { categories: { 'not.declared': false } })).rejects.toThrow()
    expect(await rows('s6@example.com')).toEqual([])
  })

  it('a category opt-out does not touch the subscription status', async () => {
    await H.mailer.setPreferences('alice@example.com', { categories: { [C]: false } })
    const sub = await H.mailer.collections.subscriptions.findOne({ externalId: 'u1' })
    expect(sub?.status).toBe('subscribed')
  })

  it('mailer.unsubscribe accepts a category scope', async () => {
    await H.mailer.unsubscribe('s7@example.com', { scope: `category:${C}`, reason: 'user_request', source: 'api' })
    expect((await rows('s7@example.com')).map((r) => r.scope)).toEqual([`category:${C}`])
  })

  it('mailer.resubscribe accepts a category scope and clears only that category', async () => {
    await optOut('alice@example.com', `category:${P}`)
    await optOut('alice@example.com', `category:${W}`)
    const res = await H.mailer.resubscribe({ externalId: 'u1', scope: `category:${P}`, source: 'test' })
    expect(res.removedSuppressions).toBe(1)
    expect((await rows('alice@example.com')).map((r) => r.scope)).toEqual([`category:${W}`])
  })
})

// --- page ------------------------------------------------------------------

describe('GET /unsub/:token — preference page', () => {
  it('lists every declared category with its current state', async () => {
    await optOut('page@example.com', `category:${P}`)
    const base = await mount()
    const res = await http(base, 'GET', `/m/unsub/${token('page@example.com', C)}`)
    expect(res.status).toBe(200)
    for (const label of ['Getting-started tips', 'Product updates', 'Weekly insights']) expect(res.body).toContain(label)
    expect(res.body).toContain('Help setting up your account')
    // One checkbox per category, checked iff opted in.
    for (const id of [C, W]) expect(res.body).toMatch(new RegExp(`value="${id.replace('.', '\\.')}"[^>]*checked`))
    expect(res.body).not.toMatch(new RegExp(`value="${P.replace('.', '\\.')}"[^>]*checked`))
  })

  it('has a separate unsubscribe-from-all-marketing action and posts to /preferences', async () => {
    const base = await mount()
    const t = token('page2@example.com', C)
    const res = await http(base, 'GET', `/m/unsub/${t}`)
    expect(res.body).toContain(`/unsub/${t}/preferences`)
    expect(res.body).toContain('value="unsubscribe-all"')
    expect(res.body).toContain('value="save"')
  })

  it('never mentions transactional mail', async () => {
    const base = await mount()
    const res = await http(base, 'GET', `/m/unsub/${token('page3@example.com', C)}`)
    expect(res.body.toLowerCase()).not.toContain('transactional')
  })

  it('an old token (no category) also gets the preference page', async () => {
    const base = await mount()
    const res = await http(base, 'GET', `/m/unsub/${token('page4@example.com')}`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('Weekly insights')
  })

  it('escapes the address', async () => {
    const base = await mount()
    const res = await http(base, 'GET', `/m/unsub/${token('a<b>@example.com', C)}`)
    expect(res.body).not.toContain('a<b>@example.com')
  })

  it('an expired token gets the existing error page', async () => {
    const base = await mount()
    const expired = signUnsubscribeToken(
      { email: 'x@example.com', scope: 'marketing', category: C, expiresAt: new Date(Date.now() - 1000) },
      H.mailer.config.unsubscribeSecret,
    )
    const res = await http(base, 'GET', `/m/unsub/${expired}`)
    expect(res.body).toContain('Invalid or expired link')
  })
})

describe('POST /unsub/:token/preferences', () => {
  it('save: unchecked categories opted out, checked opted in, source "preferences"', async () => {
    await optOut('form@example.com', `category:${C}`)
    const base = await mount()
    const res = await http(base, 'POST', `/m/unsub/${token('form@example.com', C)}/preferences`, [
      ['action', 'save'],
      ['category', C],
      ['category', W],
    ])
    expect(res.status).toBe(200)
    expect(await rows('form@example.com')).toEqual([{ scope: `category:${P}`, reason: 'unsubscribed', source: 'preferences' }])
  })

  it('resubscribe clears a previous marketing-wide unsubscribe', async () => {
    await optOut('back@example.com', 'marketing')
    const base = await mount()
    await http(base, 'POST', `/m/unsub/${token('back@example.com')}/preferences`, [
      ['action', 'resubscribe'],
      ['category', C],
      ['category', P],
      ['category', W],
    ])
    expect(await rows('back@example.com')).toEqual([])
  })

  it('unsubscribe-all writes a marketing opt-out', async () => {
    const base = await mount()
    const res = await http(base, 'POST', `/m/unsub/${token('all@example.com', C)}/preferences`, [['action', 'unsubscribe-all']])
    expect(res.status).toBe(200)
    expect((await rows('all@example.com')).map((r) => r.scope)).toEqual(['marketing'])
  })

  it('an unknown category in the form is ignored, not written', async () => {
    const base = await mount()
    await http(base, 'POST', `/m/unsub/${token('junk@example.com', C)}/preferences`, [
      ['action', 'save'],
      ['category', 'evil.scope'],
      ['category', C],
      ['category', P],
      ['category', W],
    ])
    expect(await rows('junk@example.com')).toEqual([])
  })

  it('an invalid token writes nothing', async () => {
    const base = await mount()
    const res = await http(base, 'POST', `/m/unsub/garbage.token/preferences`, [['action', 'unsubscribe-all']])
    expect(res.status).toBeLessThan(500)
    expect(await H.mailer.collections.suppressions.countDocuments({})).toBe(0)
  })

  describe('Mongo down (INVARIANT 8)', () => {
    it('unsubscribe-all journals and answers 200', async () => {
      const base = await mount()
      breakMongo()
      const res = await http(base, 'POST', `/m/unsub/${token('down@example.com', C)}/preferences`, [['action', 'unsubscribe-all']])
      expect(res.status).toBe(200)
      expect(readClaim(journal).entries).toEqual([{ email: 'down@example.com', scope: 'marketing', at: expect.any(Number) }])
    })

    it('save journals its opt-outs and answers 503 instead of claiming success', async () => {
      const base = await mount()
      breakMongo()
      const res = await http(base, 'POST', `/m/unsub/${token('half@example.com', C)}/preferences`, [
        ['action', 'save'],
        ['category', C],
      ])
      expect(res.status).toBe(503)
      expect(res.body.toLowerCase()).not.toContain('saved')
      const scopes = readClaim(journal).entries.map((e) => e.scope).sort()
      expect(scopes).toEqual([`category:${W}`, `category:${P}`].sort())
    })

    it('answers 503 when no journal is configured', async () => {
      ;(H.mailer.config as any).pendingUnsubsPath = undefined
      const base = await mount()
      breakMongo()
      const res = await http(base, 'POST', `/m/unsub/${token('nojournal@example.com', C)}/preferences`, [['action', 'unsubscribe-all']])
      expect(res.status).toBe(503)
    })
  })
})

describe('one-click POST /unsub/:token on categorised mail', () => {
  it('opts out of the category only, durably before 200', async () => {
    const base = await mount()
    const res = await http(base, 'POST', `/m/unsub/${token('oneclick@example.com', C)}`, [['List-Unsubscribe', 'One-Click']])
    expect(res.status).toBe(200)
    expect(await rows('oneclick@example.com')).toEqual([{ scope: `category:${C}`, reason: 'unsubscribed', source: 'one-click' }])
  })

  it('an old token still opts out of all marketing', async () => {
    const base = await mount()
    await http(base, 'POST', `/m/unsub/${token('oldclick@example.com')}`, [['List-Unsubscribe', 'One-Click']])
    expect((await rows('oldclick@example.com')).map((r) => r.scope)).toEqual(['marketing'])
  })

  it('Mongo down: journals the category scope and the drain replays it', async () => {
    const base = await mount()
    breakMongo()
    const res = await http(base, 'POST', `/m/unsub/${token('replay@example.com', C)}`, [['List-Unsubscribe', 'One-Click']])
    expect(res.status).toBe(200)
    restoreMongo()
    await drainPendingUnsubscribes(H.ctx)
    expect((await rows('replay@example.com')).map((r) => r.scope)).toEqual([`category:${C}`])
  })
})

describe('without categories configured', () => {
  it('GET /unsub/:token is the 0.20 confirmation page', async () => {
    const plain = await createTestMailer()
    try {
      const app = express()
      app.use('/m', createPublicRouter(plain.mailer, { logger: quiet }))
      const server = app.listen(0)
      servers.push(server)
      await new Promise<void>((r) => server.once('listening', r))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const t = signUnsubscribeToken(
        { email: 'z@example.com', scope: 'marketing', expiresAt: new Date(Date.now() + 86_400_000) },
        plain.mailer.config.unsubscribeSecret,
      )
      const res = await http(base, 'GET', `/m/unsub/${t}`)
      expect(res.body).toContain('Confirm unsubscribe')
      expect(res.body).not.toContain('/preferences')
    } finally {
      await plain.stop()
    }
  }, 120_000)
})
