/**
 * Native waves: `recipientCap` + `order`. A capped broadcast sends to the
 * first N eligible recipients in order and parks in `paused`
 * (`cap_reached`); raising the cap and resuming sends only the next slice.
 * The cap counts every send row, earlier waves included, and holds when two
 * dispatchers race (the lease) and across a stalled-dispatch rescue.
 *
 * Also MongoContactAdapter's sorted keyset pagination, against a real
 * collection — the path StoryFolder's users collection takes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'
import { ObjectId } from 'mongodb'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { MongoContactAdapter } from '../../src/server/adapters/mongo.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { runTick } from '../../src/server/runner/index.js'
import {
  dispatchBroadcastById,
  resumeStalledBroadcasts,
  startBroadcastDispatch,
} from '../../src/server/runner/broadcasts.js'

const TOKEN = 'agent-test-token-0123456789abcdef'
const DAY = 86_400_000

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<ReturnType<typeof express>['listen']>

// Most recently active first: w9, w8, w7, w6, w5, w3, w2, w1, w0, then w4
// (no lastActiveAt sorts last in descending order).
const EXPECTED_ORDER = ['w9', 'w8', 'w7', 'w6', 'w5', 'w3', 'w2', 'w1', 'w0', 'w4']
const ORDER = { field: 'lastActiveAt', direction: 'desc' }

beforeAll(async () => {
  // A small page size so the sorted stream crosses several adapter pages.
  H = await createTestMailer({ config: { broadcastEnqueueBatchSize: 3 } })
  for (let i = 0; i < 10; i += 1) {
    await H.seedContact({
      externalId: `w${i}`,
      email: `qa+w${i}@test.example`,
      tags: [],
      fields: i === 4 ? {} : { lastActiveAt: new Date(Date.UTC(2026, 8, 1) + i * DAY) },
    })
  }
  await H.seedTemplate({
    slug: 'news',
    kind: 'marketing',
    subject: 'News',
    html: '<p>News long enough to be a body.</p><a href="{{unsubscribeUrl}}">Unsubscribe</a><p>{{senderAddress}}</p>',
  })
  const app = express()
  app.use('/agent', createAgentRouter(H.mailer, { tokens: [{ token: TOKEN, actor: 'agent:test' }], testContacts: /@test\.example$/i }))
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
  await H.ctx.collections.subscriptions.updateMany({}, { $set: { status: 'subscribed' } })
})

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const req = request(
      `${baseUrl}/agent${path}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }))
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function sentTo(slug: string): Promise<string[]> {
  const b = await H.ctx.collections.broadcasts.findOne({ slug })
  const rows = await H.ctx.collections.sends.find({ broadcastId: b!._id }).sort({ queuedAt: 1, _id: 1 }).toArray()
  return rows.map((r) => r.externalId)
}

async function createCapped(slug: string, recipientCap: number | null) {
  const res = await call('POST', '/broadcasts', { slug, name: slug, templateSlug: 'news', recipientCap, order: ORDER })
  expect(res.status).toBe(201)
  return res
}

describe('waves over the agent API', () => {
  it('sends the first N in order, parks at the cap, and each raise sends only the next slice', async () => {
    const created = await createCapped('wave', 3)
    expect(created.body.broadcast).toMatchObject({ recipientCap: 3, order: ORDER })

    const count = await call('POST', '/broadcasts/wave/count')
    expect(count.body).toMatchObject({ eligible: 10, uncappedRecipientCount: 10, recipientCap: 3, sendsSoFar: 0, recipientCount: 3 })

    expect((await call('POST', '/broadcasts/wave/schedule', { scheduledAt: new Date(Date.now() - 1000).toISOString(), confirmedCount: 10 })).status).toBe(409)
    expect((await call('POST', '/broadcasts/wave/schedule', { scheduledAt: new Date(Date.now() - 1000).toISOString(), confirmedCount: 3 })).status).toBe(200)
    await runTick(H.ctx)

    expect(await sentTo('wave')).toEqual(EXPECTED_ORDER.slice(0, 3))
    let got = await call('GET', '/broadcasts/wave')
    expect(got.body.broadcast.status).toBe('paused')
    expect(got.body.broadcast.pauseReason).toMatchObject({ code: 'cap_reached', details: { recipientCap: 3, sendsSoFar: 3 } })
    expect(got.body.broadcast.recipientCount).toBe(3)

    // Resuming without a higher cap would park again at once.
    const same = await call('POST', '/broadcasts/wave/resume', { recipientCap: 3, confirmedCount: 0 })
    expect(same.status).toBe(409)
    expect(same.body.error).toBe('cap_not_raised')
    expect((await call('POST', '/broadcasts/wave/resume', { recipientCap: 2, confirmedCount: 0 })).status).toBe(409)

    // w6 unsubscribes between waves: the next slice skips them and still fills the cap.
    await H.ctx.collections.subscriptions.updateOne({ externalId: 'w6' }, { $set: { status: 'unsubscribed' } })
    const wrong = await call('POST', '/broadcasts/wave/resume', { recipientCap: 6, confirmedCount: 4 })
    expect(wrong.status).toBe(409)
    expect(wrong.body).toMatchObject({ error: 'count_mismatch', expected: 3 })
    const next = await call('POST', '/broadcasts/wave/resume', { recipientCap: 6, confirmedCount: 3 })
    expect(next.status).toBe(200)
    expect(await sentTo('wave')).toEqual(['w9', 'w8', 'w7', 'w5', 'w3', 'w2'])
    got = await call('GET', '/broadcasts/wave')
    expect(got.body.broadcast.status).toBe('paused')

    // No cap: everyone remaining, then 'sent'.
    const rest = await call('POST', '/broadcasts/wave/resume', { recipientCap: null, confirmedCount: 3 })
    expect(rest.status).toBe(200)
    expect(await sentTo('wave')).toEqual(['w9', 'w8', 'w7', 'w5', 'w3', 'w2', 'w1', 'w0', 'w4'])
    got = await call('GET', '/broadcasts/wave')
    expect(got.body.broadcast).toMatchObject({ status: 'sent', recipientCount: 9, pauseReason: null })

    // Re-dispatching a finished broadcast adds nothing.
    await H.ctx.collections.broadcasts.updateOne({ slug: 'wave' }, { $set: { status: 'sending' } })
    await dispatchBroadcastById(new ObjectId(got.body.broadcast.id), H.ctx)
    expect(await sentTo('wave')).toHaveLength(9)
  })

  it('a cap equal to the audience ends as sent, not paused', async () => {
    await createCapped('exact', 10)
    await call('POST', '/broadcasts/exact/schedule', { scheduledAt: new Date(Date.now() - 1000).toISOString(), confirmedCount: 10 })
    await runTick(H.ctx)
    expect((await call('GET', '/broadcasts/exact')).body.broadcast.status).toBe('sent')
  })

  it('only a paused broadcast resumes', async () => {
    await createCapped('draft-one', 3)
    const res = await call('POST', '/broadcasts/draft-one/resume', { recipientCap: 5, confirmedCount: 5 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('not_paused')
  })

  it('validates cap and order, and refuses an order the adapter cannot sort by', async () => {
    expect((await call('POST', '/broadcasts', { slug: 'bad-cap', name: 'x', templateSlug: 'news', recipientCap: 0 })).status).toBe(400)
    expect(
      (await call('POST', '/broadcasts', { slug: 'bad-order', name: 'x', templateSlug: 'news', order: { field: '$where', direction: 'desc' } })).status,
    ).toBe(400)
    const adapter = H.adapter as any
    const prior = adapter.supportsSort
    Object.defineProperty(adapter, 'supportsSort', { value: false, configurable: true })
    try {
      const res = await call('POST', '/broadcasts', { slug: 'no-sort', name: 'x', templateSlug: 'news', order: ORDER })
      expect(res.status).toBe(422)
      expect(res.body.error).toBe('adapter_cannot_sort')
    } finally {
      Object.defineProperty(adapter, 'supportsSort', { value: prior, configurable: true })
    }
  })
})

describe('the cap holds under concurrency and rescue', () => {
  it('two dispatchers racing one broadcast still stop at the cap', async () => {
    await createCapped('race', 4)
    const b = await H.ctx.collections.broadcasts.findOneAndUpdate(
      { slug: 'race' },
      { $set: { status: 'sending', scheduledAt: new Date(), startedAt: new Date() } },
      { returnDocument: 'after' },
    )
    await Promise.all([dispatchBroadcastById(b!._id!, H.ctx), dispatchBroadcastById(b!._id!, H.ctx)])
    expect(await sentTo('race')).toEqual(EXPECTED_ORDER.slice(0, 4))
    expect((await H.ctx.collections.broadcasts.findOne({ slug: 'race' }))?.dispatchLeaseId).toBeNull()
  })

  it('a stalled dispatch rescued after a cap raise continues to the new cap, not past it', async () => {
    await createCapped('stall', 2)
    await call('POST', '/broadcasts/stall/schedule', { scheduledAt: new Date(Date.now() - 1000).toISOString(), confirmedCount: 2 })
    await runTick(H.ctx)
    expect(await sentTo('stall')).toHaveLength(2)
    // The worker died mid-wave after the cap went to 5: sending, a dead lease, a stale heartbeat.
    await H.ctx.collections.broadcasts.updateOne(
      { slug: 'stall' },
      { $set: { status: 'sending', recipientCap: 5, dispatchLeaseId: 'dead-worker', updatedAt: new Date(Date.now() - 60 * 60 * 1000) } },
    )
    await resumeStalledBroadcasts(H.ctx)
    expect(await sentTo('stall')).toEqual(EXPECTED_ORDER.slice(0, 5))
    expect((await H.ctx.collections.broadcasts.findOne({ slug: 'stall' }))?.status).toBe('paused')
  })

  it('a live lease keeps a second dispatcher out', async () => {
    await createCapped('leased', null)
    const b = await H.ctx.collections.broadcasts.findOneAndUpdate(
      { slug: 'leased' },
      { $set: { status: 'sending', dispatchLeaseId: 'someone-else', updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    await dispatchBroadcastById(b!._id!, H.ctx)
    expect(await sentTo('leased')).toEqual([])
  })

  it('every dispatch start gets its own job id, so a re-dispatch is never dropped as a duplicate', async () => {
    await createCapped('jobs', 2)
    const b = await H.ctx.collections.broadcasts.findOne({ slug: 'jobs' })
    const jobIds: string[] = []
    const queued = {
      ...H.ctx,
      config: { ...H.ctx.config, queue: { driver: 'agenda' } as any },
      queues: { ...H.ctx.queues, advance: { ...H.ctx.queues.advance, add: async (_n: string, _d: unknown, o: any) => { jobIds.push(o.jobId) } } },
    }
    await startBroadcastDispatch(b!, queued as any)
    await startBroadcastDispatch(b!, queued as any)
    expect(jobIds).toEqual([`broadcast-dispatch:${b!._id}:1`, `broadcast-dispatch:${b!._id}:2`])
  })
})

describe('MongoContactAdapter sorted pagination', () => {
  it('pages a sort with ties and missing values without skipping or repeating, both directions', async () => {
    const col = H.db.collection('users_sort_test')
    const base = Date.UTC(2026, 0, 1)
    const docs = Array.from({ length: 23 }, (_, i) => {
      const doc: Record<string, unknown> = { _id: new ObjectId(), email: `u${i}@example.com` }
      // Ties every third row, and every fifth row has no updatedAt at all.
      if (i % 5 !== 0) doc.updatedAt = new Date(base + Math.floor(i / 3) * DAY)
      if (i === 7) doc.updatedAt = null
      return doc
    })
    await col.insertMany(docs)
    const adapter = new MongoContactAdapter({ db: H.db, collection: 'users_sort_test' })
    expect(adapter.supportsSort).toBe(true)

    const key = (d: any) => (d.updatedAt instanceof Date ? d.updatedAt.getTime() : null)
    for (const direction of ['desc', 'asc'] as const) {
      const expected = [...docs]
        .sort((a, b) => {
          const ka = key(a)
          const kb = key(b)
          if (ka !== kb) {
            // Mongo sorts null/missing lowest.
            if (ka === null) return direction === 'desc' ? 1 : -1
            if (kb === null) return direction === 'desc' ? -1 : 1
            return direction === 'desc' ? kb - ka : ka - kb
          }
          return String(a._id) < String(b._id) ? -1 : 1
        })
        .map((d) => String(d._id))

      const seen: string[] = []
      let cursor: string | undefined
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await adapter.query({}, { limit: 4, cursor, sort: { field: 'updatedAt', direction } })
        seen.push(...page.contacts.map((c) => c.externalId))
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      expect(seen).toEqual(expected)
    }
  })

  it('keeps the host filter when paging a sort', async () => {
    const col = H.db.collection('users_sort_filter')
    await col.insertMany(
      Array.from({ length: 9 }, (_, i) => ({ email: `f${i}@example.com`, tags: i % 2 ? ['beta'] : [], updatedAt: new Date(Date.UTC(2026, 0, 1 + i)) })),
    )
    const adapter = new MongoContactAdapter({ db: H.db, collection: 'users_sort_filter', tagsField: 'tags' })
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await adapter.query({ hasTag: 'beta' }, { limit: 2, cursor, sort: { field: 'updatedAt', direction: 'desc' } })
      seen.push(...page.contacts.map((c) => c.email))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(['f7@example.com', 'f5@example.com', 'f3@example.com', 'f1@example.com'])
  })
})
