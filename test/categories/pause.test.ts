/**
 * Pause — plans/17-cadence-controls.md F3.
 *
 * A pause is one `marketing_pause` suppression row (reason 'paused') with an
 * `expiresAt`. It blocks every marketing send — categorised or not, from any
 * origin — and nothing transactional, through the ordinary suppression check
 * (INVARIANT 3); it is never journaled and never an unsubscribe (INVARIANT 8).
 *
 * Preference page (mounted only when categories are declared):
 *   GET                       "Take a break" with one button per configured
 *                             length (`name="pause" value="<days>"`); when
 *                             paused, a notice "Paused until <Month D, YYYY>."
 *                             and a Resume now button instead
 *   POST pause=<days>         200 "Paused until <date>. You'll get no marketing
 *                             email until then." · 400 for an unconfigured
 *                             length · 503 + Retry-After when Mongo is down
 *   POST action=resume        200 "Your emails will resume."
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createPublicRouter } from '../../src/server/api/public.js'
import { blockingScopes, isSuppressed, suppressedEmails } from '../../src/server/runner/suppression.js'
import { signUnsubscribeToken, sha256Hex } from '../../src/server/tokens.js'
import { clearUnsubscribeSuppressions } from '../../src/server/unsubscribe.js'
import { assertValidPreferences, PREFERENCES_DEFAULTS } from '../../src/server/config.js'
import { createTestMailer, tickProgram, type TestMailerHarness } from '../../src/testing/index.js'
import { advance, DAY, freezeAt, restoreClock } from '../matrix/clock.js'
import { activation, enter, getRun, programHarness, seedProgramWithTemplates, startClock, subject, type ProgramHarness } from '../programs/helpers.js'

const C = 'lifecycle.onboarding'
const P_CAT = 'product.updates'
const CATEGORIES = [
  { id: C, label: 'Getting-started tips' },
  { id: P_CAT, label: 'Product updates' },
]
const quiet = { error: () => {}, warn: () => {}, info: () => {} }
const AGENT_TOKEN = 'agent-test-token-0123456789abcdef'

let H: TestMailerHarness
const servers: Array<ReturnType<express.Express['listen']>> = []

beforeAll(async () => {
  H = await createTestMailer({ config: { categories: CATEGORIES } })
  await H.seedContact({ externalId: 'u1', email: 'alice@example.com', tags: [], fields: {} })
}, 120_000)

afterAll(async () => {
  restoreClock()
  for (const s of servers) s.close()
  if (H) await H.stop()
})

afterEach(async () => {
  restoreMongo()
  restoreClock()
  await H.mailer.collections.suppressions.deleteMany({})
})

// --- helpers ---------------------------------------------------------------

const rows = (email: string) =>
  H.mailer.collections.suppressions
    .find({ $or: [{ email }, { emailHash: sha256Hex(email) }] })
    .project({ _id: 0, email: 1, scope: 1, reason: 1, source: 1, expiresAt: 1 })
    .toArray()

async function mount(harness: TestMailerHarness = H): Promise<string> {
  const app = express()
  app.use('/m', createPublicRouter(harness.mailer, { logger: quiet }))
  app.use('/agent', createAgentRouter(harness.mailer, { tokens: [{ token: AGENT_TOKEN, actor: 'agent:test' }] }))
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
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const payload = form ? new URLSearchParams(form).toString() : ''
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}${p}`,
      {
        method,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

function token(harness: TestMailerHarness, email: string): string {
  return signUnsubscribeToken(
    { email, scope: 'marketing', expiresAt: new Date(Date.now() + 86_400_000) },
    harness.mailer.config.unsubscribeSecret,
  )
}

const broken: Array<[string, any]> = []
function breakMongo() {
  const coll = H.mailer.collections.suppressions as any
  for (const m of ['updateOne', 'replaceOne', 'insertOne', 'findOneAndUpdate', 'deleteMany', 'deleteOne']) {
    broken.push([m, coll[m]])
    coll[m] = () => Promise.reject(new Error('MongoServerSelectionError: no primary'))
  }
}
function restoreMongo() {
  const coll = H.mailer.collections.suppressions as any
  for (const [m, fn] of broken) coll[m] = fn
  broken.length = 0
}

// --- config ----------------------------------------------------------------

describe('MailerConfig.preferences', () => {
  it('defaults to 1 week, 2 weeks, 1 month', () => {
    expect([...PREFERENCES_DEFAULTS.pauseDays]).toEqual([7, 14, 30])
  })
  it('accepts a custom list and an empty one', () => {
    expect(() => assertValidPreferences({ pauseDays: [3, 10, 365] })).not.toThrow()
    expect(() => assertValidPreferences({ pauseDays: [] })).not.toThrow()
    expect(() => assertValidPreferences(undefined)).not.toThrow()
    expect(() => assertValidPreferences({})).not.toThrow()
  })
  it('rejects non-integers, out-of-range values and duplicates, listing each', () => {
    expect(() => assertValidPreferences({ pauseDays: [0] })).toThrow(/pauseDays\[0\]/)
    expect(() => assertValidPreferences({ pauseDays: [366] })).toThrow(/pauseDays\[0\]/)
    expect(() => assertValidPreferences({ pauseDays: [1.5] })).toThrow(/pauseDays\[0\]/)
    expect(() => assertValidPreferences({ pauseDays: [7, 7] })).toThrow(/pauseDays\[1\].*twice/)
    expect(() => assertValidPreferences({ pauseDays: [0, 400] })).toThrow(/pauseDays\[0\][\s\S]*pauseDays\[1\]/)
    expect(() => assertValidPreferences({ pauseDays: 7 as any })).toThrow(/pauseDays/)
  })
  it('Mailer.init runs the check', async () => {
    await expect(createTestMailer({ config: { preferences: { pauseDays: [0] } } })).rejects.toThrow(/preferences is invalid/)
  }, 120_000)
})

// --- API -------------------------------------------------------------------

describe('mailer.pauseMarketing / resumeMarketing', () => {
  it('writes one marketing_pause row with an expiry; getPreferences reports it', async () => {
    const t = freezeAt('2026-10-08T12:00:00Z')
    const out = await H.mailer.pauseMarketing('Alice@Example.com', { days: 14, source: 'test' })
    expect(out.pausedUntil).toEqual(new Date(t.getTime() + 14 * DAY))
    expect(await rows('alice@example.com')).toEqual([
      { email: 'alice@example.com', scope: 'marketing_pause', reason: 'paused', source: 'test', expiresAt: new Date(t.getTime() + 14 * DAY) },
    ])
    expect(await H.mailer.getPreferences('alice@example.com')).toEqual({
      marketing: true,
      categories: { [C]: true, [P_CAT]: true },
      pausedUntil: new Date(t.getTime() + 14 * DAY),
    })
  })

  it('pausing again replaces the row', async () => {
    const t = freezeAt('2026-10-08T12:00:00Z')
    await H.mailer.pauseMarketing('alice@example.com', { days: 14, source: 'a' })
    advance(DAY)
    await H.mailer.pauseMarketing('alice@example.com', { days: 7, source: 'b' })
    const all = await rows('alice@example.com')
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ source: 'b', expiresAt: new Date(t.getTime() + 8 * DAY) })
  })

  it('rejects days outside 1–365 or not an integer', async () => {
    for (const days of [0, 366, 1.5, Number.NaN]) {
      await expect(H.mailer.pauseMarketing('alice@example.com', { days })).rejects.toThrow(/days must be an integer from 1 to 365/)
    }
    expect(await rows('alice@example.com')).toEqual([])
  })

  it('resume deletes the row and reports whether there was one', async () => {
    await H.mailer.pauseMarketing('alice@example.com', { days: 7 })
    expect(await H.mailer.resumeMarketing('ALICE@example.com')).toEqual({ resumed: true })
    expect(await rows('alice@example.com')).toEqual([])
    expect((await H.mailer.getPreferences('alice@example.com')).pausedUntil).toBeNull()
    expect(await H.mailer.resumeMarketing('alice@example.com')).toEqual({ resumed: false })
  })

  it('an expired pause is no pause', async () => {
    freezeAt('2026-10-08T12:00:00Z')
    await H.mailer.pauseMarketing('alice@example.com', { days: 2 })
    advance(2 * DAY)
    expect((await H.mailer.getPreferences('alice@example.com')).pausedUntil).toBeNull()
    expect((await isSuppressed(H.mailer.collections, 'alice@example.com', 'marketing')).suppressed).toBe(false)
  })

  it('is audited', async () => {
    await H.mailer.collections.auditLog.deleteMany({ action: { $in: ['contact.pause', 'contact.resume'] } })
    await H.mailer.pauseMarketing('alice@example.com', { days: 7, source: 'preferences' })
    await H.mailer.resumeMarketing('alice@example.com', { source: 'preferences' })
    const log = await H.mailer.collections.auditLog.find({ action: { $in: ['contact.pause', 'contact.resume'] } }).sort({ _id: 1 }).toArray()
    expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(['contact.pause', 'contact.resume']))
    expect(log.find((e) => e.action === 'contact.pause')).toMatchObject({ actor: 'host:preferences' })
  })
})

// --- suppression matrix ------------------------------------------------------

describe('a pause blocks marketing, not transactional', () => {
  it('blockingScopes lists marketing_pause for marketing only', () => {
    expect(blockingScopes('marketing')).toContain('marketing_pause')
    expect(blockingScopes('marketing', C)).toContain('marketing_pause')
    expect(blockingScopes('transactional')).not.toContain('marketing_pause')
  })

  it('isSuppressed and suppressedEmails see the pause, with its expiry', async () => {
    const t = freezeAt('2026-10-08T12:00:00Z')
    await H.mailer.pauseMarketing('alice@example.com', { days: 7 })
    const plain = await isSuppressed(H.mailer.collections, 'alice@example.com', 'marketing')
    expect(plain).toMatchObject({ suppressed: true, scope: 'marketing_pause', reason: 'paused', expiresAt: new Date(t.getTime() + 7 * DAY) })
    expect((await isSuppressed(H.mailer.collections, 'alice@example.com', 'marketing', C)).suppressed).toBe(true)
    expect((await isSuppressed(H.mailer.collections, 'alice@example.com', 'transactional')).suppressed).toBe(false)
    expect(await suppressedEmails(H.mailer.collections, ['alice@example.com', 'bob@example.com'], 'marketing', C)).toEqual(new Set(['alice@example.com']))
    expect(await suppressedEmails(H.mailer.collections, ['alice@example.com'], 'transactional')).toEqual(new Set())
  })

  it('an unsubscribe while paused still writes, and survives a resume', async () => {
    await H.mailer.pauseMarketing('alice@example.com', { days: 7 })
    await H.mailer.unsubscribe('alice@example.com', { scope: 'marketing', reason: 'user_request', source: 'test' })
    expect((await rows('alice@example.com')).map((r) => r.scope).sort()).toEqual(['marketing', 'marketing_pause'])
    await H.mailer.resumeMarketing('alice@example.com')
    expect((await rows('alice@example.com')).map((r) => r.scope)).toEqual(['marketing'])
    expect(await H.mailer.getPreferences('alice@example.com')).toMatchObject({ marketing: false, pausedUntil: null })
  })

  it('an opt-in (clearing unsubscribe rows) leaves the pause alone', async () => {
    await H.mailer.pauseMarketing('alice@example.com', { days: 7 })
    await H.mailer.unsubscribe('alice@example.com', { scope: 'marketing', reason: 'user_request', source: 'test' })
    await clearUnsubscribeSuppressions(H.mailer.collections, 'alice@example.com', 'marketing')
    expect((await rows('alice@example.com')).map((r) => r.scope)).toEqual(['marketing_pause'])
  })

  it('a pause is not a marketing opt-out on the preference state', async () => {
    await H.mailer.pauseMarketing('alice@example.com', { days: 7 })
    const prefs = await H.mailer.getPreferences('alice@example.com')
    expect(prefs.marketing).toBe(true)
    expect(prefs.categories).toEqual({ [C]: true, [P_CAT]: true })
  })
})

// --- the page -------------------------------------------------------------------

describe('preference page', () => {
  it('GET offers the configured pause lengths', async () => {
    const base = await mount()
    const res = await http(base, 'GET', `/m/unsub/${token(H, 'alice@example.com')}`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('Take a break')
    expect(res.body).toContain('name="pause" value="7"')
    expect(res.body).toContain('Pause for 1 week')
    expect(res.body).toContain('Pause for 2 weeks')
    expect(res.body).toContain('Pause for 1 month')
    expect(res.body).not.toContain('Resume now')
  })

  it('GET while paused shows the date and a Resume button, no pause buttons', async () => {
    freezeAt('2026-10-08T12:00:00Z')
    const base = await mount()
    await H.mailer.pauseMarketing('alice@example.com', { days: 14 })
    const res = await http(base, 'GET', `/m/unsub/${token(H, 'alice@example.com')}`)
    expect(res.body).toContain('Paused until October 22, 2026')
    expect(res.body).toContain('value="resume"')
    expect(res.body).toContain('Resume now')
    expect(res.body).not.toContain('Pause for')
  })

  it('GET while unsubscribed from all marketing shows neither', async () => {
    const base = await mount()
    await H.mailer.unsubscribe('alice@example.com', { scope: 'marketing', reason: 'user_request', source: 'test' })
    const res = await http(base, 'GET', `/m/unsub/${token(H, 'alice@example.com')}`)
    expect(res.body).toContain("You're unsubscribed from all marketing email")
    expect(res.body).not.toContain('Take a break')
    expect(res.body).not.toContain('Resume now')
  })

  it('POST pause=<days> writes the row with source preferences and confirms the date', async () => {
    const t = freezeAt('2026-10-08T12:00:00Z')
    const base = await mount()
    const res = await http(base, 'POST', `/m/unsub/${token(H, 'alice@example.com')}/preferences`, [['pause', '14']])
    expect(res.status).toBe(200)
    expect(res.body).toContain("Paused until October 22, 2026. You'll get no marketing email until then.")
    expect(await rows('alice@example.com')).toEqual([
      { email: 'alice@example.com', scope: 'marketing_pause', reason: 'paused', source: 'preferences', expiresAt: new Date(t.getTime() + 14 * DAY) },
    ])
  })

  it('POST with an unconfigured length is a 400 and writes nothing', async () => {
    const base = await mount()
    for (const bad of ['5', '0', '-7', 'abc', '']) {
      const res = await http(base, 'POST', `/m/unsub/${token(H, 'alice@example.com')}/preferences`, [['pause', bad]])
      expect(res.status).toBe(400)
      expect(res.body).toContain('Unknown pause length.')
    }
    expect(await rows('alice@example.com')).toEqual([])
  })

  it('POST action=resume lifts the pause', async () => {
    const base = await mount()
    await H.mailer.pauseMarketing('alice@example.com', { days: 14 })
    const res = await http(base, 'POST', `/m/unsub/${token(H, 'alice@example.com')}/preferences`, [['action', 'resume']])
    expect(res.status).toBe(200)
    expect(res.body).toContain('Your emails will resume.')
    expect(await rows('alice@example.com')).toEqual([])
  })

  it('a pause that cannot reach Mongo is a 503 with Retry-After, never a 200 and never journaled', async () => {
    const base = await mount()
    breakMongo()
    const res = await http(base, 'POST', `/m/unsub/${token(H, 'alice@example.com')}/preferences`, [['pause', '7']])
    expect(res.status).toBe(503)
    expect(res.headers['retry-after']).toBe('60')
    restoreMongo()
    expect(await rows('alice@example.com')).toEqual([])
  })

  it('an invalid token is rejected', async () => {
    const base = await mount()
    const res = await http(base, 'POST', `/m/unsub/not-a-token/preferences`, [['pause', '7']])
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await rows('alice@example.com')).toEqual([])
  })

  it('custom lengths and labels', async () => {
    const H2 = await createTestMailer({ config: { categories: CATEGORIES, preferences: { pauseDays: [3, 10] } } })
    try {
      await H2.seedContact({ externalId: 'u2', email: 'bob@example.com', tags: [], fields: {} })
      const base = await mount(H2)
      const res = await http(base, 'GET', `/m/unsub/${token(H2, 'bob@example.com')}`)
      expect(res.body).toContain('Pause for 3 days')
      expect(res.body).toContain('Pause for 10 days')
      expect(res.body).not.toContain('Pause for 1 week')
      const ok = await http(base, 'POST', `/m/unsub/${token(H2, 'bob@example.com')}/preferences`, [['pause', '10']])
      expect(ok.status).toBe(200)
      const bad = await http(base, 'POST', `/m/unsub/${token(H2, 'bob@example.com')}/preferences`, [['pause', '7']])
      expect(bad.status).toBe(400)
    } finally {
      await H2.stop()
    }
  }, 120_000)

  it('pauseDays: [] hides the control', async () => {
    const H3 = await createTestMailer({ config: { categories: CATEGORIES, preferences: { pauseDays: [] } } })
    try {
      const base = await mount(H3)
      const res = await http(base, 'GET', `/m/unsub/${token(H3, 'carol@example.com')}`)
      expect(res.status).toBe(200)
      expect(res.body).not.toContain('Take a break')
      const post = await http(base, 'POST', `/m/unsub/${token(H3, 'carol@example.com')}/preferences`, [['pause', '7']])
      expect(post.status).toBe(400)
    } finally {
      await H3.stop()
    }
  }, 120_000)
})

// --- agent API -------------------------------------------------------------------

describe('contact detail', () => {
  it('reports pausedUntil in preferences', async () => {
    const t = freezeAt('2026-10-08T12:00:00Z')
    const base = await mount()
    await H.mailer.pauseMarketing('alice@example.com', { days: 7 })
    const res = await http(base, 'GET', '/agent/contacts/u1', undefined, { authorization: `Bearer ${AGENT_TOKEN}` })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.preferences).toEqual({ marketing: true, categories: { [C]: true, [P_CAT]: true }, pausedUntil: new Date(t.getTime() + 7 * DAY).toISOString() })
  })
})

// --- programs ---------------------------------------------------------------------

describe('programs with paused recipients', () => {
  let P: ProgramHarness
  beforeAll(async () => {
    P = await programHarness()
    await seedProgramWithTemplates(P.H, activation({ slug: 'act' }))
  }, 120_000)
  afterAll(async () => {
    restoreClock()
    if (P) await P.H.stop()
  })

  it('no recipients while paused; the run wakes at the pause end when that is sooner than the gap', async () => {
    const t = startClock()
    const { subjectId, owners } = await subject(P)
    await P.H.mailer.pauseMarketing(owners[0]!.email, { days: 2 })
    await enter(P, 'act', subjectId)
    expect(await tickProgram(P.H.ctx, 'act', subjectId)).toMatchObject({ reason: 'no-recipients', chosen: 'connect-shopify', sendIds: [] })
    expect((await getRun(P, 'act', subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 2 * DAY))

    advance(2 * DAY)
    expect(await tickProgram(P.H.ctx, 'act', subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'connect-shopify' })
  })

  it('a long pause still rechecks at the program gap', async () => {
    const t = startClock()
    const { subjectId, owners } = await subject(P)
    await P.H.mailer.pauseMarketing(owners[0]!.email, { days: 30 })
    await enter(P, 'act', subjectId)
    expect(await tickProgram(P.H.ctx, 'act', subjectId)).toMatchObject({ reason: 'no-recipients' })
    expect((await getRun(P, 'act', subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 3 * DAY))
  })

  it('one paused owner out of two: the other still gets the email', async () => {
    startClock()
    const { subjectId, owners } = await subject(P, {}, { owners: 2 })
    await P.H.mailer.pauseMarketing(owners[0]!.email, { days: 7 })
    await enter(P, 'act', subjectId)
    const r = await tickProgram(P.H.ctx, 'act', subjectId)
    expect(r).toMatchObject({ reason: 'highest-rank' })
    expect(r.status === 'ticked' && r.sendIds).toHaveLength(1)
  })

  it('the simulator names the pause', async () => {
    const t = startClock()
    const { subjectId, owners } = await subject(P)
    await P.H.mailer.pauseMarketing(owners[0]!.email, { days: 5 })
    await enter(P, 'act', subjectId)
    const s = await P.H.mailer.simulateProgram('act', { subjectId })
    expect(s.next).toMatchObject({
      reason: 'no-recipients',
      actionId: 'connect-shopify',
      detail: `all recipients paused until ${new Date(t.getTime() + 5 * DAY).toISOString().slice(0, 10)}`,
    })
  })

  it('a permanent suppression has no detail', async () => {
    startClock()
    const { subjectId, owners } = await subject(P)
    await P.H.mailer.unsubscribe(owners[0]!.email, { scope: 'marketing', reason: 'user_request', source: 'test' })
    await enter(P, 'act', subjectId)
    const s = await P.H.mailer.simulateProgram('act', { subjectId })
    expect(s.next.reason).toBe('no-recipients')
    expect(s.next.detail).toBeUndefined()
  })
})
