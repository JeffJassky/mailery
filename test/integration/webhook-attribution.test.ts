/**
 * Webhook → send attribution: an event whose provider message id matches a
 * send lands on THAT send, even when a newer send to the same address exists;
 * the by-address fallback only ever picks a send that reached the provider.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { applyWebhookEvent, findSendForEvent, webhookEventsForMessageId } from '../../src/server/runner/index.js'
import type { SendDoc, TemplateDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness
let template: TemplateDoc
const EMAIL = 'two@example.com'

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [{ externalId: 'u1', email: EMAIL, tags: [], fields: {} }],
  })
  template = await H.seedTemplate({ slug: 't', subject: 'Hi', html: '<p>Hi</p>' })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function insertSend(overrides: Partial<SendDoc>): Promise<ObjectId> {
  const _id = new ObjectId()
  await H.mailer.collections.sends.insertOne({
    _id,
    dedupeKey: `attr:${_id.toHexString()}`,
    externalId: 'u1',
    emailAtSend: EMAIL,
    templateId: template._id!,
    templateSlug: 't',
    flowRunId: null,
    broadcastId: null,
    manualSendBy: 'test',
    kind: 'marketing',
    provider: 'null',
    providerMessageId: null,
    fromName: 'T',
    fromEmail: 't@example.com',
    subject: 'Hi',
    bodyHash: '',
    status: 'queued',
    errorMessage: null,
    bounceType: null,
    bounceReason: null,
    links: [],
    vars: {},
    openedAt: null,
    openCount: 0,
    firstClickAt: null,
    clickCount: 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt: new Date(),
    updatedAt: new Date(),
    sentAt: null,
    deliveredAt: null,
    ...overrides,
  } as SendDoc)
  return _id
}

function delivered(providerMessageId: string, at = new Date()) {
  return {
    type: 'delivered' as const,
    providerEventId: `ev-${providerMessageId}-${at.getTime()}`,
    providerMessageId,
    email: EMAIL,
    occurredAt: at,
    details: {},
  }
}

describe('applyWebhookEvent attribution', () => {
  it('pins a delivery to the send whose id matches, not the newest send for the address', async () => {
    const older = await insertSend({ providerMessageId: 'msg-old', status: 'sent', sentAt: new Date(Date.now() - 60_000) })
    const newer = await insertSend({ providerMessageId: 'msg-new', status: 'sent', sentAt: new Date(Date.now() - 10_000) })
    const inFlight = await insertSend({ status: 'sending' })

    await applyWebhookEvent(delivered('msg-old'), H.mailer.getRunnerContext())

    const [o, n, f] = await Promise.all([older, newer, inFlight].map((id) => H.mailer.collections.sends.findOne({ _id: id })))
    expect(o!.status).toBe('delivered')
    expect(o!.deliveredAt).toBeInstanceOf(Date)
    expect(n!.status).toBe('sent')
    expect(n!.deliveredAt).toBeNull()
    expect(f!.status).toBe('sending')
    expect(f!.deliveredAt).toBeNull()
  })

  it('falls back by address only to the newest send that reached the provider', async () => {
    const ctx = H.mailer.getRunnerContext()
    const unknown = delivered('msg-nobody-stored')
    const picked = await findSendForEvent(unknown, ctx)
    expect(picked?.providerMessageId).toBe('msg-new')
    expect(picked?.sentAt).toBeInstanceOf(Date)

    await applyWebhookEvent(unknown, ctx)
    const stillQueued = await H.mailer.collections.sends.find({ sentAt: null }).toArray()
    for (const s of stillQueued) expect(s.deliveredAt).toBeNull()
  })

  it('never invents a match for an event with neither id nor address', async () => {
    expect(await findSendForEvent({ ...delivered(''), email: '' }, H.mailer.getRunnerContext())).toBeNull()
  })
})

describe('webhookEventsForMessageId', () => {
  it('matches the exact id and the id with a routing suffix, nothing else', async () => {
    const base = { provider: 'sendgrid', eventType: 'delivered', normalizedType: 'delivered' as const, email: EMAIL, occurredAt: new Date(), receivedAt: new Date(), processed: true, raw: {} }
    await H.mailer.collections.webhookEvents.insertMany([
      { ...base, providerEventId: 'a', providerMessageId: 'Ik7M_IBQT2uKYBiG8lDJTA' },
      { ...base, providerEventId: 'b', providerMessageId: 'Ik7M_IBQT2uKYBiG8lDJTA.filterdrecv-p3iad2-1-0' },
      { ...base, providerEventId: 'c', providerMessageId: 'Ik7M_IBQT2uKYBiG8lDJTAX' },
      { ...base, providerEventId: 'd', providerMessageId: 'x.Ik7M_IBQT2uKYBiG8lDJTA' },
    ])
    const rows = await H.mailer.collections.webhookEvents.find(webhookEventsForMessageId('Ik7M_IBQT2uKYBiG8lDJTA')).toArray()
    expect(rows.map((r) => r.providerEventId).sort()).toEqual(['a', 'b'])
    // regex metacharacters in an id are literal
    expect(await H.mailer.collections.webhookEvents.countDocuments(webhookEventsForMessageId('Ik7M_IBQT2uKYBiG8lDJ.A'))).toBe(0)
  })
})
