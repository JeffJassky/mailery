import { describe, it, expect } from 'vitest'
import { EventRegistry } from '../../src/server/events.js'

describe('EventRegistry dedupeKey policies', () => {
  it('returns the passed key when one is provided', () => {
    const reg = new EventRegistry()
    const key = reg.deriveKey('Anything', 'u1', 'caller-key', new Date())
    expect(key).toBe('caller-key')
  })

  it('returns null when no policy and no key', () => {
    const reg = new EventRegistry()
    expect(reg.deriveKey('Unregistered', 'u1', undefined, new Date())).toBeNull()
  })

  it('once-per-contact yields stable per-contact key', () => {
    const reg = new EventRegistry()
    reg.register({ name: 'Created', dedupePolicy: 'once-per-contact' })
    const a = reg.deriveKey('Created', 'u1', undefined, new Date('2026-01-01'))
    const b = reg.deriveKey('Created', 'u1', undefined, new Date('2026-12-31'))
    expect(a).toBe('u1:Created')
    expect(b).toBe('u1:Created')
  })

  it('once-per-day yields a date-stamped key', () => {
    const reg = new EventRegistry()
    reg.register({ name: 'Viewed', dedupePolicy: 'once-per-day' })
    const a = reg.deriveKey('Viewed', 'u1', undefined, new Date('2026-05-12T08:00:00Z'))
    const b = reg.deriveKey('Viewed', 'u1', undefined, new Date('2026-05-12T22:00:00Z'))
    const c = reg.deriveKey('Viewed', 'u1', undefined, new Date('2026-05-13T08:00:00Z'))
    expect(a).toBe('u1:Viewed:2026-05-12')
    expect(b).toBe('u1:Viewed:2026-05-12')
    expect(c).toBe('u1:Viewed:2026-05-13')
  })

  it('every-time yields a unique key per call', () => {
    const reg = new EventRegistry()
    reg.register({ name: 'Imported', dedupePolicy: 'every-time' })
    const a = reg.deriveKey('Imported', 'u1', undefined, new Date())
    const b = reg.deriveKey('Imported', 'u1', undefined, new Date())
    expect(a).not.toBe(b)
    expect(a).toMatch(/^u1:Imported:/)
  })
})
