/**
 * Contact policy through dispatchSend — cases added by the PR 1 audit:
 * cap, quiet hours and the timezone chain end to end; what counts as
 * history; contention built from real rows; concurrent dispatch; broadcasts;
 * the flow guard on re-dispatch; expiry after quiet hours.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'

import { decideContactPolicy } from '../../src/server/runner/contact-policy.js'
import { releaseDueDeferredSends } from '../../src/server/runner/contact-policy.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { runTick } from '../../src/server/runner/index.js'
import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { advance, DAY, freezeAt, HOUR, MINUTE, restoreClock } from '../matrix/clock.js'

let H: TestMailerHarness
let n = 0

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      contactPolicy: {
        marketing: { minGapHours: 20, maxPerRollingDays: { days: 7, count: 3 }, quietHours: { start: '21:00', end: '08:00' }, deferral: { maxHours: 72 } },
      },
    },
  })
  await H.seedTemplate({ slug: 'mkt', kind: 'marketing', subject: 'News' })
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (H) await H.stop()
})

afterEach(() => restoreClock())

async function contact(tz?: string) {
  n++
  await H.seedContact({ externalId: `d${n}`, email: `d${n}@example.com`, tags: [], fields: {}, ...(tz ? { timezone: tz } : {}) })
  return `d${n}`
}
async function queue(id: string, extra: Record<string, unknown> = {}) {
  const key = `${id}-${Math.random()}`
  await H.mailer.sendOneOff({ templateSlug: 'mkt', externalId: id, dedupeKey: key })
  const row = (await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:${key}` }))!
  if (Object.keys(extra).length) await H.mailer.collections.sends.updateOne({ _id: row._id }, { $set: extra })
  return row._id as ObjectId
}
async function send(id: string, extra: Record<string, unknown> = {}) {
  const sid = await queue(id, extra)
  await dispatchSend(sid, H.ctx)
  return (await H.mailer.collections.sends.findOne({ _id: sid }))!
}

describe('rules end to end', () => {
  it('a 4th marketing send in 7 days defers until the oldest leaves the window', async () => {
    const t = freezeAt('2027-02-01T12:00:00Z')
    const id = await contact()
    for (let i = 0; i < 3; i++) {
      expect((await send(id)).status).toBe('sent')
      advance(DAY)
    }
    const fourth = await send(id)
    expect(fourth).toMatchObject({ status: 'deferred', notBefore: new Date(t.getTime() + 7 * DAY) })
    expect(fourth.policyDeferral?.reason).toBe('rolling_cap')
  })

  it('quiet hours in UTC by default', async () => {
    freezeAt('2027-02-01T22:00:00Z')
    const id = await contact()
    expect(await send(id)).toMatchObject({ status: 'deferred', notBefore: new Date('2027-02-02T08:00:00Z') })
  })

  it('contact.timezone moves quiet hours', async () => {
    freezeAt('2027-02-01T22:00:00Z') // 07:00 next day in Tokyo: quiet until 08:00 JST = 23:00Z
    const id = await contact('Asia/Tokyo')
    expect(await send(id)).toMatchObject({ status: 'deferred', notBefore: new Date('2027-02-01T23:00:00Z') })
  })

  it('send.timezoneHint is used when the contact has no zone', async () => {
    freezeAt('2027-02-01T14:00:00Z') // 23:00 in Tokyo → quiet until 08:00 JST = 23:00Z
    const id = await contact()
    expect(await send(id, { timezoneHint: 'Asia/Tokyo' })).toMatchObject({ status: 'deferred', notBefore: new Date('2027-02-01T23:00:00Z') })
  })

  it('expiry is judged on the final time, after quiet hours', async () => {
    freezeAt('2027-02-01T06:00:00Z')
    const id = await contact()
    const stale = await queue(id) // queued 06:00 → deadline Feb 4 06:00
    advance(64 * HOUR) // Feb 3 22:00, inside quiet hours; now itself is within 72h
    await dispatchSend(stale, H.ctx)
    // Quiet until Feb 4 08:00 = 74h after queuing → dropped, not deferred.
    expect(await H.mailer.collections.sends.findOne({ _id: stale })).toMatchObject({ status: 'cancelled', exitReason: 'policy_expired' })
  })
})

describe('what counts as history', () => {
  it('failed, cancelled, suppressed, deferred and holdout rows never open the gap', async () => {
    freezeAt('2027-02-01T12:00:00Z')
    const id = await contact()
    for (const status of ['failed', 'cancelled', 'suppressed', 'deferred', 'holdout'] as const) {
      await queue(id, { status, sentAt: null, notBefore: status === 'deferred' ? new Date(Date.now() + 99 * DAY) : null })
    }
    advance(MINUTE)
    expect((await send(id)).status).toBe('sent')
  })
})

describe('contention from real rows', () => {
  it('a due queued flow send makes a oneoff send defer by minGapHours (default order)', async () => {
    const t = freezeAt('2027-02-01T12:00:00Z')
    const id = await contact()
    await queue(id, { flowRunId: new ObjectId() })
    const one = await send(id)
    expect(one).toMatchObject({ status: 'deferred', notBefore: new Date(t.getTime() + 20 * HOUR) })
    expect(one.policyDeferral?.reason).toBe('priority')
  })

  it('a higher-priority send that is itself deferred to later does not block', async () => {
    freezeAt('2027-02-01T12:00:00Z')
    const id = await contact()
    await queue(id, { flowRunId: new ObjectId(), status: 'deferred', notBefore: new Date(Date.now() + 5 * HOUR) })
    expect((await send(id)).status).toBe('sent')
  })
})

describe('concurrency', () => {
  it('two marketing sends dispatched in parallel → exactly one provider call', async () => {
    freezeAt('2027-02-01T12:00:00Z')
    const id = await contact()
    const a = await queue(id)
    const b = await queue(id)
    const before = H.provider.sent.length
    await Promise.all([dispatchSend(a, H.ctx), dispatchSend(b, H.ctx)])
    expect(H.provider.sent.length - before).toBe(1)
    const statuses = (await H.mailer.collections.sends.find({ _id: { $in: [a, b] } }).toArray()).map((s) => s.status).sort()
    expect(statuses).toEqual(['deferred', 'sent'])
  })

  it('two concurrent releases enqueue a due deferral once', async () => {
    freezeAt('2027-02-01T12:00:00Z')
    const id = await contact()
    const s = await queue(id, { status: 'deferred', notBefore: new Date(Date.now() - MINUTE) })
    const counts = await Promise.all([releaseDueDeferredSends(H.ctx), releaseDueDeferredSends(H.ctx)])
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1)
    expect((await H.mailer.collections.sends.findOne({ _id: s }))!.status).toBe('queued')
  })
})

describe('origins', () => {
  it('a broadcast recipient inside the gap is deferred, then released and sent', async () => {
    freezeAt('2027-02-01T12:00:00Z')
    const id = await contact()
    await send(id)
    advance(HOUR)
    await H.mailer.collections.broadcasts.insertOne({
      slug: `b-${n}`, name: 'b', templateSlug: 'mkt', segmentDefinition: { filters: [{ kind: 'fieldExists', field: '__never__' } as any] },
      status: 'draft', scheduledAt: null, startedAt: null, completedAt: null, confirmationRequired: false, confirmedCount: null,
      confirmedAt: null, confirmedBy: null, recipientCount: null,
      stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
      createdAt: new Date(), createdBy: 'test', updatedAt: new Date(),
    })
    const b = await H.mailer.collections.broadcasts.findOne({ slug: `b-${n}` })
    const sid = await queue(id, { broadcastId: b!._id })
    await dispatchSend(sid, H.ctx)
    expect((await H.mailer.collections.sends.findOne({ _id: sid }))!.status).toBe('deferred')
    advance(20 * HOUR)
    await H.drain()
    expect((await H.mailer.collections.sends.findOne({ _id: sid }))!.status).toBe('sent')
  })

  it('a deferred flow send whose run exited is cancelled by the flow guard on re-dispatch', async () => {
    freezeAt('2027-02-01T12:00:00Z')
    const id = await contact()
    await H.seedFlow({ slug: `g-${n}`, eventName: `G ${n}`, steps: [step.send('mkt')] })
    H.mailer.registerEvent({ name: `G ${n}`, dedupePolicy: 'once-per-contact' })
    await send(id)
    advance(MINUTE)
    await H.mailer.fire(`G ${n}`, id)
    await H.drain()
    const fs = (await H.mailer.collections.sends.findOne({ externalId: id, flowRunId: { $ne: null } }))!
    expect(fs.status).toBe('deferred')
    await H.mailer.collections.flowRuns.updateOne({ _id: fs.flowRunId! }, { $set: { status: 'exited', exitReason: 'aborted_by_host:test' } })
    advance(20 * HOUR)
    await runTick(H.ctx)
    await H.drain()
    expect((await H.mailer.collections.sends.findOne({ _id: fs._id }))!.status).toBe('cancelled')
  })

  it('a suppressed send never reaches its origin guard', async () => {
    freezeAt('2027-02-01T12:00:00Z')
    const id = await contact()
    let guardCalls = 0
    const saved = H.ctx.sendHooks
    H.ctx.sendHooks = { ...(saved ?? {}), oneoff: { guard: async () => { guardCalls++; return { verdict: 'send' } } } }
    try {
      await H.mailer.unsubscribe(`${id}@example.com`, { scope: 'marketing', reason: 'user_request', source: 'test' })
      expect((await send(id)).status).toBe('suppressed')
      expect(guardCalls).toBe(0)
    } finally {
      H.ctx.sendHooks = saved
    }
  })
})
