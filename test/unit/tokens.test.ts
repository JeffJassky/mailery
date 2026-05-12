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
    const tampered = `${body}.${sig!.slice(0, -2)}AA`
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
