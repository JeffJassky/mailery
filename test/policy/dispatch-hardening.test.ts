/** Contact-policy hardening: lock renewal/ownership, lock errors, broadcasts with deferred sends, abort outcomes. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'

import { acquireRecipientLock, CONTACT_LOCK_TIMINGS } from '../../src/server/runner/contact-policy.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { evaluateBroadcastStopRules } from '../../src/server/runner/broadcast-control.js'
import { cancelBroadcast } from '../../src/server/api/broadcast-ops.js'
import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import type { SendHooks } from '../../src/server/runner/send-hooks.js'

let H: TestMailerHarness
let n = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  H = await createTestMailer({ config: { contactPolicy: { marketing: { minGapHours: 20 } } } })
  await H.seedTemplate({ slug: 'mkt', kind: 'marketing', subject: 'News' })
}, 120_000)
afterAll(async () => { if (H) await H.stop() })

async function contact() {
  n++
  await H.seedContact({ externalId: `h${n}`, email: `h${n}@example.com`, tags: [], fields: {} })
  return `h${n}`
}
async function queue(id: string, extra: Record<string, unknown> = {}) {
  const key = `${id}-${Math.random()}`
  await H.mailer.sendOneOff({ templateSlug: 'mkt', externalId: id, dedupeKey: key })
  const row = (await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:${key}` }))!
  if (Object.keys(extra).length) await H.mailer.collections.sends.updateOne({ _id: row._id }, { $set: extra })
  return row._id as ObjectId
}

describe('recipient lock', () => {
  it('is renewed while held, so a second taker cannot get it after the TTL', async () => {
    const saved = { ...CONTACT_LOCK_TIMINGS }
    Object.assign(CONTACT_LOCK_TIMINGS, { ttlMs: 300, renewMs: 80, waitMs: 100 })
    try {
      const release = (await acquireRecipientLock(H.ctx, 'lock1@example.com'))!
      expect(release).toBeTypeOf('function')
      await sleep(900) // three TTLs
      expect(await acquireRecipientLock(H.ctx, 'lock1@example.com')).toBeNull()
      await release()
      const again = await acquireRecipientLock(H.ctx, 'lock1@example.com')
      expect(again).toBeTypeOf('function')
      await again!()
    } finally {
      Object.assign(CONTACT_LOCK_TIMINGS, saved)
    }
  })

  it('release only removes a lock the caller owns', async () => {
    const release = (await acquireRecipientLock(H.ctx, 'lock2@example.com'))!
    await H.mailer.collections.contactLocks.updateOne({ _id: 'lock2@example.com' }, { $set: { owner: 'someone-else' } })
    await release()
    expect(await H.mailer.collections.contactLocks.findOne({ _id: 'lock2@example.com' })).toMatchObject({ owner: 'someone-else' })
    await H.mailer.collections.contactLocks.deleteOne({ _id: 'lock2@example.com' })
  })

  it('a lock error returns the claim for retry instead of stranding the row in sending', async () => {
    const id = await contact()
    const sid = await queue(id)
    const spy = vi.spyOn(H.mailer.collections.contactLocks, 'updateOne').mockRejectedValueOnce(new Error('mongo down'))
    await expect(dispatchSend(sid, H.ctx)).rejects.toThrow('mongo down')
    spy.mockRestore()
    const row = (await H.mailer.collections.sends.findOne({ _id: sid }))!
    expect(row.status).toBe('failed')
    await dispatchSend(sid, H.ctx)
    expect((await H.mailer.collections.sends.findOne({ _id: sid }))!.status).toBe('sent')
  })
})

describe('broadcasts and deferred sends', () => {
  async function broadcast(status: string) {
    n++
    await H.mailer.collections.broadcasts.insertOne({
      slug: `hb-${n}`, name: 'b', templateSlug: 'mkt', segmentDefinition: { filters: [{ kind: 'fieldExists', field: '__never__' } as any] },
      status: status as any, scheduledAt: null, startedAt: null, completedAt: null, confirmationRequired: false, confirmedCount: null,
      confirmedAt: null, confirmedBy: null, recipientCount: null,
      stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
      createdAt: new Date(), createdBy: 'test', updatedAt: new Date(),
    } as any)
    return (await H.mailer.collections.broadcasts.findOne({ slug: `hb-${n}` }))!
  }

  it('cancelling a broadcast cancels its deferred sends', async () => {
    const b = await broadcast('sent')
    const id = await contact()
    const sid = await queue(id, { broadcastId: b._id, status: 'deferred', notBefore: new Date(Date.now() + 3_600_000) })
    const res = await cancelBroadcast(H.mailer, b.slug, 'test')
    expect(res.cancelledSends).toBe(1)
    expect((await H.mailer.collections.sends.findOne({ _id: sid }))!.status).toBe('cancelled')
  })

  it('a stop-rule breach on a "sent" broadcast with only a deferred send left still pauses it', async () => {
    const b = await broadcast('sent')
    await H.mailer.collections.broadcasts.updateOne({ _id: b._id }, { $set: { stopRules: { enabled: true, minSample: 1, hardBounceRatePct: 1, complaintRatePct: 100, unsubscribeRatePct: 100 } } })
    const id = await contact()
    await queue(id, { broadcastId: b._id, status: 'deferred', notBefore: new Date(Date.now() + 3_600_000) })
    const id2 = await contact()
    await queue(id2, { broadcastId: b._id, status: 'bounced', bounceType: 'hard', sentAt: new Date() })
    await evaluateBroadcastStopRules(H.ctx, b._id!)
    const after = (await H.mailer.collections.broadcasts.findOne({ _id: b._id }))!
    // Not treated as "everything already went out": it is paused, not just annotated.
    expect(after.status).toBe('paused')
  })
})

describe('abort emits outcomes', () => {
  it('abortFlow reports cancelled to the flow onOutcome for deferred sends', async () => {
    const id = await contact()
    await H.seedFlow({ slug: `hf-${n}`, eventName: `HF ${n}`, steps: [step.send('mkt')] })
    H.mailer.registerEvent({ name: `HF ${n}`, dedupePolicy: 'once-per-contact' })
    await H.mailer.fire(`HF ${n}`, id)
    await H.drain()
    const row = (await H.mailer.collections.sends.findOne({ externalId: id, flowRunId: { $ne: null } }))!
    await H.mailer.collections.sends.updateOne({ _id: row._id }, { $set: { status: 'deferred', notBefore: new Date(Date.now() + 3_600_000) } })
    const seen: string[] = []
    const saved: SendHooks | undefined = H.ctx.sendHooks
    H.ctx.sendHooks = { ...(saved ?? {}), flow: { ...(saved?.flow ?? {}), onOutcome: async (_s, o) => { seen.push(o.status) } } }
    try {
      const res = await H.mailer.abortFlow(`hf-${n}`, id, { reason: 'x' })
      expect(res.cancelledSends).toBe(1)
    } finally {
      H.ctx.sendHooks = saved
    }
    expect(seen).toEqual(['cancelled'])
  })
})
