/**
 * HTTP-level tests for signed tracking URLs (issue #7).
 *
 * These go over a real socket, because the thing being fixed is reachable by
 * anyone on the internet: before signing, `/m/open/:sendId.png` accepted any
 * well-formed ObjectId, and ObjectIds are sequential enough that one received
 * email hands over its neighbours. Forged opens feed `hasOpened` /
 * `openedAtLeastN`, so they drive real automation, not just charts.
 *
 * The compatibility design under test:
 *   - signature present + valid  → counted
 *   - signature present + wrong  → never counted, in either mode
 *   - signature absent           → counted in grace mode (default), logged at
 *                                  `info`; rejected once the operator sets
 *                                  `requireSignedTrackingUrls: true`
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ObjectId } from 'mongodb'

import { createPublicRouter } from '../../src/server/api/public.js'
import type { RouteLogger } from '../../src/server/api/wrap.js'
import { signTrackingToken } from '../../src/server/tokens.js'
import type { SendDoc } from '../../src/server/models/index.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<express.Express['listen']>
let SECRET: string

const logged: Array<{ level: 'error' | 'warn' | 'info'; fields: Record<string, unknown>; msg?: string }> = []
const logger: RouteLogger = {
  error: (fields, msg) => { logged.push({ level: 'error', fields, msg }) },
  warn: (fields, msg) => { logged.push({ level: 'warn', fields, msg }) },
  info: (fields, msg) => { logged.push({ level: 'info', fields, msg }) },
}

const SEND_ID = new ObjectId()
/** The neighbouring id an attacker derives from a single received email. */
const NEIGHBOUR_ID = new ObjectId()
const LINK_ID = 'aabbccddeeff'
const TARGET = 'https://example.com/landing'

function sendDoc(id: ObjectId, queuedAt = new Date()) {
  return {
    _id: id,
    dedupeKey: `sig:${id.toHexString()}`,
    externalId: 'u1',
    emailAtSend: 'u1@example.com',
    templateId: new ObjectId(),
    templateSlug: 'sig',
    flowRunId: null,
    broadcastId: null,
    manualSendBy: 'test',
    kind: 'marketing',
    provider: 'null',
    providerMessageId: null,
    fromName: 'Test',
    fromEmail: 'test@example.com',
    subject: 'hi',
    bodyHash: '',
    status: 'sent',
    errorMessage: null,
    bounceType: null,
    bounceReason: null,
    links: [{ linkId: LINK_ID, url: TARGET }],
    vars: {},
    openedAt: null,
    openCount: 0,
    opens: [],
    firstClickAt: null,
    clickCount: 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt,
    updatedAt: new Date(),
    sentAt: new Date(),
    deliveredAt: null,
  } as any
}

beforeAll(async () => {
  H = await createTestMailer()
  SECRET = H.mailer.config.unsubscribeSecret
  await H.mailer.collections.sends.insertOne(sendDoc(SEND_ID))
  await H.mailer.collections.sends.insertOne(sendDoc(NEIGHBOUR_ID))

  const app = express()
  app.use('/m', createPublicRouter(H.mailer, { logger }))
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  server?.close()
  if (H) await H.stop()
})

beforeEach(async () => {
  logged.length = 0
  await H.mailer.collections.sends.updateMany(
    { _id: { $in: [SEND_ID, NEIGHBOUR_ID] } },
    { $set: { openedAt: null, openCount: 0, opens: [], firstClickAt: null, clickCount: 0, clickedLinks: [] } },
  )
})

afterEach(() => {
  // Every test that flips the mode must leave the default (grace on) behind.
  ;(H.mailer.config as any).requireSignedTrackingUrls = false
  ;(H.mailer.config as any).trackingUrlLifetimeDays = 0
})

// --- transport ---------------------------------------------------------------

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET', headers }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: raw,
        location: res.headers.location as string | undefined,
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * The open and click routes answer before they write (INVARIANT 8), so an
 * assertion has to wait for the write rather than for the response.
 *
 * `done` says what this caller is waiting for, and defaults to "any tracking
 * write landed". Pass it whenever you assert on more than one field: the
 * default returns as soon as *either* counter moves, so a test that fires an
 * open and then a click and asserts both would read the doc with the open
 * recorded and the click still in flight. That is not hypothetical — it passed
 * on a fast machine and failed on a 2-core CI runner, which is the worst way
 * for a race to present.
 */
async function readSend(
  id: ObjectId = SEND_ID,
  done: (d: SendDoc) => boolean = (d) => d.openCount > 0 || d.clickCount > 0,
) {
  for (let i = 0; i < 40; i++) {
    const doc = await H.mailer.collections.sends.findOne({ _id: id })
    if (doc && done(doc)) return doc
    await new Promise((r) => setTimeout(r, 25))
  }
  return await H.mailer.collections.sends.findOne({ _id: id })
}

const openRecorded = (d: SendDoc) => (d.opens?.length ?? 0) > 0
const clickRecorded = (d: SendDoc) => (d.clickedLinks?.length ?? 0) > 0

const openSig = (id: ObjectId) => signTrackingToken('open', { sendId: id.toHexString() }, SECRET)
const clickSig = (id: ObjectId, linkId = LINK_ID) =>
  signTrackingToken('click', { sendId: id.toHexString(), linkId }, SECRET)

// ---------------------------------------------------------------------------
// Signed URLs — the happy path
// ---------------------------------------------------------------------------

describe('signed tracking URLs are accepted', () => {
  it('counts an open behind a valid signature', async () => {
    const res = await get(`/m/open/${SEND_ID.toHexString()}.${openSig(SEND_ID)}.png`)
    expect(res.status).toBe(200)
    const doc = await readSend()
    expect(doc?.openCount).toBe(1)
    expect(doc?.openedAt).toBeInstanceOf(Date)
  })

  it('redirects and counts a click behind a valid signature', async () => {
    const res = await get(`/m/click/${SEND_ID.toHexString()}/${LINK_ID}/${clickSig(SEND_ID)}`)
    expect(res.status).toBe(302)
    expect(res.location).toBe(TARGET)
    const doc = await readSend()
    expect(doc?.clickCount).toBe(1)
  })

  it('logs nothing about signatures on the happy path', async () => {
    await get(`/m/open/${SEND_ID.toHexString()}.${openSig(SEND_ID)}.png`)
    await readSend()
    expect(logged.filter((l) => (l.msg ?? '').includes('tracking URL'))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Forgery — the actual vulnerability
// ---------------------------------------------------------------------------

describe('forged and tampered signatures are rejected in every mode', () => {
  it.each([true, false])('a tampered open signature never counts (requireSigned=%s)', async (require) => {
    ;(H.mailer.config as any).requireSignedTrackingUrls = require
    const bad = openSig(SEND_ID).split('').reverse().join('')
    const res = await get(`/m/open/${SEND_ID.toHexString()}.${bad}.png`)

    // The pixel is still a normal 200 PNG: a different status would tell the
    // attacker their guessed sendId is real.
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 150))
    const doc = await H.mailer.collections.sends.findOne({ _id: SEND_ID })
    expect(doc?.openCount).toBe(0)
    expect(doc?.openedAt).toBeNull()
    expect(logged.some((l) => l.level === 'warn' && (l.msg ?? '').includes('signature invalid'))).toBe(true)
  })

  it('a signature for one send does not authorise the neighbouring send', async () => {
    // This is the enumeration attack: the attacker holds a real, correctly
    // signed URL from their own email and increments the ObjectId.
    const stolen = openSig(SEND_ID)
    const res = await get(`/m/open/${NEIGHBOUR_ID.toHexString()}.${stolen}.png`)
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 150))
    const doc = await H.mailer.collections.sends.findOne({ _id: NEIGHBOUR_ID })
    expect(doc?.openCount).toBe(0)
  })

  it('an open signature cannot be replayed on the click route', async () => {
    const res = await get(`/m/click/${SEND_ID.toHexString()}/${LINK_ID}/${openSig(SEND_ID)}`)
    expect(res.status).toBe(404)
    expect(res.location).toBeUndefined()
  })

  it('a click signature for one link does not authorise another link', async () => {
    await H.mailer.collections.sends.updateOne(
      { _id: SEND_ID },
      { $set: { links: [{ linkId: LINK_ID, url: TARGET }, { linkId: 'other0000000', url: TARGET }] } },
    )
    const res = await get(`/m/click/${SEND_ID.toHexString()}/other0000000/${clickSig(SEND_ID)}`)
    expect(res.status).toBe(404)
    await H.mailer.collections.sends.updateOne(
      { _id: SEND_ID },
      { $set: { links: [{ linkId: LINK_ID, url: TARGET }] } },
    )
  })

  it('answers a bad click signature with 404, the same as an unknown send', async () => {
    const bad = await get(`/m/click/${SEND_ID.toHexString()}/${LINK_ID}/000000000000`)
    const unknown = await get(`/m/click/${new ObjectId().toHexString()}/${LINK_ID}/${clickSig(SEND_ID)}`)
    expect(bad.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(bad.body).toBe(unknown.body)
  })

  it('does not count a click whose signature is wrong', async () => {
    await get(`/m/click/${SEND_ID.toHexString()}/${LINK_ID}/000000000000`)
    await new Promise((r) => setTimeout(r, 150))
    const doc = await H.mailer.collections.sends.findOne({ _id: SEND_ID })
    expect(doc?.clickCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility — grace mode ON (the default)
// ---------------------------------------------------------------------------

describe('legacy unsigned URLs — grace mode on (default)', () => {
  it('still counts an unsigned open, so already-delivered mail keeps tracking', async () => {
    expect(H.mailer.config.requireSignedTrackingUrls).toBe(false)
    const res = await get(`/m/open/${SEND_ID.toHexString()}.png`)
    expect(res.status).toBe(200)
    const doc = await readSend()
    expect(doc?.openCount).toBe(1)
  })

  it('still redirects and counts an unsigned click', async () => {
    const res = await get(`/m/click/${SEND_ID.toHexString()}/${LINK_ID}`)
    expect(res.status).toBe(302)
    expect(res.location).toBe(TARGET)
    const doc = await readSend()
    expect(doc?.clickCount).toBe(1)
  })

  it('logs each legacy hit at info, so the operator can watch it decay to zero', async () => {
    await get(`/m/open/${SEND_ID.toHexString()}.png`)
    await readSend()
    const line = logged.find((l) => (l.msg ?? '').includes('legacy grace mode'))
    expect(line).toBeDefined()
    expect(line!.level).toBe('info')
    expect(line!.fields.scope).toBe('open')
    expect(line!.fields.sendId).toBe(SEND_ID.toHexString())
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility — grace mode OFF
// ---------------------------------------------------------------------------

describe('legacy unsigned URLs — requireSignedTrackingUrls: true', () => {
  beforeEach(() => {
    ;(H.mailer.config as any).requireSignedTrackingUrls = true
  })

  it('stops counting unsigned opens', async () => {
    const res = await get(`/m/open/${SEND_ID.toHexString()}.png`)
    expect(res.status).toBe(200) // still a valid pixel — never a broken image
    await new Promise((r) => setTimeout(r, 150))
    const doc = await H.mailer.collections.sends.findOne({ _id: SEND_ID })
    expect(doc?.openCount).toBe(0)
    expect(logged.some((l) => l.level === 'warn' && (l.msg ?? '').includes('unsigned tracking URL rejected'))).toBe(true)
  })

  it('404s an unsigned click instead of redirecting', async () => {
    const res = await get(`/m/click/${SEND_ID.toHexString()}/${LINK_ID}`)
    expect(res.status).toBe(404)
    expect(res.location).toBeUndefined()
  })

  it('keeps accepting properly signed URLs', async () => {
    const open = await get(`/m/open/${SEND_ID.toHexString()}.${openSig(SEND_ID)}.png`)
    expect(open.status).toBe(200)
    const click = await get(`/m/click/${SEND_ID.toHexString()}/${LINK_ID}/${clickSig(SEND_ID)}`)
    expect(click.status).toBe(302)
    const doc = await readSend(SEND_ID, (d) => d.openCount > 0 && d.clickCount > 0)
    expect(doc?.openCount).toBe(1)
    expect(doc?.clickCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

describe('trackingUrlLifetimeDays', () => {
  it('never expires by default — an open years later is real data', async () => {
    const ancient = new ObjectId()
    await H.mailer.collections.sends.insertOne(
      sendDoc(ancient, new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000)),
    )
    expect(H.mailer.config.trackingUrlLifetimeDays).toBe(0)
    await get(`/m/open/${ancient.toHexString()}.${openSig(ancient)}.png`)
    const doc = await readSend(ancient)
    expect(doc?.openCount).toBe(1)
  })

  it('drops a hit older than the configured window, without touching newer sends', async () => {
    const old = new ObjectId()
    await H.mailer.collections.sends.insertOne(
      sendDoc(old, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)),
    )
    ;(H.mailer.config as any).trackingUrlLifetimeDays = 30

    await get(`/m/open/${old.toHexString()}.${openSig(old)}.png`)
    await new Promise((r) => setTimeout(r, 150))
    expect((await H.mailer.collections.sends.findOne({ _id: old }))?.openCount).toBe(0)

    // The same window leaves a fresh send alone.
    await get(`/m/open/${SEND_ID.toHexString()}.${openSig(SEND_ID)}.png`)
    expect((await readSend())?.openCount).toBe(1)
  })

  it('404s an expired click', async () => {
    const old = new ObjectId()
    await H.mailer.collections.sends.insertOne(
      sendDoc(old, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)),
    )
    ;(H.mailer.config as any).trackingUrlLifetimeDays = 30
    const res = await get(`/m/click/${old.toHexString()}/${LINK_ID}/${clickSig(old)}`)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// User-agent capture (issue #2 depends on this existing at all)
// ---------------------------------------------------------------------------

describe('user-agent capture', () => {
  it('records the open user agent so the bot filter has a signal', async () => {
    await get(`/m/open/${SEND_ID.toHexString()}.${openSig(SEND_ID)}.png`, {
      'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36',
    })
    const doc = await readSend(SEND_ID, openRecorded)
    expect(doc?.opens).toHaveLength(1)
    expect(doc?.opens?.[0]?.userAgent).toContain('Macintosh')
    expect(doc?.opens?.[0]?.openedAt).toBeInstanceOf(Date)
  })

  it('records null rather than a placeholder when the client sends no UA', async () => {
    // node:http always sets one, so blank it explicitly — image fetches from
    // real mail clients frequently arrive this way.
    await get(`/m/open/${SEND_ID.toHexString()}.${openSig(SEND_ID)}.png`, { 'user-agent': '' })
    const doc = await readSend(SEND_ID, openRecorded)
    expect(doc?.opens?.[0]?.userAgent).toBeNull()
  })

  it('records the click user agent on clickedLinks', async () => {
    await get(`/m/click/${SEND_ID.toHexString()}/${LINK_ID}/${clickSig(SEND_ID)}`, {
      'user-agent': 'Mimecast-Link-Protection/1.0',
    })
    const doc = await readSend(SEND_ID, clickRecorded)
    expect(doc?.clickedLinks?.[0]?.userAgent).toBe('Mimecast-Link-Protection/1.0')
  })

  it('truncates an absurdly long user agent instead of storing it whole', async () => {
    await get(`/m/open/${SEND_ID.toHexString()}.${openSig(SEND_ID)}.png`, {
      'user-agent': 'A'.repeat(4000),
    })
    const doc = await readSend(SEND_ID, openRecorded)
    expect(doc?.opens?.[0]?.userAgent).toHaveLength(256)
  })

  it('caps the opens array rather than growing it forever', async () => {
    const url = `/m/open/${SEND_ID.toHexString()}.${openSig(SEND_ID)}.png`
    for (let i = 0; i < 55; i++) await get(url)
    for (let i = 0; i < 40; i++) {
      const doc = await H.mailer.collections.sends.findOne({ _id: SEND_ID })
      if ((doc?.openCount ?? 0) >= 55) break
      await new Promise((r) => setTimeout(r, 25))
    }
    const doc = await H.mailer.collections.sends.findOne({ _id: SEND_ID })
    expect(doc?.openCount).toBe(55)
    expect(doc?.opens?.length).toBe(50)
  })
})
