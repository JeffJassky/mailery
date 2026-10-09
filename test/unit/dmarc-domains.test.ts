/**
 * Monitored-domain resolution (plans/18-dmarc-monitoring.md §6.2).
 * Contract tests: red until PR 1C lands.
 */

import { describe, expect, it } from 'vitest'

import { deriveSenderDomains, resolveMonitoredDomains } from '../../src/server/runner/dmarc-domains.js'
import { DMARC_SETTINGS_DEFAULTS } from '../../src/server/runner/dmarc-settings.js'
import type { DmarcMonitoringSettings } from '../../src/shared/dmarc-types.js'

function settings(over: Partial<DmarcMonitoringSettings> = {}): DmarcMonitoringSettings {
  return { ...structuredClone(DMARC_SETTINGS_DEFAULTS), ...over }
}

describe('deriveSenderDomains', () => {
  it('collects sender domains, From defaults and their organizational domains', () => {
    expect(
      deriveSenderDomains({
        senderDomains: { 'News.Example.com': { kind: 'marketing' }, 'tx.example.com': { kind: 'transactional' } },
        fromDefaults: { name: 'A', email: 'hello@example.com' },
        transactionalFromDefaults: { name: 'B', email: 'noreply@mail.other.io' },
      }),
    ).toEqual(['example.com', 'mail.other.io', 'news.example.com', 'other.io', 'tx.example.com'])
  })

  it('uses the public suffix list for multi-label suffixes', () => {
    expect(deriveSenderDomains({ fromDefaults: { name: 'A', email: 'a@mail.example.co.uk' } })).toEqual([
      'example.co.uk',
      'mail.example.co.uk',
    ])
  })

  it('senderAddress is a postal address and is never treated as a domain', () => {
    expect(deriveSenderDomains({ senderAddress: '1 Test St, Brooklyn NY 11201' })).toEqual([])
  })

  it('nothing configured → nothing', () => {
    expect(deriveSenderDomains({})).toEqual([])
  })
})

describe('resolveMonitoredDomains', () => {
  const config = { fromDefaults: { name: 'A', email: 'a@example.com' } }

  it('unions config, extra and report domains, recording every origin', () => {
    const out = resolveMonitoredDomains(config, settings({ extraDomains: ['side.io', 'example.com'] }), [
      'Example.com',
      'spoofed-only.net',
    ])
    expect(out).toEqual([
      { domain: 'example.com', origin: ['config', 'extra', 'reports'], ignored: false },
      { domain: 'side.io', origin: ['extra'], ignored: false },
      { domain: 'spoofed-only.net', origin: ['reports'], ignored: false },
    ])
  })

  it('flags ignored domains but keeps them in the list', () => {
    const out = resolveMonitoredDomains(config, settings({ ignoredDomains: ['example.com'] }), [])
    expect(out).toEqual([{ domain: 'example.com', origin: ['config'], ignored: true }])
  })

  it('drops report domains that are not valid domains (rows stored before 0.21 were unvalidated)', () => {
    const out = resolveMonitoredDomains({}, settings(), ['ok.example', 'example.com\n[CRITICAL] <https://evil|x>', 'xn--80ak6aa92e.xn--p1ai'])
    expect(out.map((d) => d.domain)).toEqual(['ok.example', 'xn--80ak6aa92e.xn--p1ai'])
  })

  it('an ignored domain that appears nowhere else is not added', () => {
    expect(resolveMonitoredDomains({}, settings({ ignoredDomains: ['x.com'] }), [])).toEqual([])
  })
})
