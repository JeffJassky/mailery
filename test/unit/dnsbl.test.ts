import { describe, it, expect } from 'vitest'
import { interpretRecords, reverseIPv4 } from '../../src/server/runner/dnsbl.js'

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

  it('treats non-127 result as clean', () => {
    const r = interpretRecords(['192.0.2.1'])
    expect(r.result).toBe('clean')
  })

  it('mixed valid + reserved codes still counts as listed', () => {
    const r = interpretRecords(['127.0.0.2', '127.255.255.252'])
    expect(r.result).toBe('listed')
  })
})

describe('reverseIPv4', () => {
  it('reverses octets', () => {
    expect(reverseIPv4('1.2.3.4')).toBe('4.3.2.1')
    expect(reverseIPv4('203.0.113.5')).toBe('5.113.0.203')
  })
})
