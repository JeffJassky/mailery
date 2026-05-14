import { describe, it, expect } from 'vitest'
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../../src/server/tokens.js'

const SECRET = 'a'.repeat(64)

describe('unsubscribe tokens', () => {
  it('round-trips a valid token', () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const token = signUnsubscribeToken({ email: 'user@example.com', scope: 'marketing', expiresAt }, SECRET)
    const decoded = verifyUnsubscribeToken(token, SECRET)
    expect(decoded).not.toBeNull()
    expect(decoded?.email).toBe('user@example.com')
    expect(decoded?.scope).toBe('marketing')
    expect(decoded?.expiresAt.getTime()).toBe(expiresAt.getTime())
  })

  it('lowercases the email at signing time', () => {
    const expiresAt = new Date(Date.now() + 1000)
    const token = signUnsubscribeToken({ email: 'USER@Example.COM', scope: 'all', expiresAt }, SECRET)
    const decoded = verifyUnsubscribeToken(token, SECRET)
    expect(decoded?.email).toBe('user@example.com')
  })

  it('rejects tampered tokens', () => {
    const expiresAt = new Date(Date.now() + 1000)
    const token = signUnsubscribeToken({ email: 'user@example.com', scope: 'marketing', expiresAt }, SECRET)
    const [body, sig] = token.split('.')
    // Tamper at position 0 — a full-byte position in the base64url-encoded
    // signature. (Tampering the *last* char of a 32-byte HMAC-SHA256 sig
    // can change only padding bits, since 32 bytes encode to 43 chars +
    // 4 leftover bits; many last-char swaps decode to the same bytes and
    // would let a tampered token verify.)
    const first = sig!.slice(0, 1)
    const replacement = first === 'A' ? 'B' : 'A'
    const tampered = `${body}.${replacement}${sig!.slice(1)}`
    expect(verifyUnsubscribeToken(tampered, SECRET)).toBeNull()
  })

  it('rejects expired tokens', () => {
    const past = new Date(Date.now() - 1000)
    const token = signUnsubscribeToken({ email: 'user@example.com', scope: 'all', expiresAt: past }, SECRET)
    expect(verifyUnsubscribeToken(token, SECRET)).toBeNull()
  })

  it('rejects wrong secret', () => {
    const expiresAt = new Date(Date.now() + 1000)
    const token = signUnsubscribeToken({ email: 'user@example.com', scope: 'all', expiresAt }, SECRET)
    expect(verifyUnsubscribeToken(token, 'other-secret')).toBeNull()
  })

  it('rejects garbage input', () => {
    expect(verifyUnsubscribeToken('garbage', SECRET)).toBeNull()
    expect(verifyUnsubscribeToken('a.b', SECRET)).toBeNull()
    expect(verifyUnsubscribeToken('', SECRET)).toBeNull()
  })
})
