/**
 * A contact whose email the host has blanked (account deletion scrubs it but
 * may leave the row) must not produce a send to "".
 *
 *   - the flow runner exits the run before any step, so nothing is queued
 *   - a send already queued before the email was blanked fails once, with a
 *     readable reason, without counting as a provider failure or retrying
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { runTick } from '../../src/server/runner/index.js'
import { healthBucketId } from '../../src/server/models/index.js'
import type { SendDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer()
  await H.seedTemplate({ slug: 'welcome', subject: 'Hello', text: 'Hello' })
  await H.seedFlow({ slug: 'drip', eventName: 'Created', steps: [step.send('welcome')] })
  H.mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('contact with no email address', () => {
  it('exits the flow run instead of queuing a send', async () => {
    await H.seedContact({ externalId: 'gone', email: '', tags: [], fields: {} })

    await H.mailer.fire('Created', 'gone')
    await runTick(H.mailer.getRunnerContext())
    await H.drain()

    expect(await H.mailer.collections.sends.countDocuments({ externalId: 'gone' })).toBe(0)
    const active = await H.mailer.collections.flowRuns.countDocuments({ externalId: 'gone', status: 'active' })
    expect(active).toBe(0)
  }, 60_000)

  it('fails an already-queued send once, without a provider call or health counter', async () => {
    await H.seedContact({ externalId: 'scrubbed', email: '', tags: [], fields: {} })
    const tpl = await H.mailer.collections.templates.findOne({ slug: 'welcome' })
    const now = new Date()
    const row = {
      _id: new ObjectId(),
      dedupeKey: `no-recipient:${now.getTime()}`,
      externalId: 'scrubbed',
      emailAtSend: '',
      templateId: tpl!._id!,
      templateSlug: 'welcome',
      flowRunId: null,
      broadcastId: null,
      manualSendBy: 'test',
      kind: 'marketing',
      provider: 'null',
      providerMessageId: null,
      fromName: 'Test',
      fromEmail: 'hello@example.com',
      subject: 'Hello',
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
      queuedAt: now,
      updatedAt: now,
      sentAt: null,
      deliveredAt: null,
    } as SendDoc
    await H.mailer.collections.sends.insertOne(row as any)

    const sentBefore = H.provider.sent.length
    const result = await H.drain()

    expect(result.errors).toEqual([])
    const doc = await H.mailer.collections.sends.findOne({ _id: row._id })
    expect(doc?.status).toBe('failed')
    expect(doc?.errorMessage).toContain('no_recipient')
    expect(H.provider.sent.length).toBe(sentBefore)

    const bucket = await H.mailer.collections.health.findOne({
      _id: healthBucketId('example.com', 'marketing'),
    })
    expect(bucket?.counters.failedToSend ?? 0).toBe(0)
  }, 60_000)
})
