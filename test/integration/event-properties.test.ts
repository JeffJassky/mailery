/**
 * Trigger-event properties end-to-end: fire(name, id, properties) → the flow
 * run snapshots the event → templates render `{{event.*}}` → varsAdapter's
 * resolver receives `info.eventProperties` and can scope its lookups
 * (account/topic flows for users who belong to many accounts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { dispatchSend, processOneRunStep, runTick } from '../../src/server/runner/index.js'
import { defineVars, type VarsResolveInfo } from '../../src/server/adapters/vars.js'
import { compileTemplate } from '../../src/server/templates/render.js'
import type { TemplateDoc, FlowDoc } from '../../src/server/models/index.js'
import type { FlowStep } from '../../src/shared/types.js'

let H: TestMailerHarness
const resolveCalls: VarsResolveInfo[] = []

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [
      { externalId: 'u1', email: 'alice@example.com', tags: [], fields: { firstName: 'Alice' } },
    ],
    config: {
      varsAdapter: defineVars({
        schema: z.object({ topic: z.object({ title: z.string() }).nullable() }),
        async resolve(_contact, info) {
          resolveCalls.push(info)
          const topicId = info.eventProperties?.topicId
          return { topic: topicId ? { title: `Topic ${topicId}` } : null }
        },
      }),
    },
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('trigger-event properties', () => {
  it('snapshots properties on the run, renders {{event.*}}, and scopes the resolver', async () => {
    const { mailer, db, provider } = H
    const ctx = mailer.getRunnerContext()

    await mailer.upsertSubscription({ externalId: 'u1', source: 'test' })

    const compiled = await compileTemplate(
      `<mjml><mj-body><mj-section><mj-column><mj-text>Update for account {{event.accountId}}: {{topic.title}} is ready. <a href="{{unsubscribeUrl}}">unsub</a></mj-text></mj-column></mj-section></mj-body></mjml>`,
    )
    const tpl: TemplateDoc = {
      slug: 'topic-ready',
      name: 'Topic ready',
      description: '',
      kind: 'marketing',
      fromName: 'Test',
      fromEmail: 'hello@example.com',
      replyTo: null,
      providerOverride: null,
      subject: '{{topic.title}} ready',
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
    await db.collection('mailer_templates').insertOne(tpl)

    const steps: FlowStep[] = [{ type: 'send', templateSlug: 'topic-ready' }]
    const flow: FlowDoc = {
      slug: 'topic-ready-flow',
      name: 'Topic ready',
      description: '',
      trigger: { type: 'event', eventName: 'TopicReady', once: false },
      enabled: true,
      steps,
      version: 1,
      draft: null,
      goal: 'activation',
      audience: 'members',
      expectedVolumePerWeek: null,
      stats: { activeRuns: 0, completedRuns: 0, sendsTotal: 0, sendsLast7Days: 0 },
      lastTriggerScanAt: null,
      publishedAt: new Date(),
      publishedBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await db.collection('mailer_flows').insertOne(flow)

    mailer.registerEvent({ name: 'TopicReady', dedupePolicy: 'every-time' })
    await mailer.fire('TopicReady', 'u1', { accountId: 'acct-9', topicId: 't-42' }, 'topic-ready:acct-9:t-42:u1')

    await runTick(ctx)

    const run = await mailer.collections.flowRuns.findOne({ externalId: 'u1', flowSlug: 'topic-ready-flow' })
    expect(run).not.toBeNull()
    expect(run!.triggerEvent).toMatchObject({
      name: 'TopicReady',
      properties: { accountId: 'acct-9', topicId: 't-42' },
    })

    await processOneRunStep(run!._id!, ctx)
    const send = await mailer.collections.sends.findOne({ flowRunId: run!._id })
    expect(send).not.toBeNull()
    await dispatchSend(send!._id!, ctx)

    const sent = provider.sent.find((s) => s.subject === 'Topic t-42 ready')
    expect(sent).toBeDefined()
    expect(sent!.html).toContain('account acct-9')
    expect(sent!.html).toContain('Topic t-42 is ready')

    // The resolver saw the event context on the actual dispatch.
    const dispatchCall = resolveCalls.find((c) => c.reason === 'send' && c.eventProperties?.topicId === 't-42')
    expect(dispatchCall).toBeDefined()
    expect(dispatchCall!.eventName).toBe('TopicReady')
    expect(dispatchCall!.flowSlug).toBe('topic-ready-flow')
  }, 60_000)
})
