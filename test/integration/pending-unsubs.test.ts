/**
 * INVARIANT 8, end to end: an opt-out that cannot reach Mongo lands on disk,
 * and a later tick applies it.
 *
 * Through v0.14 the first half worked and the second did not, which meant the
 * recipient was told "you are unsubscribed" and kept receiving mail. These
 * tests exist to keep that from being true again, so they go over a real
 * socket and assert on the *suppression row*, not on the file.
 *
 * The Mongo failure is simulated by making `suppressions.updateOne` throw —
 * the same observable behaviour as an unreachable replica set, without a
 * 30-second server-selection wait in the test suite.
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
import { readClaim, serializeEntry } from '../../src/server/unsub-journal.js'
import type { RouteLogger } from '../../src/server/api/wrap.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

let H: TestMailerHarness
let dir: string
let journal: string
let servers: Array<ReturnType<express.Express['listen']>> = []

const logged: Array<{ level: string; fields: Record<string, unknown>; msg?: string }> = []
const logger: RouteLogger = {
  error: (fields, msg) => { logged.push({ level: 'error', fields, msg }) },
  warn: (fields, msg) => { logged.push({ level: 'warn', fields, msg }) },
  info: (fields, msg) => { logged.push({ level: 'info', fields, msg }) },
}

/** Rejections that escaped to the process. Must stay empty. */
const escaped: unknown[] = []
const onUnhandled = (err: unknown) => { escaped.push(err) }

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)
  H = await createTestMailer()
}, 120_000)

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled)
  for (const s of servers) s.close()
  if (H) await H.stop()
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailery-pending-'))
  journal = path.join(dir, 'state', 'pending-unsubs.jsonl')
})

afterEach(async () => {
  restoreMongo()
  logged.length = 0
  fs.rmSync(dir, { recursive: true, force: true })
  await H.mailer.collections.suppressions.deleteMany({})
  await H.mailer.collections.subscriptions.deleteMany({})
})

// --- degrading Mongo ---------------------------------------------------------

let originalUpdateOne: any = null

/** Make every suppression write fail, the way an unreachable primary does. */
function breakMongo(mode: 'reject' | 'hang' = 'reject') {
  const coll = H.mailer.collections.suppressions as any
  originalUpdateOne ??= coll.updateOne.bind(coll)
  coll.updateOne = () =>
    mode === 'reject'
      ? Promise.reject(new Error('MongoServerSelectionError: no primary'))
      : new Promise(() => {})
}

function restoreMongo() {
  if (!originalUpdateOne) return
  ;(H.mailer.collections.suppressions as any).updateOne = originalUpdateOne
  originalUpdateOne = null
}

// --- a live router -----------------------------------------------------------

async function mountRouter(opts: { journalPath?: string | null } = {}): Promise<string> {
  // The route reads the journal path off MailerConfig, which is where the
  // drain reads it too — a path known only to the router is a path nothing
  // ever replays.
  ;(H.mailer.config as any).pendingUnsubsPath =
    opts.journalPath === null ? undefined : (opts.journalPath ?? journal)

  const app = express()
  app.use('/m', createPublicRouter(H.mailer, { logger }))
  const server = app.listen(0)
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function post(baseUrl: string, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${p}`, { method: 'POST', headers: { 'content-length': '0' } }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
    })
    req.on('error', reject)
    req.end()
  })
}

function tokenFor(email: string, scope: 'all' | 'marketing' = 'all'): string {
  return signUnsubscribeToken(
    { email, scope, expiresAt: new Date(Date.now() + 86_400_000) },
    H.mailer.config.unsubscribeSecret,
  )
}

const suppression = (email: string) =>
  H.mailer.collections.suppressions.findOne({ email, scope: 'all' })

// ---------------------------------------------------------------------------

describe('POST /unsub — the happy path is unchanged', () => {
  it('answers 200 and writes the suppression', async () => {
    const base = await mountRouter()
    const res = await post(base, `/m/unsub/${tokenFor('happy@example.com')}`)

    expect(res.status).toBe(200)
    expect(res.body).toContain('unsubscribed')
    expect(await suppression('happy@example.com')).toBeTruthy()
    expect(fs.existsSync(journal)).toBe(false)
  })
})

describe('POST /unsub — Mongo degraded', () => {
  it('journals the opt-out and still answers 200', async () => {
    const base = await mountRouter()
    breakMongo()

    const res = await post(base, `/m/unsub/${tokenFor('down@example.com')}`)

    expect(res.status).toBe(200)
    expect(await suppression('down@example.com')).toBeNull()
    expect(readClaim(journal).entries).toEqual([
      { email: 'down@example.com', scope: 'all', at: expect.any(Number) },
    ])
  })

  it('gives up on a hung write inside the configured budget', async () => {
    ;(H.mailer.config as any).unsubscribeWriteTimeoutMs = 150
    const base = await mountRouter()
    breakMongo('hang')

    const started = Date.now()
    const res = await post(base, `/m/unsub/${tokenFor('hung@example.com')}`)
    const elapsed = Date.now() - started

    expect(res.status).toBe(200)
    expect(elapsed).toBeLessThan(5_000)
    expect(readClaim(journal).entries.map((e) => e.email)).toEqual(['hung@example.com'])
    ;(H.mailer.config as any).unsubscribeWriteTimeoutMs = 5000
  })

  it('answers 503 when there is nowhere durable to record it', async () => {
    // No journal configured — the case INVARIANT 8 always described and the
    // route never actually reached.
    const base = await mountRouter({ journalPath: null })
    breakMongo()

    const res = await post(base, `/m/unsub/${tokenFor('nowhere@example.com')}`)

    expect(res.status).toBe(503)
    // No claim of success anywhere in the body.
    expect(res.body).not.toContain('You are unsubscribed')
    expect(logged.some((l) => l.level === 'error' && l.msg?.includes('503'))).toBe(true)
  })

  it('answers 503 when the journal itself cannot be written', async () => {
    // A directory where the file should be — open() fails, and there is no
    // third fallback.
    fs.mkdirSync(journal, { recursive: true })
    const base = await mountRouter()
    breakMongo()

    const res = await post(base, `/m/unsub/${tokenFor('unwritable@example.com')}`)

    expect(res.status).toBe(503)
    expect(res.body).not.toContain('You are unsubscribed')
  })

  it('never lets the abandoned Mongo write escape as an unhandled rejection', async () => {
    const base = await mountRouter()
    breakMongo()
    await post(base, `/m/unsub/${tokenFor('escape@example.com')}`)
    await new Promise((r) => setTimeout(r, 50))
    expect(escaped).toEqual([])
  })
})

describe('drainPendingUnsubscribes', () => {
  it('applies a journaled opt-out once Mongo is back', async () => {
    const base = await mountRouter()
    breakMongo()
    await post(base, `/m/unsub/${tokenFor('recovered@example.com')}`)
    restoreMongo()

    const result = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })

    expect(result).toMatchObject({ enabled: true, applied: 1, deferred: 0, malformed: 0 })
    const row = await suppression('recovered@example.com')
    expect(row).toMatchObject({ scope: 'all', reason: 'unsubscribed', source: 'one-click-drain' })
    // Nothing left behind.
    expect(fs.existsSync(journal)).toBe(false)
    expect(fs.readdirSync(path.dirname(journal))).toEqual([])
  })

  it('marks the subscription unsubscribed, not just the suppression', async () => {
    await H.mailer.collections.subscriptions.insertOne({
      externalId: 'u-drain',
      emailAtSubscribe: 'sub@example.com',
      status: 'subscribed',
      source: 'test',
      subscribedAt: new Date(),
      unsubscribedAt: null,
      unsubscribeReason: null,
      updatedAt: new Date(),
      createdAt: new Date(),
    } as any)

    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(journal, serializeEntry({ email: 'sub@example.com', scope: 'all', at: 1 }))

    await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })

    const sub = await H.mailer.collections.subscriptions.findOne({ emailAtSubscribe: 'sub@example.com' })
    expect(sub?.status).toBe('unsubscribed')
  })

  it('is idempotent across two runs', async () => {
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(
      journal,
      serializeEntry({ email: 'twice@example.com', scope: 'all', at: 1 }) +
        serializeEntry({ email: 'twice@example.com', scope: 'all', at: 2 }),
    )

    const first = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })
    expect(first.applied).toBe(2)
    const after = await suppression('twice@example.com')

    // Re-journal the same opt-out and drain again — the original row must not
    // be rewritten, and there must still be exactly one.
    fs.writeFileSync(journal, serializeEntry({ email: 'twice@example.com', scope: 'all', at: 3 }))
    const second = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })

    expect(second.applied).toBe(1)
    const rows = await H.mailer.collections.suppressions.find({ email: 'twice@example.com' }).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.addedAt).toEqual(after!.addedAt)
  })

  it('does nothing, quietly, when the journal is absent', async () => {
    const result = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })
    expect(result).toMatchObject({ enabled: true, applied: 0, batches: 0 })
    expect(logged.filter((l) => l.level === 'error')).toEqual([])
  })

  it('does nothing when no path is configured at all', async () => {
    ;(H.mailer.config as any).pendingUnsubsPath = undefined
    const result = await drainPendingUnsubscribes(H.ctx, { log: logger })
    expect(result.enabled).toBe(false)
  })

  it('does nothing with an empty journal', async () => {
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(journal, '')
    const result = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })
    expect(result).toMatchObject({ applied: 0, malformed: 0 })
    expect(fs.existsSync(journal)).toBe(false)
  })

  it('applies every valid entry around truncated and malformed lines', async () => {
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(
      journal,
      serializeEntry({ email: 'ok1@example.com', scope: 'all', at: 1 }) +
        'this line is not json\n' +
        serializeEntry({ email: 'ok2@example.com', scope: 'all', at: 2 }) +
        '{"email":"bad-email","scope":"all","at":3}\n' +
        serializeEntry({ email: 'ok3@example.com', scope: 'all', at: 4 }) +
        '{"email":"torn@example.com","sco', // killed mid-append
    )

    const result = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })

    expect(result.applied).toBe(3)
    expect(result.malformed).toBe(3)
    for (const e of ['ok1@example.com', 'ok2@example.com', 'ok3@example.com']) {
      expect(await suppression(e)).toBeTruthy()
    }
    // Unusable lines are reported, not swallowed.
    expect(logged.filter((l) => l.msg?.includes('unusable'))).toHaveLength(3)
  })

  it('defers the batch and loses nothing when Mongo is still down', async () => {
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(
      journal,
      serializeEntry({ email: 'still1@example.com', scope: 'all', at: 1 }) +
        serializeEntry({ email: 'still2@example.com', scope: 'all', at: 2 }),
    )
    breakMongo()

    const result = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })

    expect(result.applied).toBe(0)
    expect(result.deferred).toBe(2)
    // Back in the live journal, attempt-counted, ready for the next tick.
    const back = readClaim(journal)
    expect(back.entries.map((e) => e.email)).toEqual(['still1@example.com', 'still2@example.com'])
    expect(back.entries.every((e) => e.attempts === 1)).toBe(true)

    restoreMongo()
    const second = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })
    expect(second.applied).toBe(2)
    expect(await suppression('still2@example.com')).toBeTruthy()
  })

  it('recovers a batch abandoned by a pass that died mid-drain', async () => {
    // Exactly what is on disk after a SIGKILL between claim and unlink.
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    const orphan = `${journal}.draining.abandoned`
    fs.writeFileSync(
      orphan,
      serializeEntry({ email: 'orphan1@example.com', scope: 'all', at: 1 }) +
        serializeEntry({ email: 'orphan2@example.com', scope: 'marketing', at: 2 }),
    )
    const old = new Date(Date.now() - 30 * 60_000)
    fs.utimesSync(orphan, old, old)

    const result = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })

    expect(result.applied).toBe(2)
    expect(await suppression('orphan1@example.com')).toBeTruthy()
    expect(
      await H.mailer.collections.suppressions.findOne({ email: 'orphan2@example.com', scope: 'marketing' }),
    ).toBeTruthy()
    expect(fs.readdirSync(path.dirname(journal))).toEqual([])
  })

  it('carries the remainder to the next pass when the budget is exhausted', async () => {
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(
      journal,
      ['a', 'b', 'c']
        .map((n) => serializeEntry({ email: `budget-${n}@example.com`, scope: 'all', at: 1 }))
        .join(''),
    )

    const first = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger, maxEntries: 2 })
    expect(first).toMatchObject({ applied: 2, deferred: 1 })

    const second = await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })
    expect(second.applied).toBe(1)
    for (const n of ['a', 'b', 'c']) {
      expect(await suppression(`budget-${n}@example.com`)).toBeTruthy()
    }
  })

  it('leaves a concurrently arriving unsubscribe for the next pass rather than eating it', async () => {
    // Claiming renames the journal aside; anything appended after that point
    // belongs to the next batch and must survive this one.
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(journal, serializeEntry({ email: 'first@example.com', scope: 'all', at: 1 }))

    const drain = drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })
    fs.appendFileSync(journal, serializeEntry({ email: 'second@example.com', scope: 'all', at: 2 }))
    await drain

    const remaining = readClaim(journal)
    expect(remaining.entries.map((e) => e.email)).toEqual(['second@example.com'])

    await drainPendingUnsubscribes(H.ctx, { path: journal, log: logger })
    expect(await suppression('second@example.com')).toBeTruthy()
  })
})
