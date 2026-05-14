/**
 * DNSBL runner end-to-end with a stubbed DNS resolver.
 *  - configured sender domains land in the checks collection
 *  - clean / listed / error verdicts are persisted correctly
 *  - throttle: a second non-force run inside the window is a no-op
 *  - force bypasses the throttle
 *  - IP targets get reversed-octet queries
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { runDnsblChecks, type Resolver } from '../../src/server/runner/dnsbl.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      fromDefaults: { name: 'Mkt', email: 'hello@mkt.example.com' },
      transactionalFromDefaults: { name: 'Txn', email: 'noreply@txn.example.com' },
      senderDomains: {
        'mkt.example.com': { kind: 'marketing' },
        'txn.example.com': { kind: 'transactional' },
      },
      dnsbl: {
        domainLists: [
          { host: 'dbl.test', label: 'Test DBL' },
        ],
        ipLists: [
          { host: 'ip.test', label: 'Test IP BL' },
        ],
        dedicatedIps: ['203.0.113.5'],
        intervalHours: 24,
      },
    },
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function reset() {
  await H.mailer.collections.dnsblChecks.deleteMany({})
}

function makeResolver(answers: Record<string, string[] | 'NXDOMAIN' | 'ERROR' | 'TRANSIENT'>): Resolver {
  return {
    async resolve4(hostname: string): Promise<string[]> {
      const a = answers[hostname]
      if (a === undefined || a === 'NXDOMAIN') {
        const err: any = new Error(`ENOTFOUND ${hostname}`)
        err.code = 'ENOTFOUND'
        throw err
      }
      if (a === 'ERROR') {
        // A non-transient resolver error code — produces a persisted
        // 'error' row.
        const err: any = new Error('ENOTIMP')
        err.code = 'ENOTIMP'
        throw err
      }
      if (a === 'TRANSIENT') {
        const err: any = new Error('ETIMEOUT')
        err.code = 'ETIMEOUT'
        throw err
      }
      return a
    },
  }
}

describe('runDnsblChecks', () => {
  it('runs domain and IP queries, persists results', async () => {
    await reset()
    const resolver = makeResolver({
      // Marketing domain → listed on DBL
      'mkt.example.com.dbl.test': ['127.0.1.5'],
      // Transactional domain → clean (NXDOMAIN by omission)
      // Dedicated IP 203.0.113.5 → reversed = 5.113.0.203 → listed
      '5.113.0.203.ip.test': ['127.0.0.2'],
    })

    const result = await runDnsblChecks(H.mailer.getRunnerContext(), { resolver, force: true })
    expect(result.ran).toBe(true)
    expect(result.totalChecks).toBe(3) // 2 domains × 1 list + 1 ip × 1 list
    expect(result.listedCount).toBe(2)

    const all = await H.mailer.collections.dnsblChecks.find({}).toArray()
    expect(all).toHaveLength(3)

    const mkt = await H.mailer.collections.dnsblChecks.findOne({ target: 'mkt.example.com', list: 'dbl.test' })
    expect(mkt?.result).toBe('listed')
    expect(mkt?.returnCodes).toEqual(['127.0.1.5'])
    expect(mkt?.targetKind).toBe('domain')

    const txn = await H.mailer.collections.dnsblChecks.findOne({ target: 'txn.example.com', list: 'dbl.test' })
    expect(txn?.result).toBe('clean')

    const ip = await H.mailer.collections.dnsblChecks.findOne({ target: '203.0.113.5', list: 'ip.test' })
    expect(ip?.result).toBe('listed')
    expect(ip?.targetKind).toBe('ip')
  })

  it('throttles a non-force run inside the interval', async () => {
    await reset()
    const resolver = makeResolver({ 'mkt.example.com.dbl.test': 'NXDOMAIN', 'txn.example.com.dbl.test': 'NXDOMAIN', '5.113.0.203.ip.test': 'NXDOMAIN' })

    await runDnsblChecks(H.mailer.getRunnerContext(), { resolver, force: true })
    const second = await runDnsblChecks(H.mailer.getRunnerContext(), { resolver })
    expect(second.ran).toBe(false)
    expect(second.reason).toBe('not_due')
  })

  it('force bypasses the throttle', async () => {
    await reset()
    const resolver = makeResolver({ 'mkt.example.com.dbl.test': 'NXDOMAIN', 'txn.example.com.dbl.test': 'NXDOMAIN', '5.113.0.203.ip.test': 'NXDOMAIN' })

    await runDnsblChecks(H.mailer.getRunnerContext(), { resolver, force: true })
    const second = await runDnsblChecks(H.mailer.getRunnerContext(), { resolver, force: true })
    expect(second.ran).toBe(true)
  })

  it('records error result when resolver fails with a non-transient code', async () => {
    await reset()
    const resolver = makeResolver({
      'mkt.example.com.dbl.test': 'ERROR',
      'txn.example.com.dbl.test': 'NXDOMAIN',
      '5.113.0.203.ip.test': 'NXDOMAIN',
    })

    await runDnsblChecks(H.mailer.getRunnerContext(), { resolver, force: true })
    const mkt = await H.mailer.collections.dnsblChecks.findOne({ target: 'mkt.example.com', list: 'dbl.test' })
    expect(mkt?.result).toBe('error')
    expect(mkt?.errorMessage).toMatch(/ENOTIMP/)
  })

  it('does not overwrite a clean row on a transient DNS failure', async () => {
    await reset()
    // First run: clean verdict persisted.
    const cleanResolver = makeResolver({
      'mkt.example.com.dbl.test': 'NXDOMAIN',
      'txn.example.com.dbl.test': 'NXDOMAIN',
      '5.113.0.203.ip.test': 'NXDOMAIN',
    })
    await runDnsblChecks(H.mailer.getRunnerContext(), { resolver: cleanResolver, force: true })
    const cleanRow = await H.mailer.collections.dnsblChecks.findOne({ target: 'mkt.example.com', list: 'dbl.test' })
    expect(cleanRow?.result).toBe('clean')

    // Second run: transient ETIMEOUT — must not overwrite the clean row.
    const transientResolver = makeResolver({
      'mkt.example.com.dbl.test': 'TRANSIENT',
      'txn.example.com.dbl.test': 'NXDOMAIN',
      '5.113.0.203.ip.test': 'NXDOMAIN',
    })
    await runDnsblChecks(H.mailer.getRunnerContext(), { resolver: transientResolver, force: true })
    const stillClean = await H.mailer.collections.dnsblChecks.findOne({ target: 'mkt.example.com', list: 'dbl.test' })
    expect(stillClean?.result).toBe('clean')
  })
})
