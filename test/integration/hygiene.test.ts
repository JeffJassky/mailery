/**
 * computeListHygiene buckets contacts by last-engagement age and projects
 * the impact of sunsetting the inactive cohort.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { computeListHygiene } from '../../src/server/runner/hygiene.js'
import type { SendDoc, SubscriptionDoc } from '../../src/server/models/index.js'

const DAY = 86_400_000

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({})
}, 60_000)

afterAll(async () => { if (H) await H.stop() })

beforeEach(async () => {
  sendCounter = 0
  await H.mailer.collections.subscriptions.deleteMany({})
  await H.mailer.collections.sends.deleteMany({})
})

const NOW = Date.UTC(2026, 5, 1) // 2026-06-01
let sendCounter = 0

async function seedSubscription(externalId: string, email: string, status: SubscriptionDoc['status'] = 'subscribed') {
  await H.mailer.collections.subscriptions.insertOne({
    externalId,
    status,
    subscribedAt: new Date(NOW - 365 * DAY),
    unsubscribedAt: null,
    unsubscribeReason: null,
    doiTokenHash: null,
    doiRequestedAt: null,
    doiConfirmedAt: null,
    doiIp: null,
    doiUserAgent: null,
    source: 'test',
    emailAtSubscribe: email,
    createdAt: new Date(NOW - 365 * DAY),
    updatedAt: new Date(NOW - 365 * DAY),
  })
}

async function seedSend(opts: {
  externalId: string
  email?: string
  queuedDaysAgo: number
  openedDaysAgo?: number | null
  clickedDaysAgo?: number | null
  status?: SendDoc['status']
  bounceType?: 'hard' | 'soft' | null
  complainedDaysAgo?: number | null
}) {
  const queuedAt = new Date(NOW - opts.queuedDaysAgo * DAY)
  // Stable monotonic counter so dedupeKey is reproducible under --repeat.
  sendCounter += 1
  await H.mailer.collections.sends.insertOne({
    _id: new ObjectId(),
    dedupeKey: `${opts.externalId}-${sendCounter}`,
    externalId: opts.externalId,
    emailAtSend: opts.email ?? `${opts.externalId}@example.com`,
    templateId: new ObjectId(),
    templateSlug: 't',
    flowRunId: null,
    broadcastId: null,
    manualSendBy: 'test',
    kind: 'marketing',
    provider: 'null',
    providerMessageId: null,
    fromName: 'T',
    fromEmail: 't@example.com',
    subject: 'Hi',
    bodyHash: '',
    status: opts.status ?? 'delivered',
    errorMessage: null,
    bounceType: opts.bounceType ?? null,
    bounceReason: null,
    links: [],
    vars: {},
    openedAt: opts.openedDaysAgo != null ? new Date(NOW - opts.openedDaysAgo * DAY) : null,
    openCount: opts.openedDaysAgo != null ? 1 : 0,
    firstClickAt: opts.clickedDaysAgo != null ? new Date(NOW - opts.clickedDaysAgo * DAY) : null,
    clickCount: opts.clickedDaysAgo != null ? 1 : 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: opts.complainedDaysAgo != null ? new Date(NOW - opts.complainedDaysAgo * DAY) : null,
    queuedAt,
    updatedAt: queuedAt,
    sentAt: queuedAt,
    deliveredAt: queuedAt,
  } as SendDoc)
}

describe('computeListHygiene', () => {
  it('returns zero counts for an empty list', async () => {
    const report = await computeListHygiene(H.mailer.getRunnerContext(), { now: NOW })
    expect(report.totalSubscribers).toBe(0)
    expect(report.totalWithSends).toBe(0)
    expect(report.sunsetCandidate.count).toBe(0)
    expect(report.buckets.every((b) => b.count === 0)).toBe(true)
  })

  it('buckets contacts by last-engaged age', async () => {
    await seedSubscription('u1', 'u1@example.com')
    await seedSubscription('u2', 'u2@example.com')
    await seedSubscription('u3', 'u3@example.com')
    await seedSubscription('u4', 'u4@example.com')

    // u1 — engaged 5d ago (30d bucket)
    await seedSend({ externalId: 'u1', queuedDaysAgo: 10, openedDaysAgo: 5 })
    // u2 — engaged 70d ago (61-90 bucket)
    await seedSend({ externalId: 'u2', queuedDaysAgo: 80, openedDaysAgo: 70 })
    // u3 — engaged 200d ago (>180 / sunset)
    await seedSend({ externalId: 'u3', queuedDaysAgo: 250, openedDaysAgo: 200 })
    // u4 — sent 250d ago, never opened (sunset)
    await seedSend({ externalId: 'u4', queuedDaysAgo: 250 })

    const report = await computeListHygiene(H.mailer.getRunnerContext(), { now: NOW })
    expect(report.totalSubscribers).toBe(4)
    expect(report.totalWithSends).toBe(4)
    expect(report.buckets[0]!.count).toBe(1) // 30d
    expect(report.buckets[2]!.count).toBe(1) // 61-90
    expect(report.buckets[4]!.count).toBe(1) // >180
    expect(report.buckets[5]!.count).toBe(1) // never engaged
    expect(report.sunsetCandidate.count).toBe(2) // u3 + u4
  })

  it('does not include unsubscribed contacts', async () => {
    await seedSubscription('u1', 'u1@example.com', 'unsubscribed')
    await seedSend({ externalId: 'u1', queuedDaysAgo: 250, openedDaysAgo: 200 })
    const report = await computeListHygiene(H.mailer.getRunnerContext(), { now: NOW })
    expect(report.totalSubscribers).toBe(0)
    expect(report.sunsetCandidate.count).toBe(0)
  })

  it('does not flag never-engaged contacts as sunset when their first send is recent', async () => {
    await seedSubscription('u1', 'u1@example.com')
    await seedSend({ externalId: 'u1', queuedDaysAgo: 20 }) // sent 20d ago, never opened
    const report = await computeListHygiene(H.mailer.getRunnerContext(), { now: NOW })
    expect(report.buckets[5]!.count).toBe(1)
    expect(report.sunsetCandidate.count).toBe(0)
  })

  it('reports projected impact when the cohort has recent activity', async () => {
    // 2 inactive contacts with many recent bounces
    await seedSubscription('stale1', 'stale1@example.com')
    await seedSubscription('stale2', 'stale2@example.com')
    // 1 active contact with clean sends
    await seedSubscription('fresh1', 'fresh1@example.com')

    // Mark stale1+stale2 as inactive 200d
    await seedSend({ externalId: 'stale1', queuedDaysAgo: 300, openedDaysAgo: 250 })
    await seedSend({ externalId: 'stale2', queuedDaysAgo: 300, openedDaysAgo: 250 })

    // Recent (in 90d window) sends to stale: 8 hard bounces
    for (let i = 0; i < 4; i++) {
      await seedSend({ externalId: 'stale1', queuedDaysAgo: 30, status: 'bounced', bounceType: 'hard' })
      await seedSend({ externalId: 'stale2', queuedDaysAgo: 30, status: 'bounced', bounceType: 'hard' })
    }
    // Recent sends to fresh1: 10 clean deliveries + 1 complaint
    await seedSend({ externalId: 'fresh1', queuedDaysAgo: 5, openedDaysAgo: 4 })
    for (let i = 0; i < 9; i++) {
      await seedSend({ externalId: 'fresh1', queuedDaysAgo: 5 })
    }
    await seedSend({ externalId: 'fresh1', queuedDaysAgo: 5, complainedDaysAgo: 4 })

    const report = await computeListHygiene(H.mailer.getRunnerContext(), { now: NOW })
    expect(report.sunsetCandidate.count).toBe(2)
    const proj = report.sunsetCandidate.projectedImpact!
    expect(proj).not.toBeNull()
    expect(proj.cohortRecentBounced).toBe(8)
    expect(proj.recentBounced).toBe(8) // all bounces are from stale cohort
    expect(proj.projectedBounceRate).toBeLessThan(proj.currentOverallBounceRate)
    expect(proj.cohortRecentComplained).toBe(0)
    expect(proj.recentComplained).toBe(1)
  })

  it('cohort lifetime metrics reflect all-time stats for the sunset cohort', async () => {
    await seedSubscription('u1', 'u1@example.com')
    // Set last-engagement to >180d (places in sunset bucket)
    await seedSend({ externalId: 'u1', queuedDaysAgo: 400, openedDaysAgo: 200 })
    // Lifetime: 4 sends, 1 hard bounce
    await seedSend({ externalId: 'u1', queuedDaysAgo: 350 })
    await seedSend({ externalId: 'u1', queuedDaysAgo: 300, status: 'bounced', bounceType: 'hard' })
    await seedSend({ externalId: 'u1', queuedDaysAgo: 250 })

    const report = await computeListHygiene(H.mailer.getRunnerContext(), { now: NOW })
    expect(report.sunsetCandidate.count).toBe(1)
    const lifetime = report.sunsetCandidate.cohortLifetime!
    expect(lifetime.totalSends).toBe(4)
    expect(lifetime.hardBouncedRate).toBe(0.25)
  })
})
