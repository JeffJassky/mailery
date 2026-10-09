/**
 * DMARC Monitoring admin API (plans/18-dmarc-monitoring.md §5.6), ingest
 * provenance (`via`), the inbound-state handshake and the setup-status check.
 * Contract tests: red until PRs 1C and 2B land.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAdminRouter } from '../../src/server/api/admin.js'
import { createPublicRouter } from '../../src/server/api/public.js'
import { runSetupChecks } from '../../src/server/api/setup-status.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { DMARC_SETTINGS_DEFAULTS } from '../../src/server/runner/dmarc-settings.js'
import { _resetDmarcMonitorThrottle } from '../../src/server/runner/dmarc-monitor.js'
import { _clearPtrCache } from '../../src/server/runner/dmarc-dns.js'
import type { DmarcAlert, DmarcDnsResolver } from '../../src/shared/dmarc-types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORT_XML = readFileSync(path.join(__dirname, '..', 'fixtures', 'dmarc', 'google-clean.xml'), 'utf8')
const SECRET = 'inbound-secret-do-not-leak'

const fired: DmarcAlert[] = []
const dnsCalls: string[] = []
const resolver: DmarcDnsResolver = {
  resolveTxt: (h) => {
    dnsCalls.push(`txt:${h}`)
    const t: Record<string, string[][]> = {
      '_dmarc.example.com': [['v=DMARC1; p=none; rua=mailto:dmarc@example.com']],
      'example.com': [['v=spf1 -all']],
    }
    return t[h] ? Promise.resolve(t[h]!) : Promise.reject(Object.assign(new Error(h), { code: 'ENOTFOUND' }))
  },
  resolveMx: (h) => (dnsCalls.push(`mx:${h}`), Promise.resolve([{ exchange: `mx.${h}`, priority: 1 }])),
  reverse: (ip) => (dnsCalls.push(`ptr:${ip}`), Promise.resolve([`ptr-${ip}.example.net.`])),
}

let H: TestMailerHarness
let admin: string
let pub: string | null = null
const servers: Array<ReturnType<express.Express['listen']>> = []

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      dmarc: { reportAddress: 'reports@in.example.com' },
      onDmarcAlert: (a: DmarcAlert) => {
        fired.push(a)
      },
    },
  })
  const app = express()
  app.use(express.json())
  app.use('/admin/mailer', createAdminRouter(H.mailer, { getActor: () => 'human:ops@example.com', dmarcDnsResolver: resolver }))
  const server = app.listen(0)
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))
  admin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/mailer/api`
}, 120_000)

afterAll(async () => {
  for (const s of servers) s.close()
  if (H) await H.stop()
})

beforeEach(async () => {
  const c = H.mailer.collections
  await Promise.all([
    c.dmarcReports.deleteMany({}),
    c.dmarcFailures.deleteMany({}),
    c.dmarcAlerts.deleteMany({}),
    c.dmarcDnsChecks.deleteMany({}),
    c.dmarcSettings.deleteMany({}),
    c.auditLog.deleteMany({}),
  ])
  fired.length = 0
  dnsCalls.length = 0
  _resetDmarcMonitorThrottle()
  _clearPtrCache()
})

function call(
  base: string,
  method: string,
  p: string,
  body?: Buffer | unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    const req = request(
      `${base}${p}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'content-length': String(data.length), ...headers },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => {
          raw += c
        })
        res.on('end', () => {
          let parsed: unknown = raw
          try {
            parsed = raw ? JSON.parse(raw) : null
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw })
        })
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

const api = (method: string, p: string, body?: unknown) => call(admin, method, p, body)

function multipartFile(field: string, filename: string, content: Buffer) {
  const boundary = '----dmarcTest' + Math.random().toString(36).slice(2)
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

async function mountInbound(): Promise<string> {
  if (pub) return pub
  const app = express()
  app.use('/m', createPublicRouter(H.mailer, { logger: {}, dmarcInbound: { secret: SECRET } }))
  const server = app.listen(0)
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))
  pub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return pub
}

describe('GET /dmarc/monitoring', () => {
  it('describes an instance with nothing set up yet', async () => {
    const r = await api('GET', '/dmarc/monitoring')
    expect(r.status).toBe(200)
    expect(r.body.settings).toEqual({ ...DMARC_SETTINGS_DEFAULTS, reportAddress: 'reports@in.example.com' })
    expect(r.body.defaults).toEqual(DMARC_SETTINGS_DEFAULTS)
    expect(r.body.hasDbOverride).toBe(false)
    expect(r.body.alertHandlerConfigured).toBe(true)
    expect(r.body.alerts).toEqual({ open: [], recent: [] })
    expect(r.body.domains).toEqual([
      { domain: 'example.com', origin: ['config'], ignored: false, lastReportAt: null, reportCount30d: 0, dns: null },
    ])
  })

  it('reports the inbound route once mounted, without ever exposing the secret', async () => {
    const before = await api('GET', '/dmarc/monitoring')
    if (!pub) {
      expect(before.body.inbound).toEqual({ mounted: false, path: null, url: null, allowedDomains: [], lastInboundReportAt: null })
    }
    await mountInbound()
    const r = await api('GET', '/dmarc/monitoring')
    expect(r.body.inbound).toMatchObject({
      mounted: true,
      path: '/inbound/dmarc',
      url: 'http://localhost:3000/m/inbound/dmarc',
      lastInboundReportAt: null,
    })
    expect(r.body.inbound.allowedDomains).toContain('example.com')
    expect(r.raw).not.toContain(SECRET)
  })

  it('maps alert rows to views with an id', async () => {
    await H.mailer.collections.dmarcReports.insertOne({
      reportId: 'x', orgName: 'google.com', email: '', domain: 'example.com', policyP: 'none', policyPct: 100,
      rangeStart: new Date(Date.now() - 2 * 86_400_000), rangeEnd: new Date(Date.now() - 86_400_000),
      totalMessages: 100, passCount: 100, failCount: 0, receivedAt: new Date(),
    })
    await H.mailer.collections.dmarcFailures.insertOne({
      reportId: 'x', domain: 'example.com', sourceIp: '198.51.100.1', count: 500, headerFrom: 'example.com',
      dkimResult: 'fail', spfResult: 'fail', dispositionApplied: 'none',
      day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), receivedAt: new Date(),
    })
    const ev = await api('POST', '/dmarc/alerts/evaluate')
    expect(ev.status).toBe(200)
    expect(ev.body).toMatchObject({ ran: true, open: 1 })
    expect(fired.map((a) => a.kind)).toEqual(['unknown_source_failing'])
    expect(fired[0]!.sources[0]!.ptr).toBe('ptr-198.51.100.1.example.net')

    const r = await api('GET', '/dmarc/monitoring')
    expect(r.body.alerts.open).toHaveLength(1)
    expect(r.body.alerts.open[0]).toMatchObject({
      id: 'unknown_source_failing|example.com|',
      kind: 'unknown_source_failing',
      status: 'open',
      lastDelivery: { outcome: 'delivered' },
    })
    expect(r.body.alerts.open[0]._id).toBeUndefined()
    expect(r.body.domains[0]).toMatchObject({ domain: 'example.com', origin: ['config', 'reports'], reportCount30d: 1 })
    expect(typeof r.body.domains[0].lastReportAt).toBe('string')
  })
})

describe('report provenance', () => {
  it('the inbound webhook tags reports via=inbound and updates lastInboundReportAt', async () => {
    const base = await mountInbound()
    const { body, contentType } = multipartFile('attachment1', 'google.xml.gz', zlib.gzipSync(Buffer.from(REPORT_XML)))
    const res = await call(base, 'POST', '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: 'Basic ' + Buffer.from(`mailery:${SECRET}`).toString('base64'),
    })
    expect(res.status).toBe(200)
    const doc = await H.mailer.collections.dmarcReports.findOne({})
    expect(doc?.via).toBe('inbound')
    const r = await api('GET', '/dmarc/monitoring')
    expect(typeof r.body.inbound.lastInboundReportAt).toBe('string')
  })

  it('the admin upload tags reports via=upload', async () => {
    const { body, contentType } = multipartFile('file', 'report.xml', Buffer.from(REPORT_XML))
    const res = await call(admin, 'POST', '/dmarc/upload', body, { 'content-type': contentType })
    expect(res.status).toBe(200)
    expect((await H.mailer.collections.dmarcReports.findOne({}))?.via).toBe('upload')
  })
})

describe('settings', () => {
  it('PUT saves a patch layered over config, and audits the changed keys', async () => {
    const r = await api('PUT', '/dmarc/settings', { alerts: { windowDays: 14 }, extraDomains: ['Side.IO'] })
    expect(r.status).toBe(200)
    expect(r.body.settings.alerts.windowDays).toBe(14)
    expect(r.body.settings.extraDomains).toEqual(['side.io'])
    expect(r.body.settings.reportAddress).toBe('reports@in.example.com')

    const m = await api('GET', '/dmarc/monitoring')
    expect(m.body.hasDbOverride).toBe(true)
    expect(m.body.domains.map((d: any) => d.domain)).toEqual(['example.com', 'side.io'])

    const audit = await H.mailer.collections.auditLog.find({ action: 'dmarc.settings.update' }).toArray()
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actor).toBe('human:ops@example.com')
    expect(audit[0]!.diffSummary).toContain('alerts.windowDays')
    expect(audit[0]!.diffSummary).toContain('extraDomains')
  })

  it('successive PUTs merge rather than replace', async () => {
    await api('PUT', '/dmarc/settings', { alerts: { windowDays: 14 } })
    const r = await api('PUT', '/dmarc/settings', { alerts: { reportsStoppedDays: 3 } })
    expect(r.body.settings.alerts).toMatchObject({ windowDays: 14, reportsStoppedDays: 3 })
  })

  it('PUT rejects an invalid patch and saves nothing', async () => {
    const r = await api('PUT', '/dmarc/settings', { alerts: { windowDays: 0 } })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('validation_failed')
    expect(r.body.message).toMatch(/windowDays/)
    expect(await H.mailer.collections.dmarcSettings.countDocuments()).toBe(0)
  })

  it('DELETE resets to config + defaults and audits', async () => {
    await api('PUT', '/dmarc/settings', { alerts: { windowDays: 14 } })
    const r = await api('DELETE', '/dmarc/settings')
    expect(r.status).toBe(200)
    expect(r.body.settings.alerts.windowDays).toBe(7)
    expect((await api('GET', '/dmarc/monitoring')).body.hasDbOverride).toBe(false)
    expect(await H.mailer.collections.auditLog.countDocuments({ action: 'dmarc.settings.reset' })).toBe(1)
  })
})

describe('DNS checks', () => {
  it('POST /dmarc/dns/check checks every monitored domain with the injected resolver', async () => {
    const r = await api('POST', '/dmarc/dns/check', {})
    expect(r.status).toBe(200)
    expect(r.body.results.map((x: any) => x.domain)).toEqual(['example.com'])
    expect(dnsCalls).toContain('txt:_dmarc.example.com')
    const m = await api('GET', '/dmarc/monitoring')
    expect(m.body.domains[0].dns.domain).toBe('example.com')
    expect(m.body.domains[0].dns.issues.map((i: any) => i.code)).toContain('rua_missing_report_address')
  })

  it('a named domain must be monitored', async () => {
    const r = await api('POST', '/dmarc/dns/check', { domain: 'evil.example' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('validation_failed')
  })

  it('setup status warns about stored DNS problems', async () => {
    await H.mailer.collections.dmarcDnsChecks.insertOne({
      _id: 'broken.example',
      checkedAt: new Date(),
      result: {
        domain: 'broken.example', checkedAt: new Date(), inheritedFrom: null,
        dmarc: { host: '_dmarc.broken.example', found: false, raw: [], policy: null, subdomainPolicy: null, pct: null, rua: [], ruf: [], adkim: null, aspf: null },
        externalAuth: [], ruaMx: [], spf: { found: false, raw: [], all: null },
        issues: [{ code: 'dmarc_missing', severity: 'error', message: 'No DMARC record.', fix: null }],
        ok: false,
      },
    })
    const status = await runSetupChecks(H.mailer)
    const check = status.checks.find((c) => c.name === 'dmarc')!
    expect(check.severity).toBe('warn')
    expect(check.message).toContain('broken.example')
  })
})

describe('alerts', () => {
  it('POST /dmarc/alerts/test delivers through the hook', async () => {
    const r = await api('POST', '/dmarc/alerts/test')
    expect(r.status).toBe(200)
    expect(r.body.delivery.outcome).toBe('delivered')
    expect(r.body.alert.kind).toBe('test')
    expect(fired.map((a) => a.kind)).toEqual(['test'])
  })
})

describe('GET /dmarc', () => {
  it('adds reverse DNS to each failing source', async () => {
    await H.mailer.collections.dmarcFailures.insertOne({
      reportId: 'p1', domain: 'example.com', sourceIp: '203.0.113.50', count: 3, headerFrom: 'example.com',
      dkimResult: 'fail', spfResult: 'fail', dispositionApplied: 'none',
      day: new Date().toISOString().slice(0, 10), receivedAt: new Date(),
    })
    const r = await api('GET', '/dmarc')
    expect(r.status).toBe(200)
    expect(r.body.sources[0]).toMatchObject({ sourceIp: '203.0.113.50', ptr: 'ptr-203.0.113.50.example.net' })
  })
})
