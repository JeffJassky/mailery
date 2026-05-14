import { describe, expect, it } from 'vitest'
import { mailTesterContentKey } from '../../src/server/runner/mail-tester.js'

describe('mailTesterContentKey', () => {
  it('produces the same key for identical content', () => {
    const a = mailTesterContentKey({ bodyHash: 'abc', subject: 'Welcome', fromEmail: 'hi@example.com' })
    const b = mailTesterContentKey({ bodyHash: 'abc', subject: 'Welcome', fromEmail: 'hi@example.com' })
    expect(a).toBe(b)
  })

  it('differs when subject changes', () => {
    const a = mailTesterContentKey({ bodyHash: 'abc', subject: 'Welcome', fromEmail: 'hi@example.com' })
    const b = mailTesterContentKey({ bodyHash: 'abc', subject: 'Welcome!', fromEmail: 'hi@example.com' })
    expect(a).not.toBe(b)
  })

  it('differs when fromEmail changes', () => {
    const a = mailTesterContentKey({ bodyHash: 'abc', subject: 'Welcome', fromEmail: 'a@example.com' })
    const b = mailTesterContentKey({ bodyHash: 'abc', subject: 'Welcome', fromEmail: 'b@example.com' })
    expect(a).not.toBe(b)
  })

  it('differs when bodyHash changes', () => {
    const a = mailTesterContentKey({ bodyHash: 'abc', subject: 'Welcome', fromEmail: 'hi@example.com' })
    const b = mailTesterContentKey({ bodyHash: 'xyz', subject: 'Welcome', fromEmail: 'hi@example.com' })
    expect(a).not.toBe(b)
  })
})
