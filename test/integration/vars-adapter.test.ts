/**
 * varsAdapter end-to-end: sendOneOff → dispatchSend renders host-resolved
 * variables at the render-context root, and resolver failures mark the send
 * failed + rethrow (queue retry) instead of dispatching half-rendered mail.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ObjectId } from 'mongodb'
import { z } from 'zod'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/index.js'
import { defineVars } from '../../src/server/adapters/vars.js'
import { compileTemplate } from '../../src/server/templates/render.js'
import type { TemplateDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness
let failResolver = false

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [
      { externalId: 'u1', email: 'alice@example.com', tags: [], fields: { firstName: 'Alice' } },
    ],
    config: {
      varsAdapter: defineVars({
        schema: z.object({
          user: z.object({ name: z.string() }),
          firstActiveTopic: z.object({ title: z.string() }).nullable(),
        }),
        async resolve(contact) {
          if (failResolver) throw new Error('host db down')
          return {
            user: { name: contact.fields.firstName as string },
            firstActiveTopic: { title: `Topic for ${contact.externalId}` },
          }
        },
      }),
    },
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function insertTemplate(slug: string): Promise<void> {
  const compiled = await compileTemplate(
    `<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{user.name}}, read {{firstActiveTopic.title}}. <a href="{{unsubscribeUrl}}">unsub</a></mj-text></mj-column></mj-section></mj-body></mjml>`,
  )
  const doc: TemplateDoc = {
    slug,
    name: slug,
    description: '',
    kind: 'marketing',
    fromName: 'Test',
    fromEmail: 'hello@example.com',
    replyTo: null,
    providerOverride: null,
    subject: 'For {{user.name}}',
    preheader: '',
    body: { mjml: '', editorJson: null, html: compiled.html, plainText: compiled.plainText, compiledAt: new Date() },
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
  }
  await H.db.collection('mailer_templates').insertOne(doc)
}

describe('varsAdapter in the send pipeline', () => {
  it('renders resolved vars into subject and body at dispatch time', async () => {
    const { mailer, provider } = H
    await mailer.upsertSubscription({ externalId: 'u1', source: 'test' })
    await insertTemplate('vars-tpl')

    const { sendId } = await mailer.sendOneOff({
      templateSlug: 'vars-tpl',
      externalId: 'u1',
      dedupeKey: 'vars-test-1',
    })
    await dispatchSend(new ObjectId(sendId), mailer.getRunnerContext())

    const sent = provider.sent.find((s) => s.subject === 'For Alice')
    expect(sent).toBeDefined()
    expect(sent!.html).toContain('Hi Alice')
    expect(sent!.html).toContain('Topic for u1')

    const doc = await H.db.collection('mailer_sends').findOne({ _id: new ObjectId(sendId) })
    expect(doc!.status).toBe('sent')
  })

  it('marks the send failed and rethrows when the resolver throws', async () => {
    const { mailer } = H
    await insertTemplate('vars-tpl-2')
    const { sendId } = await mailer.sendOneOff({
      templateSlug: 'vars-tpl-2',
      externalId: 'u1',
      dedupeKey: 'vars-test-2',
    })

    failResolver = true
    try {
      await expect(dispatchSend(new ObjectId(sendId), mailer.getRunnerContext())).rejects.toThrow('host db down')
    } finally {
      failResolver = false
    }

    const doc = await H.db.collection('mailer_sends').findOne({ _id: new ObjectId(sendId) })
    expect(doc!.status).toBe('failed')
    expect(doc!.errorMessage).toContain('host db down')

    // Retry (as the queue would) succeeds once the host is back.
    await dispatchSend(new ObjectId(sendId), mailer.getRunnerContext())
    const retried = await H.db.collection('mailer_sends').findOne({ _id: new ObjectId(sendId) })
    expect(retried!.status).toBe('sent')
  })
})
