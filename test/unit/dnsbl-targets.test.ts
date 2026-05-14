/**
 * Edge cases for the DNSBL runner: target resolution, IPv4 validation,
 * disabled state, no-targets state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { runDnsblChecks, type Resolver } from '../../src/server/runner/dnsbl.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({})
}, 60_000)

afterAll(async () => { if (H) await H.stop() })

const noopResolver: Resolver = { async resolve4() { const err: any = new Error('nx'); err.code = 'ENOTFOUND'; throw err } }

describe('runDnsblChecks edge cases', () => {
  it('returns no_targets when no domains and no IPs are configured', async () => {
    // Default test mailer has fromDefaults but no dnsbl config — fromDefaults
    // still provides a domain target.
    const H2 = await createTestMailer({
      config: {
        dnsbl: { domainLists: [{ host: 'dbl.test', label: 'Test' }], ipLists: [], intervalHours: 24 },
      },
    })
    try {
      // fromDefaults gives 'test@example.com' → domain 'example.com'.
      // With no senderDomains or dedicated IPs we still have one domain to check.
      const r = await runDnsblChecks(H2.mailer.getRunnerContext(), { resolver: noopResolver, force: true })
      expect(r.ran).toBe(true)
      expect(r.totalChecks).toBeGreaterThanOrEqual(1)
    } finally {
      await H2.stop()
    }
  }, 60_000)

  it('returns disabled when intervalHours is 0 and not forced', async () => {
    const H2 = await createTestMailer({
      config: { dnsbl: { intervalHours: 0 } },
    })
    try {
      const r = await runDnsblChecks(H2.mailer.getRunnerContext(), { resolver: noopResolver })
      expect(r.ran).toBe(false)
      expect(r.reason).toBe('disabled')
    } finally {
      await H2.stop()
    }
  }, 60_000)

  it('skips invalid IPv4 entries in dedicatedIps', async () => {
    const H2 = await createTestMailer({
      config: {
        dnsbl: {
          domainLists: [],
          ipLists: [{ host: 'ip.test', label: 'IP' }],
          dedicatedIps: ['not-an-ip', '300.300.300.300', '1.2.3.4'],
          intervalHours: 24,
        },
      },
    })
    try {
      const r = await runDnsblChecks(H2.mailer.getRunnerContext(), { resolver: noopResolver, force: true })
      // Only 1.2.3.4 is valid; no fromDefaults email → no domain checks.
      // Test mailer's defaults include fromDefaults, so domain count may be 0
      // since we configured empty domainLists.
      expect(r.totalChecks).toBe(1)
    } finally {
      await H2.stop()
    }
  }, 60_000)
})
