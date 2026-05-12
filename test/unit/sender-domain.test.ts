import { describe, it, expect } from 'vitest'

import { validateSenderDomain, type SenderDomainRegistry } from '../../src/server/templates/sender-domain.js'

const registry: SenderDomainRegistry = {
  'news.example.com': { kind: 'marketing' },
  'mail.example.com': { kind: 'transactional' },
  'tools.example.com': { kind: 'both' },
}

describe('validateSenderDomain', () => {
  it('allows when registry is undefined (back-compat)', () => {
    const result = validateSenderDomain('anything@whatever.com', 'marketing', undefined)
    expect(result.ok).toBe(true)
  })

  it('allows when registry is empty', () => {
    const result = validateSenderDomain('anything@whatever.com', 'marketing', {})
    expect(result.ok).toBe(true)
  })

  it('rejects unregistered domain', () => {
    const result = validateSenderDomain('hi@random.com', 'marketing', registry)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('unregistered_domain')
    expect(result.reason).toContain('random.com')
  })

  it('rejects wrong-kind domain (marketing template, transactional domain)', () => {
    const result = validateSenderDomain('hi@mail.example.com', 'marketing', registry)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('wrong_kind')
    expect(result.reason).toContain('transactional')
    expect(result.reason).toContain('marketing')
  })

  it('rejects wrong-kind domain (transactional template, marketing domain)', () => {
    const result = validateSenderDomain('hi@news.example.com', 'transactional', registry)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('wrong_kind')
  })

  it('allows matching kind', () => {
    expect(validateSenderDomain('hi@news.example.com', 'marketing', registry).ok).toBe(true)
    expect(validateSenderDomain('hi@mail.example.com', 'transactional', registry).ok).toBe(true)
  })

  it('allows "both" for either kind', () => {
    expect(validateSenderDomain('hi@tools.example.com', 'marketing', registry).ok).toBe(true)
    expect(validateSenderDomain('hi@tools.example.com', 'transactional', registry).ok).toBe(true)
  })

  it('is case-insensitive in domain matching', () => {
    expect(validateSenderDomain('hi@News.Example.COM', 'marketing', registry).ok).toBe(true)
  })

  it('rejects malformed emails', () => {
    expect(validateSenderDomain('no-at-sign', 'marketing', registry).ok).toBe(false)
    expect(validateSenderDomain('', 'marketing', registry).ok).toBe(false)
    expect(validateSenderDomain('trailing@', 'marketing', registry).ok).toBe(false)
    expect(validateSenderDomain('@leading.com', 'marketing', registry).ok).toBe(false)
  })
})
