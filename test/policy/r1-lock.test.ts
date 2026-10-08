/** R1: suppression is re-checked after the recipient lock is acquired (INVARIANT 3). */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { acquireRecipientLock, CONTACT_LOCK_TIMINGS } from '../../src/server/runner/contact-policy.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

let H: TestMailerHarness
beforeAll(async () => {
  H = await createTestMailer({ config: { contactPolicy: { marketing: { minGapHours: 20 } } } })
  await H.seedTemplate({ slug: 'mkt', kind: 'marketing', subject: 'News' })
  await H.seedContact({ externalId: 'l1', email: 'lock-unsub@example.com', tags: [], fields: {} })
}, 120_000)
afterAll(async () => { if (H) await H.stop() })

describe('suppression re-check after the lock wait', () => {
  it('an unsubscribe that lands while dispatch waits for the lock stops the send', async () => {
    const saved = { ...CONTACT_LOCK_TIMINGS }
    Object.assign(CONTACT_LOCK_TIMINGS, { ttlMs: 5_000, renewMs: 1_000, waitMs: 3_000 })
    try {
      await H.mailer.sendOneOff({ templateSlug: 'mkt', externalId: 'l1', dedupeKey: 'lock-k' })
      const row = (await H.mailer.collections.sends.findOne({ dedupeKey: 'oneoff:lock-k' }))!
      const holder = (await acquireRecipientLock(H.ctx, 'lock-unsub@example.com'))!
      const before = H.provider.sent.length
      const dispatching = dispatchSend(row._id!, H.ctx)
      await new Promise((r) => setTimeout(r, 200)) // dispatch is now waiting on the lock
      await H.mailer.unsubscribe('lock-unsub@example.com', { scope: 'marketing', reason: 'user_request', source: 'test' })
      await holder()
      await dispatching
      const after = (await H.mailer.collections.sends.findOne({ _id: row._id }))!
      expect(after.status).toBe('suppressed')
      expect(H.provider.sent.length).toBe(before)
    } finally {
      Object.assign(CONTACT_LOCK_TIMINGS, saved)
    }
  })
})
