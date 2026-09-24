import { describe, it, expect } from 'vitest'
import { interpretRecords, reverseIPv4, spamhausQueryHost } from '../../src/server/runner/dnsbl.js'

describe('dnsbl record interpretation', () => {
  it('treats empty result as clean', () => {
    const r = interpretRecords([])
    expect(r.result).toBe('clean')
    expect(r.returnCodes).toEqual([])
  })

  it('treats 127.0.0.x A record as listed', () => {
    const r = interpretRecords(['127.0.0.2'])
    expect(r.result).toBe('listed')
    expect(r.returnCodes).toEqual(['127.0.0.2'])
  })

  it('treats multiple 127.0.x.x A records as listed', () => {
    const r = interpretRecords(['127.0.0.2', '127.0.1.4'])
    expect(r.result).toBe('listed')
  })

  it('treats 127.255.255.x reserved codes as error', () => {
    const r = interpretRecords(['127.255.255.252'])
    expect(r.result).toBe('error')
    expect(r.errorMessage).toContain('127.255.255.252')
  })

  it('explains the public-resolver refusal and points at the DQS key', () => {
    const r = interpretRecords(['127.255.255.254'])
    expect(r.result).toBe('error')
    expect(r.errorMessage).toContain('not a listing')
    expect(r.errorMessage).toContain('public or shared DNS resolver')
    expect(r.errorMessage).toContain('spamhausDqsKey')
  })

  it('treats non-127 result as clean', () => {
    const r = interpretRecords(['192.0.2.1'])
    expect(r.result).toBe('clean')
  })

  it('mixed valid + reserved codes still counts as listed', () => {
    const r = interpretRecords(['127.0.0.2', '127.255.255.252'])
    expect(r.result).toBe('listed')
  })

  it('treats URIBL/SURBL 127.0.0.1 as a refused query, not a listing', () => {
    for (const host of ['multi.uribl.com', 'multi.surbl.org']) {
      const r = interpretRecords(['127.0.0.1'], host)
      expect(r.result).toBe('error')
      expect(r.errorMessage).toContain('refused')
    }
  })

  it('still lists real URIBL codes', () => {
    expect(interpretRecords(['127.0.0.2'], 'multi.uribl.com').result).toBe('listed')
  })

  it('keeps 127.0.0.1 as listed on other lists', () => {
    expect(interpretRecords(['127.0.0.1'], 'zen.spamhaus.org').result).toBe('listed')
  })
})

describe('spamhausQueryHost', () => {
  it('routes Spamhaus zones through DQS when a key is set', () => {
    expect(spamhausQueryHost('dbl.spamhaus.org', 'abc123')).toBe('abc123.dbl.dq.spamhaus.net')
    expect(spamhausQueryHost('zen.spamhaus.org', 'abc123')).toBe('abc123.zen.dq.spamhaus.net')
  })

  it('leaves other lists, and Spamhaus without a key, unchanged', () => {
    expect(spamhausQueryHost('multi.surbl.org', 'abc123')).toBe('multi.surbl.org')
    expect(spamhausQueryHost('dbl.spamhaus.org', undefined)).toBe('dbl.spamhaus.org')
  })
})

describe('reverseIPv4', () => {
  it('reverses octets', () => {
    expect(reverseIPv4('1.2.3.4')).toBe('4.3.2.1')
    expect(reverseIPv4('203.0.113.5')).toBe('5.113.0.203')
  })
})
