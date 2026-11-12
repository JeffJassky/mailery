/**
 * `wait_until` through the HTTP surfaces (plans/19a §6 steps 4–6):
 *
 *   - admin `POST /flows/:slug/publish` blocks a `wait_until` the runner could
 *     not evaluate (no adapter, undeclared fact, non-date fact) with a 422 in
 *     the program-publish issue shape, and leaves the flow untouched;
 *   - agent `POST /flows/:slug/simulate` projects `wait_until` times from live
 *     facts, or from a `facts` override in the body;
 *   - agent `POST /runs/:id/advance` moves a run PAST a parked `wait_until`
 *     (a plain "force" would re-read the date and park again), logging
 *     `wait_completed` at the step's own index.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAgentRouter } from '../../src/server/api/agent.js'
import { createAdminApiRouter } from '../../src/server/api/admin.js'
import { createTestMailer, MemoryFactsAdapter, step, type TestMailerHarness } from '../../src/testing/index.js'
import type { FlowStep } from '../../src/shared/types.js'

const TOKEN = 'wait-until-token-0123456789abcdef'
const DAY_MS = 24 * 60 * 60 * 1000

interface Server {
  H: TestMailerHarness
  facts: MemoryFactsAdapter | null
  baseUrl: string
  close: () => void
}

async function serve(withFacts: boolean): Promise<Server> {
  const facts = withFacts
    ? new MemoryFactsAdapter({ declare: { trial_ends_at: { type: 'date' }, plan: { type: 'string' } } })
    : null
  const H = await createTestMailer({
    config: { senderDomains: { 'example.com': { kind: 'both' } }, ...(facts ? { factsAdapter: facts } : {}) },
  })
  const app = express()
  app.use('/agent', createAgentRouter(H.mailer, { tokens: [{ token: TOKEN, actor: 'agent:test' }], testContacts: /@test\.example$/i }))
  const admin = express.Router()
  admin.use(express.json())
  admin.use((req, _res, next) => {
    ;(req as any).actor = 'human:admin@example.com'
    next()
  })
  admin.use('/api', createAdminApiRouter(H.mailer))
  app.use('/admin', admin)
  const server = app.listen(0)
  return {
    H,
    facts,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  }
}

function call(s: Server, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) }
    if (path.startsWith('/agent')) headers.authorization = `Bearer ${TOKEN}`
    const req = request(`${s.baseUrl}${path}`, { method, headers }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }) }
        catch { resolve({ status: res.statusCode ?? 0, body: raw }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

let S: Server
let NO_FACTS: Server

beforeAll(async () => {
  S = await serve(true)
  NO_FACTS = await serve(false)
  for (const srv of [S, NO_FACTS]) {
    await srv.H.seedTemplate({
      slug: 'tw-first',
      kind: 'marketing',
      fromEmail: 'hello@example.com',
      subject: 'First',
      html: '<p>First email body, long enough to be real copy for the linter.</p><a href="{{unsubscribeUrl}}">Unsubscribe</a><p>{{senderAddress}}</p>',
    })
    await srv.H.seedTemplate({
      slug: 'tw-second',
      kind: 'marketing',
      fromEmail: 'hello@example.com',
      subject: 'Second',
      html: '<p>Second email body, long enough to be real copy for the linter.</p><a href="{{unsubscribeUrl}}">Unsubscribe</a><p>{{senderAddress}}</p>',
    })
  }
}, 120_000)

afterAll(async () => {
  S?.close()
  NO_FACTS?.close()
  if (S) await S.H.stop()
  if (NO_FACTS) await NO_FACTS.H.stop()
})

// ---------------------------------------------------------------------------
// Publish validation
// ---------------------------------------------------------------------------

let flowN = 0
async function draftFlow(srv: Server, draftSteps: unknown[]): Promise<string> {
  const slug = `pub-${++flowN}`
  await srv.H.seedFlow({ slug, eventName: `Pub${flowN}`, enabled: false, steps: [step.send('tw-first')] })
  await srv.H.ctx.collections.flows.updateOne({ slug }, { $set: { draft: { steps: draftSteps as FlowStep[] } as never } })
  return slug
}

describe('admin flow detail: declared facts for the editor', () => {
  it('returns factsAdapter.declare, or null without an adapter', async () => {
    const slug = await draftFlow(S, [])
    const res = await call(S, 'GET', `/admin/api/flows/${slug}`)
    expect(res.status).toBe(200)
    expect(res.body.facts).toEqual({ trial_ends_at: { type: 'date' }, plan: { type: 'string' } })
    const slug0 = await draftFlow(NO_FACTS, [])
    expect((await call(NO_FACTS, 'GET', `/admin/api/flows/${slug0}`)).body.facts).toBeNull()
  })
})

describe('admin publish: wait_until', () => {
  const valid = { type: 'wait_until', fact: 'trial_ends_at', subjectFrom: 'accountId', offsetDays: -3 }

  it('publishes a valid wait_until', async () => {
    const slug = await draftFlow(S, [step.send('tw-first'), valid, step.send('tw-second')])
    const res = await call(S, 'POST', `/admin/api/flows/${slug}/publish`, { enable: false })
    expect(res.status).toBe(200)
    const flow = await S.H.ctx.collections.flows.findOne({ slug })
    expect(flow!.steps[1]).toMatchObject(valid)
  })

  it.each([
    { name: 'undeclared fact', s: { ...valid, fact: 'nope' }, path: 'steps.1.fact', msg: /not declared/ },
    { name: 'non-date fact', s: { ...valid, fact: 'plan' }, path: 'steps.1.fact', msg: /needs a date fact/ },
  ])('422 for $name, flow untouched', async ({ s, path, msg }) => {
    const slug = await draftFlow(S, [step.send('tw-first'), s])
    const before = await S.H.ctx.collections.flows.findOne({ slug })
    const res = await call(S, 'POST', `/admin/api/flows/${slug}/publish`, {})
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('validation_failed')
    expect(res.body.issues).toEqual([{ path, message: expect.stringMatching(msg) }])
    const after = await S.H.ctx.collections.flows.findOne({ slug })
    expect(after!.version).toBe(before!.version)
    expect(after!.draft?.steps).toEqual(before!.draft?.steps)
    expect(await S.H.ctx.collections.flowVersions.countDocuments({ flowId: after!._id })).toBe(
      await S.H.ctx.collections.flowVersions.countDocuments({ flowId: before!._id }),
    )
  })

  it('422 when no facts adapter is configured', async () => {
    const slug = await draftFlow(NO_FACTS, [valid])
    const res = await call(NO_FACTS, 'POST', `/admin/api/flows/${slug}/publish`, {})
    expect(res.status).toBe(422)
    expect(res.body.issues).toEqual([{ path: 'steps.0', message: expect.stringMatching(/factsAdapter/) }])
  })

  it('a flow with no wait_until publishes without a facts adapter, as before', async () => {
    const slug = await draftFlow(NO_FACTS, [step.send('tw-first'), step.wait(1, 'days')])
    const res = await call(NO_FACTS, 'POST', `/admin/api/flows/${slug}/publish`, { enable: false })
    expect(res.status).toBe(200)
  })

  it('checks wait_until inside branches', async () => {
    const slug = await draftFlow(S, [
      { type: 'branch', test: { hasTag: 'x' }, ifTrueSteps: [{ ...valid, fact: 'nope' }], ifFalseSteps: [] },
    ])
    const res = await call(S, 'POST', `/admin/api/flows/${slug}/publish`, {})
    expect(res.status).toBe(422)
    expect(res.body.issues[0].path).toBe('steps.0.ifTrueSteps.0.fact')
  })
})

// ---------------------------------------------------------------------------
// Simulate
// ---------------------------------------------------------------------------

describe('agent simulate: wait_until', () => {
  const AT = new Date('2026-03-02T09:00:00Z')
  const END = new Date(AT.getTime() + 10 * DAY_MS)
  const trial: FlowStep[] = [
    step.send('tw-first'),
    step.waitUntil('trial_ends_at', 'accountId', { offsetDays: -3 }),
    step.send('tw-second'),
    step.waitUntil('trial_ends_at', 'accountId'),
    step.fireEvent('Trial Expired'),
  ]

  beforeAll(async () => {
    await S.H.seedContact({ externalId: 'sim1', email: 'sim1@test.example', tags: [], fields: {} })
    await S.H.seedFlow({ slug: 'sim-trial', eventName: 'Sim Trial', enabled: false, steps: trial })
    await S.H.seedFlow({
      slug: 'sim-continue',
      eventName: 'Sim Continue',
      enabled: false,
      steps: [step.waitUntil('trial_ends_at', 'accountId', { ifMissing: 'continue' }), step.send('tw-first')],
    })
    S.facts!.set('acct-sim', { trial_ends_at: END })
  })

  it('projects from live facts', async () => {
    const res = await call(S, 'POST', '/agent/flows/sim-trial/simulate', {
      contactId: 'sim1',
      at: AT.toISOString(),
      eventProperties: { accountId: 'acct-sim' },
    })
    expect(res.status).toBe(200)
    expect(res.body.path.map((p: any) => p.outcome).slice(0, 5)).toEqual(['send', 'waited_until', 'send', 'waited_until', 'event_fired'])
    expect(res.body.terminal.kind).toBe('completed')
    expect(res.body.sends.map((s: any) => new Date(s.at).getTime())).toEqual([AT.getTime(), END.getTime() - 3 * DAY_MS])
    const waits = res.body.path.filter((p: any) => p.outcome === 'waited_until')
    expect(waits).toHaveLength(2)
    expect(waits[0].detail).toMatchObject({ fact: 'trial_ends_at', subjectId: 'acct-sim' })
    expect(new Date(waits[0].detail.target).getTime()).toBe(END.getTime() - 3 * DAY_MS)
    expect(new Date(waits[1].detail.until).getTime()).toBe(END.getTime())
    expect(res.body.durationMs).toBe(10 * DAY_MS)
  })

  it('a facts override replaces the live value', async () => {
    const overrideEnd = new Date(AT.getTime() + 30 * DAY_MS)
    const res = await call(S, 'POST', '/agent/flows/sim-trial/simulate', {
      contactId: 'sim1',
      at: AT.toISOString(),
      eventProperties: { accountId: 'acct-sim' },
      facts: { trial_ends_at: overrideEnd.toISOString() },
    })
    expect(res.status).toBe(200)
    expect(new Date(res.body.sends[1].at).getTime()).toBe(overrideEnd.getTime() - 3 * DAY_MS)
    expect(res.body.durationMs).toBe(30 * DAY_MS)
    // The override is a dry run: the adapter's value is unchanged.
    expect((await S.facts!.resolve('acct-sim')).trial_ends_at).toEqual(END)
  })

  it('a date already past does not move the clock', async () => {
    const res = await call(S, 'POST', '/agent/flows/sim-trial/simulate', {
      contactId: 'sim1',
      at: AT.toISOString(),
      eventProperties: { accountId: 'acct-sim' },
      facts: { trial_ends_at: new Date(AT.getTime() - DAY_MS).toISOString() },
    })
    expect(res.body.durationMs).toBe(0)
    expect(res.body.sends).toHaveLength(2)
  })

  it('missing date → exits with wait_until_missing', async () => {
    const res = await call(S, 'POST', '/agent/flows/sim-trial/simulate', {
      contactId: 'sim1',
      at: AT.toISOString(),
      eventProperties: { accountId: 'acct-unknown' },
    })
    expect(res.body.terminal).toMatchObject({ kind: 'exited', reason: 'wait_until_missing' })
    expect(res.body.sends).toHaveLength(1)
  })

  it("ifMissing 'continue' → skipped, run continues", async () => {
    const res = await call(S, 'POST', '/agent/flows/sim-continue/simulate', { contactId: 'sim1', at: AT.toISOString() })
    expect(res.body.path[0]).toMatchObject({ outcome: 'waited_until', detail: { fact: 'trial_ends_at', skipped: 'subject_missing' } })
    expect(res.body.sends).toHaveLength(1)
    expect(res.body.terminal.kind).toBe('completed')
  })

  it('400 for a non-object facts override', async () => {
    for (const facts of ['x', 3, ['a']]) {
      const res = await call(S, 'POST', '/agent/flows/sim-trial/simulate', { contactId: 'sim1', facts })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('validation_failed')
    }
  })

  it('no facts adapter → exits as the runner would fail it', async () => {
    await NO_FACTS.H.seedContact({ externalId: 'sim0', email: 'sim0@test.example', tags: [], fields: {} })
    await NO_FACTS.H.seedFlow({ slug: 'sim-nofacts', eventName: 'Sim None', enabled: false, steps: trial })
    const res = await call(NO_FACTS, 'POST', '/agent/flows/sim-nofacts/simulate', {
      contactId: 'sim0',
      eventProperties: { accountId: 'a' },
    })
    expect(res.body.terminal).toMatchObject({ kind: 'exited', reason: 'wait_until_misconfigured: no_facts_adapter' })
  })
})

// ---------------------------------------------------------------------------
// Force
// ---------------------------------------------------------------------------

describe('agent advance: a parked wait_until', () => {
  let n = 0
  async function parkedRun(accountFacts: Record<string, unknown> | null, steps?: FlowStep[]) {
    const i = ++n
    const externalId = `force${i}`
    const acct = `acct-force-${i}`
    await S.H.seedContact({ externalId, email: `force${i}@test.example`, tags: [], fields: {} })
    const flowSlug = `force-flow-${i}`
    await S.H.seedFlow({
      slug: flowSlug,
      eventName: `Force${i}`,
      once: false,
      steps: steps ?? [step.send('tw-first'), step.waitUntil('trial_ends_at', 'accountId', { offsetDays: -3 }), step.send('tw-second')],
    })
    S.H.mailer.registerEvent({ name: `Force${i}`, dedupePolicy: 'every-time' })
    if (accountFacts) S.facts!.set(acct, accountFacts as never)
    await S.H.mailer.fire(`Force${i}`, externalId, { accountId: acct })
    await S.H.drain()
    const run = (await S.H.ctx.collections.flowRuns.findOne({ flowSlug }))!
    return { run, externalId, flowSlug }
  }

  it('moves past the wait, logs wait_completed at its own index, processes the next step', async () => {
    const { run } = await parkedRun({ trial_ends_at: new Date(Date.now() + 10 * DAY_MS) })
    expect(run.status).toBe('active')
    expect(run.currentStepIndex).toBe(1)
    const scheduled = run.nextActionAt

    const res = await call(S, 'POST', `/agent/runs/${run._id}/advance`, { steps: 1 })
    expect(res.status).toBe(200)
    const forced = res.body.historyAdded.filter((h: any) => h.action === 'wait_completed')
    expect(forced).toHaveLength(1)
    expect(forced[0].stepIndex).toBe(1)
    expect(forced[0].details).toMatchObject({ forcedBy: 'agent:test', fact: 'trial_ends_at' })
    expect(new Date(forced[0].details.scheduledFor).getTime()).toBe(new Date(scheduled).getTime())
    expect(res.body.historyAdded.some((h: any) => h.action === 'wait_until_parked')).toBe(false)
    expect(res.body.sends).toHaveLength(1)
    const after = await S.H.ctx.collections.flowRuns.findOne({ _id: run._id })
    expect(after!.currentStepIndex).toBe(3) // past the wait and the send
  })

  it('force advances even when the date is missing', async () => {
    const { run } = await parkedRun({ trial_ends_at: new Date(Date.now() + 10 * DAY_MS) })
    S.facts!.set(String(run.triggerEvent!.properties.accountId), { trial_ends_at: null })
    const res = await call(S, 'POST', `/agent/runs/${run._id}/advance`, { steps: 1 })
    expect(res.status).toBe(200)
    expect(res.body.sends).toHaveLength(1)
    expect(res.body.historyAdded.some((h: any) => h.action === 'exited')).toBe(false)
  })

  it('one step at a time across two wait_until steps', async () => {
    const future = { trial_ends_at: new Date(Date.now() + 10 * DAY_MS) }
    const { run } = await parkedRun(future, [
      step.send('tw-first'),
      step.waitUntil('trial_ends_at', 'accountId', { offsetDays: -3 }),
      step.send('tw-second'),
      step.waitUntil('trial_ends_at', 'accountId'),
      step.send('tw-first'),
    ])
    const one = await call(S, 'POST', `/agent/runs/${run._id}/advance`, { steps: 1 })
    expect(one.body.sends).toHaveLength(1)
    expect(one.body.run.status).toBe('active')
    const mid = await S.H.ctx.collections.flowRuns.findOne({ _id: run._id })
    expect(mid!.currentStepIndex).toBe(3) // in front of the second wait_until

    const two = await call(S, 'POST', `/agent/runs/${run._id}/advance`, { steps: 1 })
    expect(two.body.sends).toHaveLength(1)
    expect(two.body.historyAdded.find((h: any) => h.action === 'wait_completed')?.stepIndex).toBe(3)
  })

  it('a plain wait is still forced as before', async () => {
    const { run } = await parkedRun(null, [step.send('tw-first'), step.wait(2, 'days'), step.send('tw-second')])
    const res = await call(S, 'POST', `/agent/runs/${run._id}/advance`, { steps: 1 })
    expect(res.body.historyAdded.find((h: any) => h.action === 'wait_completed')?.stepIndex).toBe(1)
    expect(res.body.sends).toHaveLength(1)
  })
})
