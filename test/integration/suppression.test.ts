/**
 * Suppression scenarios: a suppressed contact's send is skipped at dispatch
 * time, scope is respected (marketing-only ≠ all), GDPR-forget hashed
 * suppression also blocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/index.js'
import { compileTemplate } from '../../src/server/templates/render.js'
import { sha256Hex } from '../../src/server/tokens.js'
import type { TemplateDoc, SendDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [
      { externalId: 'u1', email: 'alice@example.com', tags: [], fields: {} },
      { externalId: 'u2', email: 'bob@example.com', tags: [], fields: {} },
    ],
  })

  const compiled = await compileTemplate(`<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`)
  const baseTemplate: Omit<TemplateDoc, 'kind' | 'slug' | 'name'> = {
    description: '',
    fromName: 'Test',
    fromEmail: 'hello@example.com',
    replyTo: null,
    providerOverride: null,
    subject: 'Hi',
    preheader: '',
    body: { mjml: '', html: compiled.html, plainText: compiled.plainText, compiledAt: new Date() },
    variablesSchema: {},
    draft: null,
    tags: [],
    trackOpens: true,
    trackClicks: true,
    stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, lastSentAt: null },
    publishedAt: new Date(),
    publishedBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  await H.mailer.collections.templates.insertMany([
    { ...baseTemplate, slug: 'mkt', name: 'Marketing', kind: 'marketing' as const },
    { ...baseTemplate, slug: 'tx', name: 'Transactional', kind: 'transactional' as const },
  ])
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function makeQueuedSend(externalId: string, templateSlug: string, kind: 'marketing' | 'transactional'): Promise<ObjectId> {
  const template = await H.mailer.collections.templates.findOne({ slug: templateSlug })
  const contact = await H.mailer.adapter.getById(externalId)
  if (!template || !contact) throw new Error('fixture missing')

  const sendId = new ObjectId()
  await H.mailer.collections.sends.insertOne({
    _id: sendId,
    dedupeKey: `test:${Date.now()}:${Math.random()}`,
    externalId,
    emailAtSend: contact.email,
    templateId: template._id!,
    templateSlug: template.slug,
    flowRunId: null,
    broadcastId: null,
    manualSendBy: 'test',
    kind,
    provider: 'null',
    providerMessageId: null,
    fromName: template.fromName,
    fromEmail: template.fromEmail,
    subject: template.subject,
    bodyHash: '',
    status: 'queued',
    errorMessage: null,
    bounceType: null,
    bounceReason: null,
    links: [],
    openedAt: null,
    openCount: 0,
    firstClickAt: null,
    clickCount: 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt: new Date(),
    sentAt: null,
    deliveredAt: null,
  } as SendDoc)
  return sendId
}

describe('suppression checks at dispatch time', () => {
  it('skips a send when contact is suppressed (scope:all)', async () => {
    await H.mailer.suppress('alice@example.com', { scope: 'all', reason: 'manual', source: 'test' })
    const sentBefore = H.provider.sent.length

    const sendId = await makeQueuedSend('u1', 'mkt', 'marketing')
    await dispatchSend(sendId, H.mailer.getRunnerContext())

    const after = await H.mailer.collections.sends.findOne({ _id: sendId })
    expect(after?.status).toBe('suppressed')
    expect(H.provider.sent.length).toBe(sentBefore)
  })

  it('marketing suppression does NOT block transactional sends', async () => {
    await H.mailer.suppress('bob@example.com', { scope: 'marketing', reason: 'unsubscribed', source: 'test' })
    const sentBefore = H.provider.sent.length

    const sendId = await makeQueuedSend('u2', 'tx', 'transactional')
    await dispatchSend(sendId, H.mailer.getRunnerContext())

    const after = await H.mailer.collections.sends.findOne({ _id: sendId })
    expect(after?.status).toBe('sent')
    expect(H.provider.sent.length).toBe(sentBefore + 1)
  })

  it('marketing suppression DOES block marketing sends', async () => {
    const sentBefore = H.provider.sent.length

    const sendId = await makeQueuedSend('u2', 'mkt', 'marketing')
    await dispatchSend(sendId, H.mailer.getRunnerContext())

    const after = await H.mailer.collections.sends.findOne({ _id: sendId })
    expect(after?.status).toBe('suppressed')
    expect(H.provider.sent.length).toBe(sentBefore)
  })

  it('GDPR hashed-suppression blocks sends without plaintext email', async () => {
    // Simulate a forgotten contact: insert a hashed suppression row, no plaintext.
    const newEmail = 'charlie@example.com'
    H.memoryAdapter!.upsert({ externalId: 'u3', email: newEmail, tags: [], fields: {} })

    await H.mailer.collections.suppressions.insertOne({
      email: null,
      emailHash: sha256Hex(newEmail),
      scope: 'all',
      reason: 'gdpr_forget',
      source: 'gdpr_request',
      notes: null,
      addedAt: new Date(),
      expiresAt: null,
    })

    const sentBefore = H.provider.sent.length

    const sendId = await makeQueuedSend('u3', 'mkt', 'marketing')
    await dispatchSend(sendId, H.mailer.getRunnerContext())

    const after = await H.mailer.collections.sends.findOne({ _id: sendId })
    expect(after?.status).toBe('suppressed')
    expect(after?.errorMessage).toContain('gdpr_forget')
    expect(H.provider.sent.length).toBe(sentBefore)
  })
})
