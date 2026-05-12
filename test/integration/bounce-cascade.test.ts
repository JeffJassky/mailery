/**
 * Hard-bounce cascade: applyWebhookEvent with a hard-bounce event suppresses
 * the contact + marks subscription `bounced`. A subsequent send to the same
 * contact is then skipped at dispatch time.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { applyWebhookEvent, dispatchSend } from '../../src/server/runner/index.js'
import { compileTemplate } from '../../src/server/templates/render.js'
import type { TemplateDoc, SendDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [{ externalId: 'u1', email: 'bouncer@example.com', tags: [], fields: {} }],
  })

  const compiled = await compileTemplate(`<mjml><mj-body><mj-text>Hi</mj-text></mj-body></mjml>`)
  await H.mailer.collections.templates.insertOne({
    slug: 't',
    name: 't',
    description: '',
    kind: 'marketing',
    fromName: 'T',
    fromEmail: 't@example.com',
    replyTo: null,
    providerOverride: null,
    subject: 'Hi',
    preheader: '',
    body: { mjml: '', html: compiled.html, plainText: compiled.plainText, compiledAt: new Date(), editorJson: null },
    variablesSchema: {},
    draft: null,
    tags: [],
    trackOpens: false,
    trackClicks: false,
    stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, lastSentAt: null },
    publishedAt: new Date(),
    publishedBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as TemplateDoc)
  await H.mailer.upsertSubscription({ externalId: 'u1', source: 'test' })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function makeQueuedSend(): Promise<ObjectId> {
  const template = await H.mailer.collections.templates.findOne({ slug: 't' })
  const sendId = new ObjectId()
  await H.mailer.collections.sends.insertOne({
    _id: sendId,
    dedupeKey: `bounce-test:${Date.now()}:${Math.random()}`,
    externalId: 'u1',
    emailAtSend: 'bouncer@example.com',
    templateId: template!._id!,
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
  } as SendDoc)
  return sendId
}

describe('hard-bounce cascade', () => {
  it('hard bounce adds suppression and blocks future sends', async () => {
    const ctx = H.mailer.getRunnerContext()

    // 1. Send one email — succeeds, recorded.
    const firstSendId = await makeQueuedSend()
    await dispatchSend(firstSendId, ctx)
    expect(H.provider.sent.length).toBeGreaterThan(0)
    const sentCountAfterFirst = H.provider.sent.length

    // 2. Webhook reports a hard bounce against that send's email.
    await applyWebhookEvent(
      {
        type: 'bounce',
        providerEventId: 'evt-1',
        providerMessageId: 'mid-1',
        email: 'bouncer@example.com',
        occurredAt: new Date(),
        details: { bounceType: 'hard', bounceReason: 'invalid mailbox' },
      },
      ctx,
    )

    // 3. Suppression now exists.
    const supp = await H.mailer.collections.suppressions.findOne({ email: 'bouncer@example.com' })
    expect(supp).not.toBeNull()
    expect(supp?.reason).toBe('hard_bounce')

    // 4. Subscription marked bounced.
    const sub = await H.mailer.collections.subscriptions.findOne({ externalId: 'u1' })
    expect(sub?.status).toBe('bounced')

    // 5. A new send to the same contact is suppressed at dispatch time.
    const secondSendId = await makeQueuedSend()
    await dispatchSend(secondSendId, ctx)

    const secondSend = await H.mailer.collections.sends.findOne({ _id: secondSendId })
    expect(secondSend?.status).toBe('suppressed')
    expect(H.provider.sent.length).toBe(sentCountAfterFirst) // unchanged
  })
})
