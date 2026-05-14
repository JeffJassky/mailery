/**
 * runSndsPull with a stubbed fetcher:
 *  - parses CSV rows into snapshots
 *  - upserts by (ip, activityStart)
 *  - applies the optional IP filter
 *  - throttles non-force runs inside the interval
 *  - returns not_configured when accessKey is absent
 *  - returns not_due / fetched/persisted counts correctly
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { runSndsPull, type Fetcher } from '../../src/server/runner/snds.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      snds: {
        accessKey: 'test-key',
        intervalHours: 24,
      },
    },
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function reset() {
  await H.mailer.collections.sndsSnapshots.deleteMany({})
}

function fixedFetcher(csv: string): Fetcher {
  return async () => new Response(csv, { status: 200 })
}

const SAMPLE_CSV = [
  '203.0.113.5,9/26/2024 12:00 AM,9/26/2024 11:59 PM,1500,1200,1180,GREEN,<0.1%,0,sender.example.com,bounce@example.com',
  '203.0.113.6,9/26/2024 12:00 AM,9/26/2024 11:59 PM,200,150,140,RED,>4%,5,bad.example.com,bounce@example.com',
].join('\n')

describe('runSndsPull', () => {
  it('persists parsed rows', async () => {
    await reset()
    const result = await runSndsPull(H.mailer.getRunnerContext(), { fetcher: fixedFetcher(SAMPLE_CSV), force: true })
    expect(result.ran).toBe(true)
    expect(result.rowsParsed).toBe(2)
    expect(result.rowsPersisted).toBe(2)

    const all = await H.mailer.collections.sndsSnapshots.find({}).toArray()
    expect(all).toHaveLength(2)
    const red = all.find((s) => s.ip === '203.0.113.6')
    expect(red?.filterResult).toBe('RED')
    expect(red?.trapMessageCount).toBe(5)
    expect(red?.complaintRate).toBeCloseTo(0.04)
  })

  it('upserts by (ip, activityStart) — second pull does not duplicate', async () => {
    await reset()
    await runSndsPull(H.mailer.getRunnerContext(), { fetcher: fixedFetcher(SAMPLE_CSV), force: true })
    await runSndsPull(H.mailer.getRunnerContext(), { fetcher: fixedFetcher(SAMPLE_CSV), force: true })
    const all = await H.mailer.collections.sndsSnapshots.find({}).toArray()
    expect(all).toHaveLength(2)
  })

  it('respects the IP filter when configured', async () => {
    const H2 = await createTestMailer({
      config: {
        snds: { accessKey: 'test-key', ips: ['203.0.113.5'], intervalHours: 24 },
      },
    })
    try {
      const result = await runSndsPull(H2.mailer.getRunnerContext(), { fetcher: fixedFetcher(SAMPLE_CSV), force: true })
      expect(result.rowsParsed).toBe(2)
      expect(result.rowsPersisted).toBe(1)
      const all = await H2.mailer.collections.sndsSnapshots.find({}).toArray()
      expect(all).toHaveLength(1)
      expect(all[0]!.ip).toBe('203.0.113.5')
    } finally {
      await H2.stop()
    }
  }, 60_000)

  it('throttles a non-force call inside the interval', async () => {
    await reset()
    await runSndsPull(H.mailer.getRunnerContext(), { fetcher: fixedFetcher(SAMPLE_CSV), force: true })
    const second = await runSndsPull(H.mailer.getRunnerContext(), { fetcher: fixedFetcher(SAMPLE_CSV) })
    expect(second.ran).toBe(false)
    expect(second.reason).toBe('not_due')
  })

  it('returns not_configured when accessKey is absent', async () => {
    const H2 = await createTestMailer({})
    try {
      const result = await runSndsPull(H2.mailer.getRunnerContext())
      expect(result.ran).toBe(false)
      expect(result.reason).toBe('not_configured')
    } finally {
      await H2.stop()
    }
  }, 60_000)
})
