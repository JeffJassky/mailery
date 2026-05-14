import { describe, expect, it } from 'vitest'
import { suggestPolicyProgression } from '../../src/server/runner/dmarc.js'

function makeReports(n: number, passRate = 1.0, totalPerReport = 50) {
  const reports = []
  const now = Date.now()
  for (let i = 0; i < n; i++) {
    reports.push({
      rangeEnd: new Date(now - i * 86_400_000),
      passCount: Math.round(totalPerReport * passRate),
      failCount: Math.round(totalPerReport * (1 - passRate)),
    })
  }
  return reports
}

describe('suggestPolicyProgression', () => {
  it('returns null with insufficient data', () => {
    const s = suggestPolicyProgression({
      reports: makeReports(5),
      failures: [],
      knownSourceIps: new Set(),
      ignoredSourceIps: new Set(),
      currentPolicy: 'none',
      currentPct: 100,
    })
    expect(s).toBeNull()
  })

  it('suggests p=quarantine pct=10 from p=none when alignment ≥99% and ≥30 reports', () => {
    const s = suggestPolicyProgression({
      reports: makeReports(35, 1.0, 100),
      failures: [],
      knownSourceIps: new Set(),
      ignoredSourceIps: new Set(),
      currentPolicy: 'none',
      currentPct: 100,
    })
    expect(s).not.toBeNull()
    expect(s!.policy).toBe('quarantine')
    expect(s!.pct).toBe(10)
  })

  it('blocks the suggestion when untagged failing sources exist', () => {
    const s = suggestPolicyProgression({
      reports: makeReports(35, 0.99, 100),
      failures: [
        { sourceIp: '198.51.100.7', count: 5, receivedAt: new Date() },
      ],
      knownSourceIps: new Set(),
      ignoredSourceIps: new Set(),
      currentPolicy: 'none',
      currentPct: 100,
    })
    expect(s).toBeNull()
  })

  it('allows the suggestion when failing sources are all ignored or known', () => {
    const s = suggestPolicyProgression({
      reports: makeReports(35, 1.0, 100),
      failures: [
        { sourceIp: '198.51.100.7', count: 5, receivedAt: new Date() },
      ],
      knownSourceIps: new Set([]),
      ignoredSourceIps: new Set(['198.51.100.7']),
      currentPolicy: 'none',
      currentPct: 100,
    })
    expect(s).not.toBeNull()
  })

  it('ramps pct from quarantine pct=10 to 25 when alignment held', () => {
    const s = suggestPolicyProgression({
      reports: makeReports(35, 1.0, 100),
      failures: [],
      knownSourceIps: new Set(),
      ignoredSourceIps: new Set(),
      currentPolicy: 'quarantine',
      currentPct: 10,
    })
    expect(s).toEqual(expect.objectContaining({ policy: 'quarantine', pct: 25 }))
  })

  it('suggests p=reject from quarantine pct=100 when alignment ≥99.9%', () => {
    const s = suggestPolicyProgression({
      reports: makeReports(35, 1.0, 100),
      failures: [],
      knownSourceIps: new Set(),
      ignoredSourceIps: new Set(),
      currentPolicy: 'quarantine',
      currentPct: 100,
    })
    expect(s).toEqual(expect.objectContaining({ policy: 'reject', pct: 100 }))
  })

  it('returns null when already at p=reject', () => {
    const s = suggestPolicyProgression({
      reports: makeReports(35, 1.0, 100),
      failures: [],
      knownSourceIps: new Set(),
      ignoredSourceIps: new Set(),
      currentPolicy: 'reject',
      currentPct: 100,
    })
    expect(s).toBeNull()
  })

  it('returns null when alignment is below threshold from p=none', () => {
    const s = suggestPolicyProgression({
      reports: makeReports(35, 0.95, 100),
      failures: [],
      knownSourceIps: new Set(),
      ignoredSourceIps: new Set(),
      currentPolicy: 'none',
      currentPct: 100,
    })
    expect(s).toBeNull()
  })
})
