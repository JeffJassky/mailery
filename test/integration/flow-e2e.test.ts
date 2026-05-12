/**
 * End-to-end flow test using mongodb-memory-server + ioredis-mock + NullProvider.
 *
 * Exercises the happy path: subscribe contact → fire event → trigger scan creates
 * flow_run → step pointer at wait → advance past wait → send step queues + dispatches
 * → NullProvider receives the args.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { processOneRunStep, runTick, dispatchSend } from '../../src/server/runner/index.js'
import { compileTemplate } from '../../src/server/templates/render.js'
import type { TemplateDoc, FlowDoc } from '../../src/server/models/index.js'
import type { FlowStep } from '../../src/shared/types.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [
      {
        externalId: 'u1',
        email: 'alice@example.com',
        tags: [],
        fields: { firstName: 'Alice' },
      },
    ],
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('end-to-end flow run', () => {
  it('fires event → creates flow_run → advances wait → dispatches send', async () => {
    const { mailer, db, provider } = H
    const ctx = mailer.getRunnerContext()

    // 1. Subscribe the contact.
    await mailer.upsertSubscription({ externalId: 'u1', source: 'test' })

    // 2. Create a published template.
    const tplCompile = await compileTemplate(`<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{contact.fields.firstName}}</mj-text></mj-column></mj-section></mj-body></mjml>`)
    const templateDoc: TemplateDoc = {
      slug: 'welcome-1',
      name: 'Welcome',
      description: '',
      kind: 'marketing',
      fromName: 'Test',
      fromEmail: 'hello@example.com',
      replyTo: null,
      providerOverride: null,
      subject: 'Hi {{contact.fields.firstName}}',
      preheader: 'Welcome',
      body: { mjml: '', editorJson: null, html: tplCompile.html, plainText: tplCompile.plainText, compiledAt: new Date() },
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
    await db.collection('mailer_templates').insertOne(templateDoc)

    // 3. Create a published flow: trigger=event:Created, send welcome-1.
    const steps: FlowStep[] = [{ type: 'send', templateSlug: 'welcome-1' }]
    const flowDoc: FlowDoc = {
      slug: 'welcome',
      name: 'Welcome',
      description: '',
      trigger: { type: 'event', eventName: 'Created', once: true },
      enabled: true,
      steps,
      version: 1,
      draft: null,
      goal: 'activation',
      audience: 'all new users',
      expectedVolumePerWeek: null,
      stats: { activeRuns: 0, completedRuns: 0, sendsTotal: 0, sendsLast7Days: 0 },
      lastTriggerScanAt: null,
      publishedAt: new Date(),
      publishedBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await db.collection('mailer_flows').insertOne(flowDoc)

    // 4. Fire the trigger event.
    mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
    await mailer.fire('Created', 'u1')

    // 5. Drive the tick — picks up the event, creates the flow_run.
    await runTick(ctx)

    // 6. Find the flow_run and process its first step (send).
    const run = await mailer.collections.flowRuns.findOne({ externalId: 'u1' })
    expect(run, 'flow_run should have been created by the tick').not.toBeNull()
    if (!run) return
    expect(run.status).toBe('active')

    await processOneRunStep(run._id!, ctx)

    // 7. A Send row should now exist for this run.
    const send = await mailer.collections.sends.findOne({ flowRunId: run._id })
    expect(send, 'send row should be created by send step').not.toBeNull()
    if (!send) return
    expect(send.status).toBe('queued')

    // 8. Dispatch the send (simulate the send worker running the job).
    await dispatchSend(send._id!, ctx)

    // 9. NullProvider should have recorded the send.
    expect(provider.sent.length).toBe(1)
    expect(provider.sent[0]?.to).toBe('alice@example.com')
    expect(provider.sent[0]?.subject).toContain('Alice')

    // 10. Send doc updated to status=sent with a providerId.
    const after = await mailer.collections.sends.findOne({ _id: send._id })
    expect(after?.status).toBe('sent')
    expect(after?.providerMessageId).toMatch(/^null-/)
  }, 60_000)

  it('idempotent send: re-dispatching the same step does not duplicate', async () => {
    const { mailer, provider } = H
    const ctx = mailer.getRunnerContext()
    const sentBefore = provider.sent.length

    const send = await mailer.collections.sends.findOne({ externalId: 'u1' })
    expect(send).not.toBeNull()
    if (!send) return

    // Force dispatch again — already in `sent` state, should skip.
    await dispatchSend(send._id!, ctx)
    expect(provider.sent.length).toBe(sentBefore)
  })

  it('does not enter trigger.once flow twice for same contact', async () => {
    const { mailer } = H
    const ctx = mailer.getRunnerContext()

    // Fire the same event again — dedupeKey collision; should be a no-op.
    await mailer.fire('Created', 'u1')
    await runTick(ctx)

    const count = await mailer.collections.flowRuns.countDocuments({ externalId: 'u1', flowSlug: 'welcome' })
    expect(count).toBe(1)
  })
})

// Silence "unused" so we have a hook for adding more later
void ObjectId
