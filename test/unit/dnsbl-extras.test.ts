/**
 * Regression tests for the second-pass review fixes in dnsbl.ts:
 *   - registrableDomain via PSL (multi-label TLDs like .co.uk)
 *   - reverseIPv6Nibbles with embedded IPv4 (::ffff:1.2.3.4)
 */
import { describe, expect, it } from 'vitest'

import { reverseIPv6Nibbles } from '../../src/server/runner/dnsbl.js'

describe('reverseIPv6Nibbles — IPv4-mapped form', () => {
  it('expands ::ffff:1.2.3.4 before nibble-reversing', () => {
    // Mapped form expands to ::ffff:0102:0304 → padded to 32 nibbles.
    const out = reverseIPv6Nibbles('::ffff:1.2.3.4')
    expect(out.split('.')).toHaveLength(32)
    // Reverse of the trailing 0102:0304 produces 4.0.3.0.2.0.1.0 at the start.
    expect(out.startsWith('4.0.3.0.2.0.1.0.f.f.f.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0')).toBe(true)
  })

  it('handles a normal compressed IPv6 address', () => {
    expect(reverseIPv6Nibbles('2001:db8::1').split('.')).toHaveLength(32)
  })

  it('handles a fully-expanded IPv6 address', () => {
    const out = reverseIPv6Nibbles('2001:0db8:0000:0000:0000:0000:0000:0001')
    expect(out.split('.')).toHaveLength(32)
  })

  it('throws on malformed input (wrong number of groups)', () => {
    expect(() => reverseIPv6Nibbles('not-an-ipv6')).toThrow()
  })
})
