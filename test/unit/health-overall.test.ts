import { describe, expect, it } from 'vitest'
import { effectiveOverallStatus } from '../../src/server/runner/health.js'
import type { HealthDoc } from '../../src/server/models/index.js'

function bucket(status: HealthDoc['status'], _id: string = `d:${status}.example.com|k:marketing`): HealthDoc {
  return {
    _id,
    senderDomain: 'x.example.com',
    kind: 'marketing',
    windowStartedAt: new Date(),
    windowDurationMs: 3_600_000,
    counters: { sent: 0, delivered: 0, bounced: 0, hardBounced: 0, softBounced: 0, complained: 0, failedToSend: 0 },
    rates: { bounceRate: 0, hardBounceRate: 0, complaintRate: 0, failureRate: 0 },
    status,
    trippedAt: null,
    trippedReason: null,
    manuallyResumedAt: null,
    updatedAt: new Date(),
  }
}

function agg(status: HealthDoc['status']): HealthDoc {
  return { ...bucket(status, 'agg'), senderDomain: null, kind: null }
}

describe('effectiveOverallStatus', () => {
  it('returns null when no docs exist', () => {
    expect(effectiveOverallStatus([])).toBeNull()
  })

  it('returns healthy when only aggregate exists', () => {
    expect(effectiveOverallStatus([agg('healthy')])).toBe('healthy')
  })

  it('returns tripped when any bucket is tripped (ignoring aggregate)', () => {
    expect(effectiveOverallStatus([
      agg('healthy'),
      bucket('healthy', 'd:a|k:marketing'),
      bucket('tripped', 'd:b|k:marketing'),
    ])).toBe('tripped')
  })

  it('returns degraded when no bucket is tripped but some are degraded', () => {
    expect(effectiveOverallStatus([
      agg('healthy'),
      bucket('healthy', 'd:a|k:marketing'),
      bucket('degraded', 'd:b|k:marketing'),
    ])).toBe('degraded')
  })

  it('returns healthy when all buckets are healthy', () => {
    expect(effectiveOverallStatus([
      agg('healthy'),
      bucket('healthy', 'd:a|k:marketing'),
      bucket('healthy', 'd:b|k:transactional'),
    ])).toBe('healthy')
  })

  it('ignores aggregate status — tripped agg with healthy buckets is healthy overall', () => {
    expect(effectiveOverallStatus([
      agg('tripped'),
      bucket('healthy', 'd:a|k:marketing'),
    ])).toBe('healthy')
  })
})
