/**
 * Stranded-send sweep: a send stuck in 'sending' past the threshold is reset
 * to 'queued' on the next tick, and the run-tick path re-enqueues it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { runTick } from '../../src/server/runner/index.js'
import type { SendDoc, TemplateDoc } from '../../src/server/models/index.js'
import { sha256Hex } from '../../src/server/tokens.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [{ externalId: 'u1', email: 'a@example.com', tags: [], fields: {} }],
  })

  await H.mailer.collections.templates.insertOne({
    slug: 'welcome',
    name: 'Welcome',
    description: '',
    kind: 'marketing',
    fromName: 'Test',
    fromEmail: 'hello@example.com',
    replyTo: null,
    subject: 'Hi',
    preheader: '',
    body: { mjml: '<mjml></mjml>', editorJson: null, html: '<html></html>', plainText: 'Hi', compiledAt: new Date() },
    draft: null,
    publishedAt: new Date(),
    publishedBy: 'test',
    providerOverride: null,
    trackOpens: true,
    trackClicks: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as TemplateDoc)
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('stranded-send sweep', () => {
  it('resets sends stuck in sending past the threshold', async () => {
    const ancient = new Date(Date.now() - 10 * 60 * 1000)
    const fresh = new Date()

    const strandedId = new ObjectId()
    const freshId = new ObjectId()

    const baseSend: Omit<SendDoc, '_id' | 'dedupeKey' | 'status' | 'updatedAt' | 'queuedAt'> = {
      externalId: 'u1',
      emailAtSend: 'a@example.com',
      templateId: new ObjectId(),
      templateSlug: 'welcome',
      flowRunId: null,
      broadcastId: null,
      manualSendBy: null,
      kind: 'marketing',
      provider: 'null',
      providerMessageId: null,
      fromName: 'Test',
      fromEmail: 'hello@example.com',
      subject: 'Hi',
      bodyHash: sha256Hex('x'),
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
      sentAt: null,
      deliveredAt: null,
    }

    await H.mailer.collections.sends.insertMany([
      { _id: strandedId, dedupeKey: 'stranded', status: 'sending', queuedAt: ancient, updatedAt: ancient, ...baseSend } as SendDoc,
      { _id: freshId, dedupeKey: 'fresh', status: 'sending', queuedAt: fresh, updatedAt: fresh, ...baseSend } as SendDoc,
    ])

    await runTick(H.mailer.getRunnerContext())

    const stranded = await H.mailer.collections.sends.findOne({ _id: strandedId })
    const recent = await H.mailer.collections.sends.findOne({ _id: freshId })

    expect(stranded?.status).toBe('queued')
    expect(recent?.status).toBe('sending')
  })
})
