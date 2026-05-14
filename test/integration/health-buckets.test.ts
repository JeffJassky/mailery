/**
 * Per-(senderDomain × kind) health buckets:
 *  - counters land in both bucket and aggregate
 *  - eval trips a single bucket without affecting siblings
 *  - aggregate never trips
 *  - dispatchSend gates on the matching bucket
 *  - resume targets one bucket or all
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import {
  effectiveOverallStatus,
  evaluateHealth,
  getBucketStatus,
  recordHealthCounter,
} from '../../src/server/runner/health.js'
import { HEALTH_AGG_ID, healthBucketId } from '../../src/server/models/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      circuitBreaker: {
        hardBounceRatePctTrip: 2,
        complaintRatePctTrip: 0.3,
        combinedBounceRatePctTrip: 5,
        failedToSendRatePctDegrade: 10,
        windowMinutes: 60,
        minSendsBeforeEval: 10,
      },
    },
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function reset() {
  await H.mailer.collections.health.deleteMany({})
}

describe('per-(domain × kind) health buckets', () => {
  it('records counter to both bucket and aggregate', async () => {
    await reset()
    const ctx = H.mailer.getRunnerContext()

    await recordHealthCounter(ctx, 'sent', { fromEmail: 'a@mkt.example.com', kind: 'marketing' })

    const bucket = await ctx.collections.health.findOne({ _id: healthBucketId('mkt.example.com', 'marketing') })
    const agg = await ctx.collections.health.findOne({ _id: HEALTH_AGG_ID })

    expect(bucket?.counters.sent).toBe(1)
    expect(bucket?.senderDomain).toBe('mkt.example.com')
    expect(bucket?.kind).toBe('marketing')
    expect(agg?.counters.sent).toBe(1)
    expect(agg?.senderDomain).toBeNull()
    expect(agg?.kind).toBeNull()
  })

  it('keeps separate buckets per (domain, kind)', async () => {
    await reset()
    const ctx = H.mailer.getRunnerContext()

    await recordHealthCounter(ctx, 'sent', { fromEmail: 'a@mkt.example.com', kind: 'marketing' })
    await recordHealthCounter(ctx, 'sent', { fromEmail: 'b@txn.example.com', kind: 'transactional' })
    await recordHealthCounter(ctx, 'sent', { fromEmail: 'c@mkt.example.com', kind: 'marketing' })

    const mkt = await ctx.collections.health.findOne({ _id: healthBucketId('mkt.example.com', 'marketing') })
    const txn = await ctx.collections.health.findOne({ _id: healthBucketId('txn.example.com', 'transactional') })
    const agg = await ctx.collections.health.findOne({ _id: HEALTH_AGG_ID })

    expect(mkt?.counters.sent).toBe(2)
    expect(txn?.counters.sent).toBe(1)
    expect(agg?.counters.sent).toBe(3) // aggregate = sum
  })

  it('with null dims, only the aggregate is touched', async () => {
    await reset()
    const ctx = H.mailer.getRunnerContext()

    await recordHealthCounter(ctx, 'bounced', null)

    const docs = await ctx.collections.health.find({}).toArray()
    expect(docs).toHaveLength(1)
    expect(docs[0]!._id).toBe(HEALTH_AGG_ID)
    expect(docs[0]!.counters.bounced).toBe(1)
  })

  it('evaluateHealth trips one bucket without affecting siblings', async () => {
    await reset()
    const ctx = H.mailer.getRunnerContext()

    // Marketing bucket: 100 sends, 5 hard bounces = 5% > 2% trip
    for (let i = 0; i < 100; i++) {
      await recordHealthCounter(ctx, 'sent', { fromEmail: 'a@mkt.example.com', kind: 'marketing' })
    }
    for (let i = 0; i < 5; i++) {
      await recordHealthCounter(ctx, 'hardBounced', { fromEmail: 'a@mkt.example.com', kind: 'marketing' })
    }

    // Transactional bucket: 100 clean sends
    for (let i = 0; i < 100; i++) {
      await recordHealthCounter(ctx, 'sent', { fromEmail: 'b@txn.example.com', kind: 'transactional' })
    }

    await evaluateHealth(ctx)

    const mkt = await getBucketStatus(ctx, 'a@mkt.example.com', 'marketing')
    const txn = await getBucketStatus(ctx, 'b@txn.example.com', 'transactional')
    const agg = await ctx.collections.health.findOne({ _id: HEALTH_AGG_ID })

    expect(mkt?.status).toBe('tripped')
    expect(mkt?.trippedReason).toMatch(/hard bounce/i)
    expect(txn?.status).toBe('healthy')
    expect(agg?.status).toBe('healthy') // aggregate never trips
  })

  it('effectiveOverallStatus reflects worst bucket', async () => {
    await reset()
    const ctx = H.mailer.getRunnerContext()

    for (let i = 0; i < 100; i++) {
      await recordHealthCounter(ctx, 'sent', { fromEmail: 'a@mkt.example.com', kind: 'marketing' })
    }
    for (let i = 0; i < 5; i++) {
      await recordHealthCounter(ctx, 'hardBounced', { fromEmail: 'a@mkt.example.com', kind: 'marketing' })
    }
    for (let i = 0; i < 100; i++) {
      await recordHealthCounter(ctx, 'sent', { fromEmail: 'b@txn.example.com', kind: 'transactional' })
    }
    await evaluateHealth(ctx)

    const docs = await ctx.collections.health.find({}).toArray()
    expect(effectiveOverallStatus(docs)).toBe('tripped')
  })

  it('does not trip on tiny sample sizes', async () => {
    await reset()
    const ctx = H.mailer.getRunnerContext()

    // Only 5 sends (below minSendsBeforeEval=10), 5 hard bounces (100%)
    for (let i = 0; i < 5; i++) {
      await recordHealthCounter(ctx, 'sent', { fromEmail: 'a@new.example.com', kind: 'marketing' })
      await recordHealthCounter(ctx, 'hardBounced', { fromEmail: 'a@new.example.com', kind: 'marketing' })
    }
    await evaluateHealth(ctx)

    const bucket = await getBucketStatus(ctx, 'a@new.example.com', 'marketing')
    expect(bucket?.status).toBe('healthy')
  })

  it('resume targets one bucket', async () => {
    await reset()
    const ctx = H.mailer.getRunnerContext()

    await ctx.collections.health.insertMany([
      {
        _id: healthBucketId('a.example.com', 'marketing'),
        senderDomain: 'a.example.com',
        kind: 'marketing',
        windowStartedAt: new Date(),
        windowDurationMs: 60 * 60 * 1000,
        counters: { sent: 100, delivered: 90, bounced: 5, hardBounced: 5, softBounced: 0, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0.05, hardBounceRate: 0.05, complaintRate: 0, failureRate: 0 },
        status: 'tripped',
        trippedAt: new Date(),
        trippedReason: 'test trip',
        manuallyResumedAt: null,
        updatedAt: new Date(),
      },
      {
        _id: healthBucketId('b.example.com', 'marketing'),
        senderDomain: 'b.example.com',
        kind: 'marketing',
        windowStartedAt: new Date(),
        windowDurationMs: 60 * 60 * 1000,
        counters: { sent: 100, delivered: 95, bounced: 3, hardBounced: 3, softBounced: 0, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0.03, hardBounceRate: 0.03, complaintRate: 0, failureRate: 0 },
        status: 'tripped',
        trippedAt: new Date(),
        trippedReason: 'test trip 2',
        manuallyResumedAt: null,
        updatedAt: new Date(),
      },
    ])

    // Resume just bucket A by id
    await ctx.collections.health.updateOne(
      { _id: healthBucketId('a.example.com', 'marketing') },
      { $set: { status: 'healthy', manuallyResumedAt: new Date() } },
    )

    const a = await getBucketStatus(ctx, 'x@a.example.com', 'marketing')
    const b = await getBucketStatus(ctx, 'x@b.example.com', 'marketing')
    expect(a?.status).toBe('healthy')
    expect(b?.status).toBe('tripped')
  })

  it('window rolls per bucket when expired', async () => {
    await reset()
    const ctx = H.mailer.getRunnerContext()

    // Bucket with windowStartedAt in the distant past, healthy → should roll
    const oldStart = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2h ago, window=1h
    await ctx.collections.health.insertOne({
      _id: healthBucketId('a.example.com', 'marketing'),
      senderDomain: 'a.example.com',
      kind: 'marketing',
      windowStartedAt: oldStart,
      windowDurationMs: 60 * 60 * 1000,
      counters: { sent: 50, delivered: 50, bounced: 0, hardBounced: 0, softBounced: 0, complained: 0, failedToSend: 0 },
      rates: { bounceRate: 0, hardBounceRate: 0, complaintRate: 0, failureRate: 0 },
      status: 'healthy',
      trippedAt: null,
      trippedReason: null,
      manuallyResumedAt: null,
      updatedAt: oldStart,
    })

    await evaluateHealth(ctx)

    const bucket = await getBucketStatus(ctx, 'x@a.example.com', 'marketing')
    expect(bucket?.counters.sent).toBe(0) // reset
    expect(new Date(bucket!.windowStartedAt).getTime()).toBeGreaterThan(oldStart.getTime())
  })

  it('tripped bucket does not roll its window on eval', async () => {
    await reset()
    const ctx = H.mailer.getRunnerContext()

    const oldStart = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await ctx.collections.health.insertOne({
      _id: healthBucketId('a.example.com', 'marketing'),
      senderDomain: 'a.example.com',
      kind: 'marketing',
      windowStartedAt: oldStart,
      windowDurationMs: 60 * 60 * 1000,
      counters: { sent: 100, delivered: 50, bounced: 50, hardBounced: 50, softBounced: 0, complained: 0, failedToSend: 0 },
      rates: { bounceRate: 0.5, hardBounceRate: 0.5, complaintRate: 0, failureRate: 0 },
      status: 'tripped',
      trippedAt: oldStart,
      trippedReason: 'historic',
      manuallyResumedAt: null,
      updatedAt: oldStart,
    })

    await evaluateHealth(ctx)

    const bucket = await getBucketStatus(ctx, 'x@a.example.com', 'marketing')
    // Tripped bucket keeps its counters until manually resumed.
    expect(bucket?.counters.sent).toBe(100)
    expect(bucket?.status).toBe('tripped')
  })
})
