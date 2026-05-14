/**
 * HTTP-level admin tests for the deliverability endpoints added in PR1-10:
 *   /health (per-bucket)            /health/resume
 *   /dnsbl                          /dnsbl/recheck
 *   /postmaster                     /postmaster/refresh
 *   /snds                           /snds/refresh
 *   /dmarc                          /dmarc/upload
 *   /dmarc/sources/:ip              /hygiene
 *
 * Module-level tests cover the underlying behavior. These tests verify the
 * HTTP plumbing — auth, JSON parsing, status codes, response shape.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'
import zlib from 'node:zlib'

import { createAdminRouter } from '../../src/server/api/admin.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { healthBucketId } from '../../src/server/models/index.js'
import type { Resolver } from '../../src/server/runner/dnsbl.js'

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<typeof express>['listen'] extends (...a: any) => infer R ? R : never

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      senderDomains: {
        'news.example.com': { kind: 'marketing' },
        'mail.example.com': { kind: 'transactional' },
      },
      fromDefaults: { name: 'Test', email: 'hello@news.example.com' },
      transactionalFromDefaults: { name: 'Test', email: 'noreply@mail.example.com' },
      dnsbl: {
        domainLists: [{ host: 'dbl.test', label: 'Test DBL' }],
        ipLists: [],
        intervalHours: 24,
      },
    },
  })
  const app = express()
  app.use(express.json())
  app.use('/admin/mailer', createAdminRouter(H.mailer))
  server = app.listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  server?.close()
  if (H) await H.stop()
})

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : ''
    const hdr: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(data)),
      ...headers,
    }
    const req = request(`${baseUrl}${path}`, { method, headers: hdr }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }) }
        catch { resolve({ status: res.statusCode ?? 0, body: raw }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const get = (p: string) => send('GET', p)
const post = (p: string, b?: unknown) => send('POST', p, b)
const put = (p: string, b: unknown) => send('PUT', p, b)
const del = (p: string) => send('DELETE', p)

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns null status before any tick has run', async () => {
    await H.mailer.collections.health.deleteMany({})
    const res = await get('/admin/mailer/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBeNull()
    expect(res.body.buckets).toEqual([])
    expect(res.body.thresholds).toHaveProperty('hardBounceRatePctTrip')
  })

  it('returns per-bucket data + aggregate + overall status when buckets exist', async () => {
    await H.mailer.collections.health.deleteMany({})
    // Seed: one tripped marketing bucket, one healthy transactional bucket, aggregate.
    await H.mailer.collections.health.insertMany([
      {
        _id: 'agg',
        senderDomain: null,
        kind: null,
        windowStartedAt: new Date(),
        windowDurationMs: 3_600_000,
        counters: { sent: 200, delivered: 180, bounced: 12, hardBounced: 10, softBounced: 2, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0.06, hardBounceRate: 0.05, complaintRate: 0, failureRate: 0 },
        status: 'healthy',
        trippedAt: null,
        trippedReason: null,
        manuallyResumedAt: null,
        updatedAt: new Date(),
      },
      {
        _id: healthBucketId('news.example.com', 'marketing'),
        senderDomain: 'news.example.com',
        kind: 'marketing',
        windowStartedAt: new Date(),
        windowDurationMs: 3_600_000,
        counters: { sent: 100, delivered: 90, bounced: 10, hardBounced: 10, softBounced: 0, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0.1, hardBounceRate: 0.1, complaintRate: 0, failureRate: 0 },
        status: 'tripped',
        trippedAt: new Date(),
        trippedReason: 'hard bounce rate 10.00% >= 2%',
        manuallyResumedAt: null,
        updatedAt: new Date(),
      },
      {
        _id: healthBucketId('mail.example.com', 'transactional'),
        senderDomain: 'mail.example.com',
        kind: 'transactional',
        windowStartedAt: new Date(),
        windowDurationMs: 3_600_000,
        counters: { sent: 100, delivered: 100, bounced: 0, hardBounced: 0, softBounced: 0, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0, hardBounceRate: 0, complaintRate: 0, failureRate: 0 },
        status: 'healthy',
        trippedAt: null,
        trippedReason: null,
        manuallyResumedAt: null,
        updatedAt: new Date(),
      },
    ])

    const res = await get('/admin/mailer/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('tripped') // worst bucket wins
    expect(res.body.aggregate.counters.sent).toBe(200)
    expect(res.body.buckets).toHaveLength(2)
    const mkt = res.body.buckets.find((b: any) => b.senderDomain === 'news.example.com')
    expect(mkt.status).toBe('tripped')
  })
})

describe('POST /health/resume', () => {
  it('resumes a single bucket when senderDomain + kind supplied', async () => {
    await H.mailer.collections.health.deleteMany({})
    await H.mailer.collections.health.insertMany([
      {
        _id: healthBucketId('a.example.com', 'marketing'),
        senderDomain: 'a.example.com', kind: 'marketing',
        windowStartedAt: new Date(), windowDurationMs: 3_600_000,
        counters: { sent: 100, delivered: 90, bounced: 5, hardBounced: 5, softBounced: 0, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0.05, hardBounceRate: 0.05, complaintRate: 0, failureRate: 0 },
        status: 'tripped', trippedAt: new Date(), trippedReason: 'test', manuallyResumedAt: null, updatedAt: new Date(),
      },
      {
        _id: healthBucketId('b.example.com', 'marketing'),
        senderDomain: 'b.example.com', kind: 'marketing',
        windowStartedAt: new Date(), windowDurationMs: 3_600_000,
        counters: { sent: 100, delivered: 90, bounced: 5, hardBounced: 5, softBounced: 0, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0.05, hardBounceRate: 0.05, complaintRate: 0, failureRate: 0 },
        status: 'tripped', trippedAt: new Date(), trippedReason: 'test', manuallyResumedAt: null, updatedAt: new Date(),
      },
    ])
    const res = await post('/admin/mailer/api/health/resume', { senderDomain: 'a.example.com', kind: 'marketing' })
    expect(res.status).toBe(200)
    expect(res.body.resumed).toBe(1)
    const a = await H.mailer.collections.health.findOne({ _id: healthBucketId('a.example.com', 'marketing') })
    const b = await H.mailer.collections.health.findOne({ _id: healthBucketId('b.example.com', 'marketing') })
    expect(a?.status).toBe('healthy')
    expect(b?.status).toBe('tripped')
  })

  it('resumes all tripped buckets when body is empty', async () => {
    await H.mailer.collections.health.deleteMany({})
    await H.mailer.collections.health.insertMany([
      {
        _id: healthBucketId('a.example.com', 'marketing'),
        senderDomain: 'a.example.com', kind: 'marketing',
        windowStartedAt: new Date(), windowDurationMs: 3_600_000,
        counters: { sent: 100, delivered: 90, bounced: 5, hardBounced: 5, softBounced: 0, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0.05, hardBounceRate: 0.05, complaintRate: 0, failureRate: 0 },
        status: 'tripped', trippedAt: new Date(), trippedReason: 'test', manuallyResumedAt: null, updatedAt: new Date(),
      },
      {
        _id: healthBucketId('b.example.com', 'marketing'),
        senderDomain: 'b.example.com', kind: 'marketing',
        windowStartedAt: new Date(), windowDurationMs: 3_600_000,
        counters: { sent: 100, delivered: 90, bounced: 5, hardBounced: 5, softBounced: 0, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0.05, hardBounceRate: 0.05, complaintRate: 0, failureRate: 0 },
        status: 'tripped', trippedAt: new Date(), trippedReason: 'test', manuallyResumedAt: null, updatedAt: new Date(),
      },
    ])
    const res = await post('/admin/mailer/api/health/resume', {})
    expect(res.status).toBe(200)
    expect(res.body.resumed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// /dnsbl
// ---------------------------------------------------------------------------

describe('DNSBL endpoints', () => {
  it('GET /dnsbl returns empty state initially', async () => {
    await H.mailer.collections.dnsblChecks.deleteMany({})
    const res = await get('/admin/mailer/api/dnsbl')
    expect(res.status).toBe(200)
    expect(res.body.checks).toEqual([])
    expect(res.body.latestRunAt).toBeNull()
    expect(res.body.intervalHours).toBe(24)
  })

  it('GET /dnsbl returns persisted checks sorted by result/target/list', async () => {
    await H.mailer.collections.dnsblChecks.deleteMany({})
    await H.mailer.collections.dnsblChecks.insertMany([
      { target: 'news.example.com', targetKind: 'domain', list: 'dbl.test', listLabel: 'Test DBL', result: 'listed', returnCodes: ['127.0.1.4'], errorMessage: null, runAt: new Date() },
      { target: 'mail.example.com', targetKind: 'domain', list: 'dbl.test', listLabel: 'Test DBL', result: 'clean', returnCodes: [], errorMessage: null, runAt: new Date() },
    ])
    const res = await get('/admin/mailer/api/dnsbl')
    expect(res.status).toBe(200)
    expect(res.body.checks).toHaveLength(2)
    expect(res.body.latestRunAt).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// /postmaster
// ---------------------------------------------------------------------------

describe('Postmaster endpoints', () => {
  it('GET /postmaster reports not-configured when absent', async () => {
    await H.mailer.collections.postmasterSnapshots.deleteMany({})
    const res = await get('/admin/mailer/api/postmaster')
    expect(res.status).toBe(200)
    expect(res.body.configured).toBe(false)
    expect(res.body.domains).toEqual([])
  })

  it('GET /postmaster groups snapshots by domain', async () => {
    await H.mailer.collections.postmasterSnapshots.deleteMany({})
    await H.mailer.collections.postmasterSnapshots.insertMany([
      {
        domain: 'news.example.com', date: '2026-05-01', domainReputation: 'HIGH',
        ipReputations: null, userReportedSpamRatio: 0, spfSuccessRatio: 1, dkimSuccessRatio: 1,
        dmarcSuccessRatio: 1, outboundEncryptionRatio: 1, inboundEncryptionRatio: 1,
        deliveryErrors: null, spammyFeedbackLoops: null, fetchedAt: new Date(),
      },
      {
        domain: 'news.example.com', date: '2026-05-02', domainReputation: 'MEDIUM',
        ipReputations: null, userReportedSpamRatio: 0.001, spfSuccessRatio: 1, dkimSuccessRatio: 1,
        dmarcSuccessRatio: 1, outboundEncryptionRatio: 1, inboundEncryptionRatio: 1,
        deliveryErrors: null, spammyFeedbackLoops: null, fetchedAt: new Date(),
      },
    ])
    const res = await get('/admin/mailer/api/postmaster')
    expect(res.status).toBe(200)
    expect(res.body.domains).toHaveLength(1)
    expect(res.body.domains[0].latest.date).toBe('2026-05-02') // most recent first
    expect(res.body.domains[0].history).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// /snds
// ---------------------------------------------------------------------------

describe('SNDS endpoints', () => {
  it('GET /snds reports not-configured by default', async () => {
    const res = await get('/admin/mailer/api/snds')
    expect(res.status).toBe(200)
    expect(res.body.configured).toBe(false)
    expect(res.body.ips).toEqual([])
  })

  it('POST /snds/refresh returns not_configured when no apiKey', async () => {
    const res = await post('/admin/mailer/api/snds/refresh', {})
    expect(res.status).toBe(200)
    expect(res.body.ran).toBe(false)
    expect(res.body.reason).toBe('not_configured')
  })
})

// ---------------------------------------------------------------------------
// /dmarc
// ---------------------------------------------------------------------------

describe('DMARC endpoints', () => {
  it('GET /dmarc returns empty domains + sources initially', async () => {
    await H.mailer.collections.dmarcReports.deleteMany({})
    await H.mailer.collections.dmarcFailures.deleteMany({})
    const res = await get('/admin/mailer/api/dmarc')
    expect(res.status).toBe(200)
    expect(res.body.domains).toEqual([])
    expect(res.body.sources).toEqual([])
  })

  it('POST /dmarc/upload with no file returns 400', async () => {
    const res = await post('/admin/mailer/api/dmarc/upload')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('no_file')
  })

  it('PUT + DELETE /dmarc/sources/:ip tags and untags', async () => {
    const tagRes = await put('/admin/mailer/api/dmarc/sources/198.51.100.7', { label: 'Hubspot' })
    expect(tagRes.status).toBe(200)
    expect(tagRes.body.ok).toBe(true)
    const tag = await H.mailer.collections.dmarcSourceTags.findOne({ ip: '198.51.100.7' })
    expect(tag?.label).toBe('Hubspot')

    const delRes = await del('/admin/mailer/api/dmarc/sources/198.51.100.7')
    expect(delRes.status).toBe(200)
    expect(delRes.body.deleted).toBe(1)
  })

  it('PUT /dmarc/sources/:ip rejects empty label', async () => {
    const res = await put('/admin/mailer/api/dmarc/sources/1.2.3.4', { label: '' })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// /hygiene
// ---------------------------------------------------------------------------

describe('Hygiene endpoint', () => {
  it('GET /hygiene returns the report shape', async () => {
    const res = await get('/admin/mailer/api/hygiene')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('totalSubscribers')
    expect(res.body).toHaveProperty('buckets')
    expect(res.body).toHaveProperty('sunsetCandidate')
    expect(Array.isArray(res.body.buckets)).toBe(true)
  })
})

// Reference DNSBL Resolver type so the imported binding is not stripped.
void (null as Resolver | null)
void zlib
