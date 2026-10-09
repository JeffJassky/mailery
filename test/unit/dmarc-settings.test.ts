/**
 * DMARC Monitoring settings layering and patch validation
 * (plans/18-dmarc-monitoring.md §6.1). Contract tests: red until PR 1B lands.
 */

import { describe, expect, it } from 'vitest'

import {
  DMARC_SETTINGS_DEFAULTS,
  mergeDmarcSettings,
  validateDmarcSettingsPatch,
} from '../../src/server/runner/dmarc-settings.js'

describe('mergeDmarcSettings', () => {
  it('no config, no patch → defaults (a copy, not the shared object)', () => {
    const s = mergeDmarcSettings(undefined, null)
    expect(s).toEqual(DMARC_SETTINGS_DEFAULTS)
    s.alerts.windowDays = 99
    s.extraDomains.push('x.com')
    expect(DMARC_SETTINGS_DEFAULTS.alerts.windowDays).toBe(7)
    expect(DMARC_SETTINGS_DEFAULTS.extraDomains).toEqual([])
  })

  it('config overrides defaults, patch overrides config, key by key', () => {
    const s = mergeDmarcSettings(
      { alerts: { windowDays: 14, unknownSourceMinMessages: 50 }, reportAddress: 'r@x.com', extraDomains: ['a.com'] },
      { alerts: { windowDays: 3 }, ignoredDomains: ['b.com'] },
    )
    expect(s.alerts.windowDays).toBe(3)
    expect(s.alerts.unknownSourceMinMessages).toBe(50)
    expect(s.alerts.alignmentMinRate).toBe(0.98)
    expect(s.reportAddress).toBe('r@x.com')
    expect(s.extraDomains).toEqual(['a.com'])
    expect(s.ignoredDomains).toEqual(['b.com'])
  })

  it('arrays from a patch replace, never concatenate', () => {
    const s = mergeDmarcSettings({ extraDomains: ['a.com', 'b.com'] }, { extraDomains: ['c.com'] })
    expect(s.extraDomains).toEqual(['c.com'])
  })

  it('a patch can clear reportAddress with null', () => {
    expect(mergeDmarcSettings({ reportAddress: 'r@x.com' }, { reportAddress: null }).reportAddress).toBeNull()
  })

  it('domain lists are lowercased, trimmed and deduplicated', () => {
    const s = mergeDmarcSettings({ extraDomains: [' A.com', 'a.com', 'B.COM'] }, null)
    expect(s.extraDomains).toEqual(['a.com', 'b.com'])
  })

  it('ignores DmarcConfig keys that are not settings', () => {
    const s = mergeDmarcSettings({ retentionDays: 30, knownSources: [{ ip: '1.2.3.4', label: 'x' }], adminUrl: 'https://a' }, null)
    expect(Object.keys(s).sort()).toEqual(['alerts', 'extraDomains', 'ignoredDomains', 'reportAddress'])
  })
})

describe('validateDmarcSettingsPatch', () => {
  const ok = (body: unknown) => {
    const r = validateDmarcSettingsPatch(body)
    if (!r.ok) throw new Error(`expected ok, got: ${r.message}`)
    return r.patch
  }
  const bad = (body: unknown) => {
    const r = validateDmarcSettingsPatch(body)
    expect(r.ok, JSON.stringify(body)).toBe(false)
    return r.ok ? '' : r.message
  }

  it('accepts an empty patch', () => {
    expect(ok({})).toEqual({})
  })

  it('accepts every field at its bounds', () => {
    const patch = {
      alerts: {
        enabled: false,
        disabledKinds: ['policy_ready', 'dns_misconfigured'],
        windowDays: 30,
        unknownSourceMinMessages: 1,
        knownSourceMinMessages: 1_000_000,
        alignmentMinRate: 0.5,
        alignmentMinMessages: 1,
        reportsStoppedDays: 60,
        realertAfterHours: 0,
        dnsCheckIntervalHours: 720,
      },
      reportAddress: 'reports@dmarc-in.example.com',
      extraDomains: ['example.co.uk'],
      ignoredDomains: [],
    }
    expect(ok(patch)).toEqual(patch)
    expect(ok({ reportAddress: null })).toEqual({ reportAddress: null })
    expect(ok({ alerts: { alignmentMinRate: 1, windowDays: 1, realertAfterHours: 8760 } })).toBeTruthy()
  })

  it('lowercases domains on the way in', () => {
    expect(ok({ extraDomains: ['News.Example.COM'] })).toEqual({ extraDomains: ['news.example.com'] })
  })

  it('rejects non-objects and unknown keys, naming the key', () => {
    bad(null)
    bad('x')
    bad([])
    expect(bad({ secret: 'x' })).toMatch(/secret/)
    expect(bad({ alerts: { volume: 3 } })).toMatch(/volume/)
  })

  it('rejects out-of-range and non-integer numbers, naming the field', () => {
    expect(bad({ alerts: { windowDays: 0 } })).toMatch(/windowDays/)
    expect(bad({ alerts: { windowDays: 31 } })).toMatch(/windowDays/)
    expect(bad({ alerts: { windowDays: 2.5 } })).toMatch(/windowDays/)
    expect(bad({ alerts: { unknownSourceMinMessages: 0 } })).toMatch(/unknownSourceMinMessages/)
    expect(bad({ alerts: { knownSourceMinMessages: 1_000_001 } })).toMatch(/knownSourceMinMessages/)
    expect(bad({ alerts: { alignmentMinMessages: '100' } })).toMatch(/alignmentMinMessages/)
    expect(bad({ alerts: { reportsStoppedDays: 61 } })).toMatch(/reportsStoppedDays/)
    expect(bad({ alerts: { realertAfterHours: -1 } })).toMatch(/realertAfterHours/)
    expect(bad({ alerts: { dnsCheckIntervalHours: 721 } })).toMatch(/dnsCheckIntervalHours/)
    expect(bad({ alerts: { alignmentMinRate: 0.49 } })).toMatch(/alignmentMinRate/)
    expect(bad({ alerts: { alignmentMinRate: 1.01 } })).toMatch(/alignmentMinRate/)
    expect(bad({ alerts: { enabled: 'yes' } })).toMatch(/enabled/)
  })

  it('rejects unknown alert kinds, including test', () => {
    expect(bad({ alerts: { disabledKinds: ['nope'] } })).toMatch(/disabledKinds/)
    expect(bad({ alerts: { disabledKinds: ['test'] } })).toMatch(/disabledKinds/)
  })

  it('rejects bad domains and over-long lists', () => {
    expect(bad({ extraDomains: ['not a domain'] })).toMatch(/extraDomains/)
    expect(bad({ ignoredDomains: ['localhost'] })).toMatch(/ignoredDomains/)
    expect(bad({ extraDomains: 'a.com' })).toMatch(/extraDomains/)
    const many = Array.from({ length: 101 }, (_, i) => `d${i}.example.com`)
    expect(bad({ extraDomains: many })).toMatch(/extraDomains/)
  })

  it('rejects a malformed report address', () => {
    expect(bad({ reportAddress: 'nope' })).toMatch(/reportAddress/)
    expect(bad({ reportAddress: 'a b@x.com' })).toMatch(/reportAddress/)
    expect(bad({ reportAddress: 5 })).toMatch(/reportAddress/)
  })
})
