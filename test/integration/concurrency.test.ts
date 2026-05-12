/**
 * Concurrency: two workers racing on the same flow_run advance must produce
 * exactly one send (INVARIANT — dedupeKey unique + optimistic-concurrency on
 * currentStepIndex).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { processOneRunStep, dispatchSend } from '../../src/server/runner/index.js'
import { compileTemplate } from '../../src/server/templates/render.js'
import type { TemplateDoc, FlowDoc } from '../../src/server/models/index.js'
import type { FlowStep } from '../../src/shared/types.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [{ externalId: 'u1', email: 'alice@example.com', tags: [], fields: {} }],
  })

  const compiled = await compileTemplate(`<mjml><mj-body><mj-text>Hi</mj-text></mj-body></mjml>`)
  const tpl: TemplateDoc = {
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
  }
  await H.mailer.collections.templates.insertOne(tpl)

  const steps: FlowStep[] = [{ type: 'send', templateSlug: 't' }]
  const flow: FlowDoc = {
    slug: 'f',
    name: 'F',
    description: '',
    trigger: { type: 'event', eventName: 'Created', once: true },
    enabled: true,
    steps,
    version: 1,
    draft: null,
    goal: 'activation',
    audience: '',
    expectedVolumePerWeek: null,
    stats: { activeRuns: 0, completedRuns: 0, sendsTotal: 0, sendsLast7Days: 0 },
    lastTriggerScanAt: null,
    publishedAt: new Date(),
    publishedBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  await H.mailer.collections.flows.insertOne(flow)
  await H.mailer.upsertSubscription({ externalId: 'u1', source: 'test' })
  H.mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
  await H.mailer.fire('Created', 'u1')

  const { runTick } = await import('../../src/server/runner/index.js')
  await runTick(H.mailer.getRunnerContext())
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('runner concurrency', () => {
  it('two parallel processOneRunStep calls produce exactly one send', async () => {
    const ctx = H.mailer.getRunnerContext()
    const run = await H.mailer.collections.flowRuns.findOne({ externalId: 'u1' })
    expect(run).not.toBeNull()
    if (!run) return

    // Race two advances. The dedupeKey + currentStepIndex CAS ensures only one wins.
    await Promise.all([processOneRunStep(run._id!, ctx), processOneRunStep(run._id!, ctx)])

    const sends = await H.mailer.collections.sends.find({ flowRunId: run._id }).toArray()
    expect(sends.length).toBe(1)

    // Dispatch the send.
    await dispatchSend(sends[0]!._id!, ctx)
    expect(H.provider.sent.length).toBe(1)
  })
})
