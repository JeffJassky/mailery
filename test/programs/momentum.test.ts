/**
 * Momentum — plans/17-cadence-controls.md F4.
 *
 * `policy.progressGapDays`: when the subject made progress since the last
 * send — an action completed (`completedAt > run.lastSentAt`) or a human click
 * on a program email after it — the gap before the next send is
 * min(normal gap, progressGapDays). Sessions alone are not progress. A human
 * click on a program send also wakes the run (`nextTickAt = min(…, now)`).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ObjectId } from 'mongodb'

import { buildProgram, tickProgram } from '../../src/testing/index.js'
import { createPublicRouter } from '../../src/server/api/public.js'
import { lintProgram, type ProgramLintContext } from '../../src/server/programs/lint.js'
import { referencedTemplateSlugs } from '../../src/server/programs/validate.js'
import { signTrackingToken } from '../../src/server/tokens.js'
import { programDefinitionSchema } from '../../src/shared/schemas.js'
import type { ProgramDefinition } from '../../src/shared/types.js'
import { advance, DAY, HOUR, restoreClock } from '../matrix/clock.js'
import {
  CATEGORY,
  DECLARE,
  dispatch,
  enter,
  getRun,
  programHarness,
  programSends,
  seedProgramWithTemplates,
  startClock,
  subject,
  type ProgramHarness,
} from './helpers.js'

let P: ProgramHarness
const slug = 'momentum'
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'
const BOT = 'Mimecast Security Scanner'

const actions = [
  { id: 'connect-shopify', title: 'Connect Shopify', priority: 100, attempts: 3, satisfied: { fact: 'shopify_connected' } },
  { id: 'connect-ga4', title: 'Connect GA4', priority: 90, attempts: 2, satisfied: { fact: 'ga4_connected' } },
  { id: 'install-agent', title: 'Install the agent', priority: 80, attempts: 2, satisfied: { fact: 'agent_connected' } },
]

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(P.H, buildProgram({ slug, policy: { minGapDays: 5, progressGapDays: 1 }, actions }))
  await seedProgramWithTemplates(P.H, buildProgram({ slug: 'plain', policy: { minGapDays: 5 }, actions }))
  await seedProgramWithTemplates(
    P.H,
    buildProgram({
      slug: 'ladder',
      policy: { minGapDays: 5, progressGapDays: 1 },
      actions: [
        {
          id: 'connect-shopify',
          title: 'Connect Shopify',
          priority: 100,
          satisfied: { fact: 'shopify_connected' },
          attempts: [
            { deliveries: [{ channel: 'email', templateSlug: 'connect-shopify-1' }] },
            { deliveries: [{ channel: 'email', templateSlug: 'connect-shopify-2' }], minGapDays: 10 },
          ],
        },
      ],
    }),
  )
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})
afterEach(() => restoreClock())

/** Enter, send the first email, dispatch it. Returns the send time. */
async function firstSend(program: string, subjectId: string): Promise<Date> {
  await enter(P, program, subjectId)
  expect(await tickProgram(P.H.ctx, program, subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'connect-shopify', attempt: 1 })
  await dispatch(P)
  const run = (await getRun(P, program, subjectId))!
  expect(run.lastSentAt).not.toBeNull()
  return run.lastSentAt!
}

async function click(subjectId: string, userAgent: string, at = new Date()): Promise<void> {
  const last = (await programSends(P, subjectId)).at(-1)!
  await P.H.mailer.collections.sends.updateOne(
    { _id: last._id },
    { $set: { firstClickAt: at, clickCount: 1, clickedLinks: [{ url: 'https://x.test/a', linkId: 'l1', clickedAt: at, userAgent }] } },
  )
}

describe('schema and lint', () => {
  it('progressGapDays is a positive number up to 365', () => {
    const d = buildProgram({ slug: 's', policy: { minGapDays: 3, progressGapDays: 1 }, actions })
    expect(programDefinitionSchema.safeParse(d).success).toBe(true)
    expect(programDefinitionSchema.safeParse({ ...d, policy: { minGapDays: 3, progressGapDays: 0 } }).success).toBe(false)
    expect(programDefinitionSchema.safeParse({ ...d, policy: { minGapDays: 3, progressGapDays: 400 } }).success).toBe(false)
  })

  function lctx(d: ProgramDefinition): ProgramLintContext {
    const templates: ProgramLintContext['templates'] = new Map()
    for (const s of referencedTemplateSlugs(d)) templates.set(s, { kind: 'marketing', category: CATEGORY, published: true })
    return { categories: [{ id: CATEGORY, label: 'Tips' }], facts: { ...DECLARE } as any, templates }
  }
  it('lint warns when progressGapDays is not shorter than minGapDays', () => {
    const d = buildProgram({ slug: 'l', policy: { minGapDays: 5, progressGapDays: 5 }, actions })
    expect(lintProgram(d, lctx(d)).filter((i) => i.code === 'progress-gap-not-shorter')).toEqual([
      {
        severity: 'warning',
        code: 'progress-gap-not-shorter',
        path: 'policy.progressGapDays',
        message: 'progressGapDays (5) is not shorter than minGapDays (5), so it never applies',
      },
    ])
    const ok = buildProgram({ slug: 'l', policy: { minGapDays: 5, progressGapDays: 1 }, actions })
    expect(lintProgram(ok, lctx(ok)).filter((i) => i.code === 'progress-gap-not-shorter')).toEqual([])
  })
})

describe('gap after progress', () => {
  it('without progress the normal gap holds', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const sent = await firstSend(slug, subjectId)
    advance(DAY)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'min-gap', chosen: 'connect-shopify', attempt: 2 })
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(sent.getTime() + 5 * DAY))
  })

  it('an action completed since the last send shortens the gap to progressGapDays', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await firstSend(slug, subjectId)
    advance(DAY)
    P.facts.set(subjectId, { shopify_connected: true })
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'connect-ga4', attempt: 1 })
  })

  it('progress before the shorter gap has elapsed waits exactly until it has', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const sent = await firstSend(slug, subjectId)
    advance(12 * HOUR)
    P.facts.set(subjectId, { shopify_connected: true })
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'min-gap', chosen: 'connect-ga4', attempt: 1 })
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(sent.getTime() + DAY))
    advance(12 * HOUR)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'connect-ga4' })
  })

  it('a human click on a program email is progress; a bot click is not', async () => {
    startClock()
    const human = await subject(P)
    await firstSend(slug, human.subjectId)
    advance(2 * DAY)
    await click(human.subjectId, HUMAN)
    expect(await tickProgram(P.H.ctx, slug, human.subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'connect-shopify', attempt: 2 })

    const bot = await subject(P)
    const sent = await firstSend(slug, bot.subjectId)
    advance(2 * DAY)
    await click(bot.subjectId, BOT)
    expect(await tickProgram(P.H.ctx, slug, bot.subjectId)).toMatchObject({ reason: 'min-gap' })
    expect((await getRun(P, slug, bot.subjectId))!.nextTickAt).toEqual(new Date(sent.getTime() + 5 * DAY))
  })

  it('a session alone is not progress', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const sent = await firstSend(slug, subjectId)
    advance(2 * DAY)
    P.facts.set(subjectId, { last_session_at: new Date() })
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'min-gap' })
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(sent.getTime() + 5 * DAY))
  })

  it('the shorter gap also beats a per-attempt minGapDays', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await firstSend('ladder', subjectId)
    advance(2 * DAY)
    await click(subjectId, HUMAN)
    expect(await tickProgram(P.H.ctx, 'ladder', subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'connect-shopify', attempt: 2 })
  })

  it('without progressGapDays progress changes nothing about the gap', async () => {
    startClock()
    const { subjectId } = await subject(P)
    const sent = await firstSend('plain', subjectId)
    advance(DAY)
    P.facts.set(subjectId, { shopify_connected: true })
    expect(await tickProgram(P.H.ctx, 'plain', subjectId)).toMatchObject({ reason: 'min-gap', chosen: 'connect-ga4' })
    expect((await getRun(P, 'plain', subjectId))!.nextTickAt).toEqual(new Date(sent.getTime() + 5 * DAY))
  })

  it('progress applies once: the send after the shortened one is at the normal gap again', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await firstSend(slug, subjectId)
    advance(DAY)
    P.facts.set(subjectId, { shopify_connected: true })
    await tickProgram(P.H.ctx, slug, subjectId)
    await dispatch(P)
    const sent2 = (await getRun(P, slug, subjectId))!.lastSentAt!
    advance(DAY)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'min-gap', chosen: 'connect-ga4', attempt: 2 })
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(sent2.getTime() + 5 * DAY))
  })
})

describe('simulate', () => {
  it('uses the progress gap for the first decision only; projected sends have no progress', async () => {
    const t = startClock()
    const { subjectId } = await subject(P)
    const sent = await firstSend(slug, subjectId)
    advance(12 * HOUR)
    P.facts.set(subjectId, { shopify_connected: true })
    await tickProgram(P.H.ctx, slug, subjectId) // records completedAt for connect-shopify (> lastSentAt)
    const s = await P.H.mailer.simulateProgram(slug, { subjectId })
    expect(s.next).toMatchObject({ reason: 'min-gap', actionId: 'connect-ga4', attempt: 1 })
    expect(s.next.at).toEqual(new Date(sent.getTime() + DAY))
    expect(s.sequence.map((x) => [x.actionId, x.attempt, x.at.getTime() - t.getTime()])).toEqual([
      ['connect-ga4', 1, DAY],
      ['connect-ga4', 2, 6 * DAY],
      ['install-agent', 1, 11 * DAY],
      ['install-agent', 2, 16 * DAY],
    ])
  })
})

describe('a human click wakes the run', () => {
  const servers: Array<ReturnType<express.Express['listen']>> = []
  afterAll(() => {
    for (const s of servers) s.close()
  })

  async function mount(): Promise<string> {
    const app = express()
    app.use('/m', createPublicRouter(P.H.mailer, { logger: { error: () => {}, warn: () => {}, info: () => {} } as any }))
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>((r) => server.once('listening', r))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  function get(url: string, userAgent: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(url, { method: 'GET', headers: { 'user-agent': userAgent } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end()
    })
  }

  async function waitFor(check: () => Promise<boolean>): Promise<boolean> {
    for (let i = 0; i < 40; i++) {
      if (await check()) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return check()
  }

  it('GET /click on a program send pulls nextTickAt forward to now', async () => {
    startClock()
    const base = await mount()
    const { subjectId } = await subject(P)
    const sent = await firstSend(slug, subjectId)
    const run = (await getRun(P, slug, subjectId))!
    expect(run.nextTickAt).toEqual(new Date(sent.getTime() + 5 * DAY))

    advance(HOUR) // the click must be strictly after the send
    const send = (await programSends(P, subjectId)).at(-1)!
    await P.H.mailer.collections.sends.updateOne({ _id: send._id }, { $set: { links: [{ linkId: 'l1', url: 'https://x.test/a' }] } })
    const sig = signTrackingToken('click', { sendId: String(send._id), linkId: 'l1' }, P.H.mailer.config.unsubscribeSecret)
    expect(await get(`${base}/m/click/${String(send._id)}/l1/${sig}`, HUMAN)).toBe(302)

    const woken = await waitFor(async () => {
      const r = (await getRun(P, slug, subjectId))!
      return r.nextTickAt.getTime() <= Date.now()
    })
    expect(woken).toBe(true)
    // …and the woken tick, two days later, uses the progress gap.
    advance(2 * DAY)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'highest-rank', chosen: 'connect-shopify', attempt: 2 })
  })

  it('a bot click does not wake the run', async () => {
    startClock()
    const base = await mount()
    const { subjectId } = await subject(P)
    const sent = await firstSend(slug, subjectId)
    const send = (await programSends(P, subjectId)).at(-1)!
    await P.H.mailer.collections.sends.updateOne({ _id: send._id }, { $set: { links: [{ linkId: 'l1', url: 'https://x.test/a' }] } })
    const sig = signTrackingToken('click', { sendId: String(send._id), linkId: 'l1' }, P.H.mailer.config.unsubscribeSecret)
    expect(await get(`${base}/m/click/${String(send._id)}/l1/${sig}`, BOT)).toBe(302)
    await waitFor(async () => ((await P.H.mailer.collections.sends.findOne({ _id: send._id as ObjectId }))?.clickCount ?? 0) > 0)
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(sent.getTime() + 5 * DAY))
  })
})
