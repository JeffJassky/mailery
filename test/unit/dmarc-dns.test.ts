/**
 * DMARC DNS verification (plans/18-dmarc-monitoring.md §7). Contract tests:
 * red until PR 1A lands. Every lookup goes through a fake resolver.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  _clearPtrCache,
  checkDmarcDns,
  lookupPtr,
  organizationalDomain,
  parseDmarcRecord,
} from '../../src/server/runner/dmarc-dns.js'
import type { DmarcDnsCheckResult, DmarcDnsResolver } from '../../src/shared/dmarc-types.js'

interface FakeZone {
  txt?: Record<string, string[][]>
  mx?: Record<string, Array<{ exchange: string; priority: number }>>
  ptr?: Record<string, string[]>
  /** host → error code thrown for any lookup of that host. */
  fail?: Record<string, string>
}

function dnsError(code: string, host: string): Error {
  return Object.assign(new Error(`${code} ${host}`), { code })
}

function fake(zone: FakeZone): DmarcDnsResolver & { calls: string[] } {
  const calls: string[] = []
  const lookup = <T>(kind: string, table: Record<string, T> | undefined, host: string): Promise<T> => {
    calls.push(`${kind}:${host}`)
    const code = zone.fail?.[host]
    if (code) return Promise.reject(dnsError(code, host))
    const hit = table?.[host]
    if (hit === undefined) return Promise.reject(dnsError('ENOTFOUND', host))
    return Promise.resolve(hit)
  }
  return {
    calls,
    resolveTxt: (h) => lookup('txt', zone.txt, h),
    resolveMx: (h) => lookup('mx', zone.mx, h),
    reverse: (ip) => lookup('ptr', zone.ptr, ip),
  }
}

const GOOGLE_MX = [{ exchange: 'smtp.google.com', priority: 1 }]
const SENDGRID_MX = [{ exchange: 'mx.sendgrid.net.', priority: 10 }]

function codes(r: DmarcDnsCheckResult): string[] {
  return r.issues.map((i) => i.code).sort()
}

function issue(r: DmarcDnsCheckResult, code: string) {
  return r.issues.find((i) => i.code === code)
}

describe('organizationalDomain', () => {
  it('uses the public suffix list, not the last two labels', () => {
    expect(organizationalDomain('news.example.com')).toBe('example.com')
    expect(organizationalDomain('example.com')).toBe('example.com')
    expect(organizationalDomain('mail.example.co.uk')).toBe('example.co.uk')
    expect(organizationalDomain('A.B.Example.COM')).toBe('example.com')
  })
})

describe('parseDmarcRecord', () => {
  it('parses every tag the monitor uses', () => {
    const r = parseDmarcRecord(
      'v=DMARC1; p=quarantine; sp=reject; pct=25; rua=mailto:A@X.com!10m,mailto:b@y.org; ruf=mailto:f@x.com; adkim=s; aspf=r',
    )
    expect(r).toEqual({
      valid: true,
      policy: 'quarantine',
      subdomainPolicy: 'reject',
      pct: 25,
      rua: ['a@x.com', 'b@y.org'],
      ruf: ['f@x.com'],
      adkim: 's',
      aspf: 'r',
    })
  })

  it('tolerates spacing, tag case and a trailing semicolon', () => {
    const r = parseDmarcRecord('v=DMARC1;P=None ;  RUA = mailto:d@example.com ;')
    expect(r.valid).toBe(true)
    expect(r.policy).toBe('none')
    expect(r.rua).toEqual(['d@example.com'])
    expect(r.pct).toBeNull()
    expect(r.subdomainPolicy).toBeNull()
    expect(r.adkim).toBeNull()
  })

  it('is invalid without a recognised p=', () => {
    expect(parseDmarcRecord('v=DMARC1; p=bogus').valid).toBe(false)
    expect(parseDmarcRecord('v=DMARC1; p=bogus').policy).toBeNull()
    expect(parseDmarcRecord('v=DMARC1; rua=mailto:a@b.com').valid).toBe(false)
  })

  it('drops an out-of-range pct', () => {
    expect(parseDmarcRecord('v=DMARC1; p=none; pct=150').pct).toBeNull()
    expect(parseDmarcRecord('v=DMARC1; p=none; pct=abc').pct).toBeNull()
    expect(parseDmarcRecord('v=DMARC1; p=none; pct=0').pct).toBe(0)
  })
})

describe('checkDmarcDns', () => {
  const clean: FakeZone = {
    txt: {
      '_dmarc.example.com': [['v=DMARC1; p=none; rua=mailto:dmarc@example.com']],
      'example.com': [['v=spf1 include:_spf.google.com ~all'], ['google-site-verification=abc']],
    },
    mx: { 'example.com': GOOGLE_MX },
  }

  it('a clean monitor-mode domain has only the p=none note', async () => {
    const r = await checkDmarcDns('example.com', { resolver: fake(clean) })
    expect(r.ok).toBe(true)
    expect(codes(r)).toEqual(['policy_none'])
    expect(issue(r, 'policy_none')!.severity).toBe('info')
    expect(r.domain).toBe('example.com')
    expect(r.inheritedFrom).toBeNull()
    expect(r.dmarc).toMatchObject({ host: '_dmarc.example.com', found: true, policy: 'none', rua: ['dmarc@example.com'] })
    expect(r.spf).toEqual({ found: true, raw: ['v=spf1 include:_spf.google.com ~all'], all: '~all' })
    expect(r.externalAuth).toEqual([])
    expect(r.ruaMx).toEqual([{ ruaDomain: 'example.com', mx: ['smtp.google.com'], sendgridInbound: false }])
  })

  it('uses the `now` it is given', async () => {
    const now = new Date('2026-10-01T00:00:00Z')
    const r = await checkDmarcDns('example.com', { resolver: fake(clean), now })
    expect(r.checkedAt).toEqual(now)
  })

  it('joins TXT chunks before matching', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({
        ...clean,
        txt: { ...clean.txt, '_dmarc.example.com': [['v=DMARC1; p=reject; ', 'rua=mailto:dmarc@example.com']] },
      }),
    })
    expect(r.dmarc.policy).toBe('reject')
    expect(r.dmarc.rua).toEqual(['dmarc@example.com'])
  })

  it('missing record → error with a ready-to-publish fix using the report address', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({ txt: { 'example.com': clean.txt!['example.com']! } }),
      reportAddress: 'reports@dmarc-in.example.com',
    })
    expect(r.ok).toBe(false)
    expect(r.dmarc.found).toBe(false)
    const i = issue(r, 'dmarc_missing')!
    expect(i.severity).toBe('error')
    expect(i.fix).toEqual({
      host: '_dmarc.example.com',
      type: 'TXT',
      value: 'v=DMARC1; p=none; rua=mailto:reports@dmarc-in.example.com',
    })
    expect(issue(r, 'rua_missing')).toBeUndefined()
  })

  it('missing record without a report address uses a placeholder mailbox', async () => {
    const r = await checkDmarcDns('example.com', { resolver: fake({}) })
    expect(issue(r, 'dmarc_missing')!.fix!.value).toBe('v=DMARC1; p=none; rua=mailto:you@example.com')
  })

  it('ignores non-DMARC TXT records at _dmarc', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({ txt: { '_dmarc.example.com': [['some-verification=1']] } }),
    })
    expect(issue(r, 'dmarc_missing')).toBeDefined()
  })

  it('two DMARC records is an error (receivers then ignore DMARC)', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({
        ...clean,
        txt: {
          ...clean.txt,
          '_dmarc.example.com': [['v=DMARC1; p=none; rua=mailto:a@example.com'], ['v=DMARC1; p=reject']],
        },
      }),
    })
    expect(r.ok).toBe(false)
    expect(issue(r, 'dmarc_multiple')!.severity).toBe('error')
    expect(r.dmarc.found).toBe(true)
    expect(r.dmarc.raw).toHaveLength(2)
    expect(r.dmarc.policy).toBeNull()
  })

  it('invalid record → dmarc_invalid', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({ ...clean, txt: { ...clean.txt, '_dmarc.example.com': [['v=DMARC1; p=maybe']] } }),
    })
    expect(issue(r, 'dmarc_invalid')!.severity).toBe('error')
    expect(r.ok).toBe(false)
  })

  it('no rua → no reports are being sent', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({ ...clean, txt: { ...clean.txt, '_dmarc.example.com': [['v=DMARC1; p=none']] } }),
    })
    expect(issue(r, 'rua_missing')!.severity).toBe('error')
  })

  it('report address absent from rua → warning (case-insensitive compare)', async () => {
    const r1 = await checkDmarcDns('example.com', { resolver: fake(clean), reportAddress: 'reports@other.example.com' })
    expect(issue(r1, 'rua_missing_report_address')!.severity).toBe('warning')
    const r2 = await checkDmarcDns('example.com', { resolver: fake(clean), reportAddress: 'DMARC@Example.com' })
    expect(issue(r2, 'rua_missing_report_address')).toBeUndefined()
  })

  it('external rua without an authorization record → error with the exact fix', async () => {
    const zone: FakeZone = {
      txt: {
        '_dmarc.maxed.ai': [['v=DMARC1; p=none; rua=mailto:jeff@jeffjassky.com']],
        'maxed.ai': [['v=spf1 include:sendgrid.net ~all']],
      },
      mx: { 'jeffjassky.com': GOOGLE_MX },
    }
    const r = await checkDmarcDns('maxed.ai', { resolver: fake(zone) })
    expect(r.ok).toBe(false)
    expect(r.externalAuth).toEqual([
      {
        ruaAddress: 'jeff@jeffjassky.com',
        ruaDomain: 'jeffjassky.com',
        host: 'maxed.ai._report._dmarc.jeffjassky.com',
        authorized: false,
      },
    ])
    expect(issue(r, 'external_auth_missing')).toMatchObject({
      severity: 'error',
      fix: { host: 'maxed.ai._report._dmarc.jeffjassky.com', type: 'TXT', value: 'v=DMARC1' },
    })
  })

  it('external rua with an authorization record is authorized', async () => {
    const zone: FakeZone = {
      txt: {
        '_dmarc.maxed.ai': [['v=DMARC1; p=none; rua=mailto:jeff@jeffjassky.com']],
        'maxed.ai': [['v=spf1 -all']],
        'maxed.ai._report._dmarc.jeffjassky.com': [['v=DMARC1']],
      },
      mx: { 'jeffjassky.com': GOOGLE_MX },
    }
    const r = await checkDmarcDns('maxed.ai', { resolver: fake(zone) })
    expect(r.externalAuth[0]!.authorized).toBe(true)
    expect(issue(r, 'external_auth_missing')).toBeUndefined()
    expect(r.ok).toBe(true)
  })

  it('a rua mailbox on a subdomain of the same organization needs no authorization', async () => {
    const zone: FakeZone = {
      txt: {
        '_dmarc.example.com': [['v=DMARC1; p=none; rua=mailto:reports@dmarc-in.example.com']],
        'example.com': [['v=spf1 -all']],
      },
      mx: { 'dmarc-in.example.com': SENDGRID_MX },
    }
    const resolver = fake(zone)
    const r = await checkDmarcDns('example.com', { resolver })
    expect(r.externalAuth).toEqual([])
    expect(resolver.calls.some((c) => c.includes('_report._dmarc'))).toBe(false)
    expect(r.ruaMx).toEqual([{ ruaDomain: 'dmarc-in.example.com', mx: ['mx.sendgrid.net'], sendgridInbound: true }])
  })

  it('a rua domain with no MX cannot receive reports', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({ txt: clean.txt }),
    })
    expect(issue(r, 'rua_domain_no_mx')!.severity).toBe('error')
    expect(r.ruaMx).toEqual([{ ruaDomain: 'example.com', mx: [], sendgridInbound: false }])
  })

  it('checks MX once per distinct rua domain', async () => {
    const resolver = fake({
      ...clean,
      txt: { ...clean.txt, '_dmarc.example.com': [['v=DMARC1; p=none; rua=mailto:a@example.com,mailto:b@example.com']] },
    })
    const r = await checkDmarcDns('example.com', { resolver })
    expect(resolver.calls.filter((c) => c === 'mx:example.com')).toHaveLength(1)
    expect(r.ruaMx).toHaveLength(1)
  })

  it('subdomain without its own record inherits the organizational policy', async () => {
    const r = await checkDmarcDns('news.example.com', {
      resolver: fake({ ...clean, txt: { ...clean.txt, 'news.example.com': [['v=spf1 include:sendgrid.net ~all']] } }),
    })
    expect(r.inheritedFrom).toBe('example.com')
    expect(r.dmarc.host).toBe('_dmarc.example.com')
    expect(r.dmarc.found).toBe(true)
    expect(r.dmarc.policy).toBe('none')
    expect(issue(r, 'inherits_org_policy')!.severity).toBe('info')
    expect(issue(r, 'dmarc_missing')).toBeUndefined()
    expect(r.spf.raw).toEqual(['v=spf1 include:sendgrid.net ~all'])
  })

  it('inherited record with the org domain also monitored → one info issue, nothing else', async () => {
    const r = await checkDmarcDns('news.example.com', {
      resolver: fake({ ...clean, txt: { '_dmarc.example.com': [['v=DMARC1; p=none']] } }),
      orgDomainInSet: true,
    })
    expect(codes(r)).toEqual(['inherits_org_policy'])
    expect(r.ok).toBe(true)
  })

  it('subdomain with neither record is missing', async () => {
    const r = await checkDmarcDns('news.example.com', { resolver: fake({}) })
    expect(issue(r, 'dmarc_missing')!.fix!.host).toBe('_dmarc.news.example.com')
    expect(r.inheritedFrom).toBeNull()
  })

  it('external authorization is checked for the domain that published the policy', async () => {
    const zone: FakeZone = {
      txt: { '_dmarc.example.com': [['v=DMARC1; p=none; rua=mailto:r@reports.net']] },
      mx: { 'reports.net': GOOGLE_MX },
    }
    const r = await checkDmarcDns('news.example.com', { resolver: fake(zone) })
    expect(r.externalAuth[0]!.host).toBe('example.com._report._dmarc.reports.net')
  })

  describe('SPF', () => {
    const withSpf = (records: string[][]): FakeZone => ({
      ...clean,
      txt: { '_dmarc.example.com': clean.txt!['_dmarc.example.com']!, 'example.com': records },
    })

    it('missing SPF is only a warning', async () => {
      const r = await checkDmarcDns('example.com', { resolver: fake(withSpf([['unrelated']])) })
      expect(issue(r, 'spf_missing')!.severity).toBe('warning')
      expect(r.spf).toEqual({ found: false, raw: [], all: null })
      expect(r.ok).toBe(true)
    })

    it('two SPF records is an error', async () => {
      const r = await checkDmarcDns('example.com', { resolver: fake(withSpf([['v=spf1 -all'], ['v=spf1 ~all']])) })
      expect(issue(r, 'spf_multiple')!.severity).toBe('error')
    })

    it('+all and bare all are errors, ?all a warning, ~all and -all fine', async () => {
      for (const [rec, sev] of [
        ['v=spf1 +all', 'error'],
        ['v=spf1 all', 'error'],
        ['v=spf1 ip4:1.2.3.4 ?all', 'warning'],
        ['v=spf1 ~all', null],
        ['v=spf1 -all', null],
      ] as const) {
        const r = await checkDmarcDns('example.com', { resolver: fake(withSpf([[rec]])) })
        if (sev) expect(issue(r, 'spf_permissive')?.severity, rec).toBe(sev)
        else expect(issue(r, 'spf_permissive'), rec).toBeUndefined()
      }
    })

    it('records the all mechanism, or null when there is none', async () => {
      const r = await checkDmarcDns('example.com', { resolver: fake(withSpf([['v=spf1 include:x.com']])) })
      expect(r.spf.all).toBeNull()
    })
  })

  it('pct below 100 is noted', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({
        ...clean,
        txt: { ...clean.txt, '_dmarc.example.com': [['v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc@example.com']] },
      }),
    })
    expect(issue(r, 'pct_partial')!.severity).toBe('info')
    expect(issue(r, 'policy_none')).toBeUndefined()
  })

  it('ENODATA is "no records", not a failure', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({ ...clean, fail: { 'example.com': 'ENODATA' } }),
    })
    expect(issue(r, 'lookup_failed')).toBeUndefined()
    expect(issue(r, 'spf_missing')).toBeDefined()
  })

  it('any other DNS error → lookup_failed warning, never a false dmarc_missing', async () => {
    const r = await checkDmarcDns('example.com', {
      resolver: fake({ ...clean, fail: { '_dmarc.example.com': 'ESERVFAIL' } }),
    })
    expect(issue(r, 'lookup_failed')!.severity).toBe('warning')
    expect(issue(r, 'dmarc_missing')).toBeUndefined()
    expect(r.ok).toBe(true)
  })

  it('ok is false exactly when some issue is an error', async () => {
    for (const zone of [clean, {}, { txt: clean.txt }]) {
      const r = await checkDmarcDns('example.com', { resolver: fake(zone) })
      expect(r.ok).toBe(!r.issues.some((i) => i.severity === 'error'))
    }
  })
})

describe('lookupPtr', () => {
  beforeEach(() => _clearPtrCache())

  it('returns one entry per distinct IP, first name, trailing dot stripped, lowercased', async () => {
    const resolver = fake({ ptr: { '1.2.3.4': ['Mail.Example.NET.', 'other.example.net.'] } })
    const m = await lookupPtr(['1.2.3.4', '1.2.3.4', '5.6.7.8'], { resolver })
    expect(m.get('1.2.3.4')).toBe('mail.example.net')
    expect(m.get('5.6.7.8')).toBeNull()
    expect(m.size).toBe(2)
  })

  it('never throws: errors and empty answers are null', async () => {
    const resolver = fake({ ptr: { '1.1.1.1': [] }, fail: { '2.2.2.2': 'ESERVFAIL' } })
    const m = await lookupPtr(['1.1.1.1', '2.2.2.2'], { resolver })
    expect(m.get('1.1.1.1')).toBeNull()
    expect(m.get('2.2.2.2')).toBeNull()
  })

  it('a lookup that hangs times out to null', async () => {
    const resolver: DmarcDnsResolver = {
      resolveTxt: () => Promise.resolve([]),
      resolveMx: () => Promise.resolve([]),
      reverse: () => new Promise(() => {}),
    }
    const started = Date.now()
    const m = await lookupPtr(['9.9.9.9'], { resolver, timeoutMs: 30 })
    expect(m.get('9.9.9.9')).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('caches answers across calls', async () => {
    const resolver = fake({ ptr: { '1.2.3.4': ['a.example.net'] } })
    await lookupPtr(['1.2.3.4'], { resolver })
    const m = await lookupPtr(['1.2.3.4'], { resolver })
    expect(m.get('1.2.3.4')).toBe('a.example.net')
    expect(resolver.calls.filter((c) => c === 'ptr:1.2.3.4')).toHaveLength(1)
  })

  it('empty input makes no lookups', async () => {
    const resolver = fake({})
    expect((await lookupPtr([], { resolver })).size).toBe(0)
    expect(resolver.calls).toEqual([])
  })
})
