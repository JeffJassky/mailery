/**
 * runPostmasterPull with a stubbed PostmasterClient:
 *  - snapshots persisted per (domain, date)
 *  - domainReputation=BAD trips (domain × marketing) health bucket
 *  - non-BAD doesn't trip
 *  - throttle: a second non-force run within intervalHours is a no-op
 *  - force bypasses the throttle
 *  - empty Postmaster response is tolerated
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import {
  runPostmasterPull,
  type PostmasterClient,
  type TrafficStat,
} from '../../src/server/runner/postmaster.js'
import { healthBucketId } from '../../src/server/models/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      senderDomains: {
        'mkt.example.com': { kind: 'marketing' },
        'txn.example.com': { kind: 'transactional' },
      },
      postmaster: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        refreshToken: 'test-refresh',
        intervalHours: 24,
        // Pin to the two registered domains so the throttle/coverage tests
        // don't have to handle the default fromDefaults email's domain.
        domains: ['mkt.example.com', 'txn.example.com'],
      },
    },
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function reset() {
  await H.mailer.collections.postmasterSnapshots.deleteMany({})
  await H.mailer.collections.health.deleteMany({})
}

function clientWithStats(byDomain: Record<string, TrafficStat | null>): PostmasterClient {
  return {
    async listDomains() {
      return Object.keys(byDomain).map((name) => ({ name: `domains/${name}` }))
    },
    async getLatestTrafficStats(domain: string) {
      return byDomain[domain] ?? null
    },
  }
}

describe('runPostmasterPull', () => {
  it('persists one snapshot per domain and respects domainReputation=BAD by tripping marketing bucket', async () => {
    await reset()
    const client = clientWithStats({
      'mkt.example.com': {
        name: 'domains/mkt.example.com/trafficStats/20240115',
        domainReputation: 'BAD',
        userReportedSpamRatio: 0.012,
        spfSuccessRatio: 1.0,
        dkimSuccessRatio: 1.0,
        dmarcSuccessRatio: 0.98,
        ipReputations: [{ reputation: 'BAD', ipCount: '5' }],
      },
      'txn.example.com': {
        name: 'domains/txn.example.com/trafficStats/20240115',
        domainReputation: 'HIGH',
        userReportedSpamRatio: 0,
        spfSuccessRatio: 1.0,
        dkimSuccessRatio: 1.0,
        dmarcSuccessRatio: 1.0,
      },
    })

    const result = await runPostmasterPull(H.mailer.getRunnerContext(), { client, force: true })
    expect(result.ran).toBe(true)
    expect(result.fetched).toBe(2)
    // mkt is registered as marketing; trip identifier is `<domain>|<kind>`.
    expect(result.trippedDomains).toEqual(['mkt.example.com|marketing'])

    const mkt = await H.mailer.collections.postmasterSnapshots.findOne({ domain: 'mkt.example.com' })
    expect(mkt?.date).toBe('2024-01-15')
    expect(mkt?.domainReputation).toBe('BAD')
    expect(mkt?.userReportedSpamRatio).toBeCloseTo(0.012)
    expect(mkt?.ipReputations?.[0]?.ipCount).toBe(5)

    const txn = await H.mailer.collections.postmasterSnapshots.findOne({ domain: 'txn.example.com' })
    expect(txn?.domainReputation).toBe('HIGH')

    // Marketing bucket for mkt.example.com should be tripped.
    const bucket = await H.mailer.collections.health.findOne({ _id: healthBucketId('mkt.example.com', 'marketing') })
    expect(bucket?.status).toBe('tripped')
    expect(bucket?.trippedReason).toContain('BAD')
  })

  it('does not trip when reputation is LOW or HIGH', async () => {
    await reset()
    const client = clientWithStats({
      'mkt.example.com': {
        name: 'domains/mkt.example.com/trafficStats/20240115',
        domainReputation: 'LOW',
      },
      'txn.example.com': {
        name: 'domains/txn.example.com/trafficStats/20240115',
        domainReputation: 'HIGH',
      },
    })
    const result = await runPostmasterPull(H.mailer.getRunnerContext(), { client, force: true })
    expect(result.trippedDomains).toEqual([])
    const mkt = await H.mailer.collections.health.findOne({ _id: healthBucketId('mkt.example.com', 'marketing') })
    // Bucket may not exist at all — that's fine, the puller only creates it on BAD.
    expect(mkt?.status ?? 'absent').not.toBe('tripped')
  })

  it('throttles a non-force call inside the interval', async () => {
    await reset()
    const client = clientWithStats({
      'mkt.example.com': { name: 'domains/mkt.example.com/trafficStats/20240115', domainReputation: 'HIGH' },
      'txn.example.com': { name: 'domains/txn.example.com/trafficStats/20240115', domainReputation: 'HIGH' },
    })
    await runPostmasterPull(H.mailer.getRunnerContext(), { client, force: true })
    const second = await runPostmasterPull(H.mailer.getRunnerContext(), { client })
    expect(second.ran).toBe(false)
    expect(second.reason).toBe('not_due')
  })

  it('returns not_configured when postmaster config is absent', async () => {
    const H2 = await createTestMailer({})
    try {
      const result = await runPostmasterPull(H2.mailer.getRunnerContext())
      expect(result.ran).toBe(false)
      expect(result.reason).toBe('not_configured')
    } finally {
      await H2.stop()
    }
  }, 60_000)

  it('tolerates an empty Postmaster response (small senders below reporting threshold)', async () => {
    await reset()
    const client = clientWithStats({
      'mkt.example.com': null,
      'txn.example.com': null,
    })
    const result = await runPostmasterPull(H.mailer.getRunnerContext(), { client, force: true })
    expect(result.ran).toBe(true)
    expect(result.fetched).toBe(0)
    expect(result.trippedDomains).toEqual([])
  })
})
