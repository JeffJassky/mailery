/**
 * DMARC Monitoring runner (plans/18-dmarc-monitoring.md §6.4–6.6): the
 * activation gate, scheduled DNS checks, the alert state machine, hook
 * delivery and audit. Contract tests: red until PR 2A lands.
 *
 * Every call passes `now` and a fake resolver — nothing here reads the clock
 * for a decision or touches real DNS.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { runTick } from '../../src/server/runner/index.js'
import {
  _resetDmarcMonitorThrottle,
  evaluateDmarcAlerts,
  runDmarcDnsChecks,
  runDmarcMonitor,
  sendTestDmarcAlert,
} from '../../src/server/runner/dmarc-monitor.js'
import { saveDmarcSettingsPatch } from '../../src/server/runner/dmarc-settings.js'
import { _clearPtrCache } from '../../src/server/runner/dmarc-dns.js'
import type { DmarcAlert, DmarcDnsResolver } from '../../src/shared/dmarc-types.js'
import type { DmarcAlertStateDoc } from '../../src/server/models/index.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = new Date('2026-10-09T12:00:00Z')
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR)
const dayStr = (daysAgo: number) => new Date(T0.getTime() - daysAgo * DAY).toISOString().slice(0, 10)

const ID_UNKNOWN = 'unknown_source_failing|example.com|'

function resolver(): DmarcDnsResolver & { calls: string[] } {
  const calls: string[] = []
  const txt: Record<string, string[][]> = {
    '_dmarc.example.com': [['v=DMARC1; p=none; rua=mailto:dmarc@example.com']],
    'example.com': [['v=spf1 include:sendgrid.net ~all']],
  }
  const nf = (h: string) => Promise.reject(Object.assign(new Error('ENOTFOUND ' + h), { code: 'ENOTFOUND' }))
  return {
    calls,
    resolveTxt: (h) => (calls.push(`txt:${h}`), txt[h] ? Promise.resolve(txt[h]!) : nf(h)),
    resolveMx: (h) => (calls.push(`mx:${h}`), h === 'example.com' ? Promise.resolve([{ exchange: 'mx.example.com', priority: 1 }]) : nf(h)),
    reverse: (ip) => (calls.push(`ptr:${ip}`), Promise.resolve([`host-${ip.replace(/\./g, '-')}.bad.example.`])),
  }
}

async function seedReport(H: TestMailerHarness, over: { reportId?: string; domain?: string; daysAgo?: number; pass?: number; fail?: number } = {}) {
  const end = new Date(T0.getTime() - (over.daysAgo ?? 1) * DAY)
  const pass = over.pass ?? 5000
  const fail = over.fail ?? 0
  await H.mailer.collections.dmarcReports.insertOne({
    reportId: over.reportId ?? `r-${Math.random().toString(36).slice(2)}`,
    orgName: 'google.com',
    email: 'noreply-dmarc-support@google.com',
    domain: over.domain ?? 'example.com',
    policyP: 'none',
    policyPct: 100,
    rangeStart: new Date(end.getTime() - DAY),
    rangeEnd: end,
    totalMessages: pass + fail,
    passCount: pass,
    failCount: fail,
    receivedAt: T0,
  })
}

async function seedFailure(H: TestMailerHarness, ip: string, count: number, daysAgo = 1) {
  await H.mailer.collections.dmarcFailures.insertOne({
    reportId: `f-${ip}-${daysAgo}`,
    domain: 'example.com',
    sourceIp: ip,
    count,
    headerFrom: 'example.com',
    dkimResult: 'fail',
    spfResult: 'fail',
    dispositionApplied: 'none',
    day: dayStr(daysAgo),
    receivedAt: T0,
  })
}

async function clearAll(H: TestMailerHarness) {
  const c = H.mailer.collections
  await Promise.all([
    c.dmarcReports.deleteMany({}),
    c.dmarcFailures.deleteMany({}),
    c.dmarcAlerts.deleteMany({}),
    c.dmarcDnsChecks.deleteMany({}),
    c.dmarcSettings.deleteMany({}),
    c.dmarcSourceTags.deleteMany({}),
    c.auditLog.deleteMany({}),
  ])
  _resetDmarcMonitorThrottle()
  _clearPtrCache()
}

// ---------------------------------------------------------------------------
// H1: a hook, no `dmarc` config block — activation depends on reports alone.
// ---------------------------------------------------------------------------

let H1: TestMailerHarness
const fired: DmarcAlert[] = []
let hookMode: 'ok' | 'throw' | 'reject' | 'slow' = 'ok'

beforeAll(async () => {
  H1 = await createTestMailer({
    config: {
      onDmarcAlert: async (a: DmarcAlert) => {
        if (hookMode === 'throw') throw new Error('slack is down')
        if (hookMode === 'reject') return Promise.reject(new Error('webhook 500'))
        if (hookMode === 'slow') await new Promise((r) => setTimeout(r, 50))
        fired.push(a)
      },
    },
  })
}, 120_000)

afterAll(async () => {
  if (H1) await H1.stop()
})

beforeEach(async () => {
  await clearAll(H1)
  fired.length = 0
  hookMode = 'ok'
})

const evalAt = (hours: number, r = resolver()) =>
  evaluateDmarcAlerts(H1.ctx, { now: at(hours), resolver: r, force: true })

describe('activation gate', () => {
  it('with no dmarc config and no reports, the monitor does nothing at all', async () => {
    const r = resolver()
    const out = await runDmarcMonitor(H1.ctx, { now: T0, resolver: r, force: true })
    expect(out).toEqual({ ran: false, reason: 'inactive' })
    expect(r.calls).toEqual([])
    expect(await H1.mailer.collections.dmarcDnsChecks.countDocuments()).toBe(0)
    expect(await H1.mailer.collections.dmarcAlerts.countDocuments()).toBe(0)
  })

  it('one ingested report activates it: DNS checks run and alerts evaluate', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    const r = resolver()
    const out = await runDmarcMonitor(H1.ctx, { now: T0, resolver: r, force: true })
    expect(out.ran).toBe(true)
    const dns = await H1.mailer.collections.dmarcDnsChecks.findOne({ _id: 'example.com' })
    expect(dns?.result.dmarc.policy).toBe('none')
    expect(fired.map((a) => a.id)).toEqual([ID_UNKNOWN])
  })
})

describe('alert lifecycle', () => {
  it('opens once, fills reverse DNS, records delivery and audits', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    const res = await evalAt(0)
    expect(res).toMatchObject({ ran: true, fired: 1, open: 1 })
    expect(fired).toHaveLength(1)
    const a = fired[0]!
    expect(a).toMatchObject({ id: ID_UNKNOWN, event: 'opened', domain: 'example.com', firstDetectedAt: T0, detectedAt: T0 })
    expect(a.sources[0]!.ptr).toBe('host-198-51-100-1.bad.example')
    expect(a.text).toContain('host-198-51-100-1.bad.example')

    const state = (await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!
    expect(state).toMatchObject({ status: 'open', fireCount: 1, subjectKeys: ['198.51.100.1'], firstDetectedAt: T0, lastFiredAt: T0 })
    expect(state.lastDelivery).toMatchObject({ outcome: 'delivered' })
    expect(state.lastAlert.id).toBe(ID_UNKNOWN)

    const audit = await H1.mailer.collections.auditLog.find({ action: 'dmarc.alert.opened' }).toArray()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor: 'system:dmarc-monitor', resource: { collection: 'mailer_dmarc_alerts', id: ID_UNKNOWN } })
  })

  it('an unchanged condition does not fire again', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    const res = await evalAt(1)
    expect(res.fired).toBe(0)
    expect(fired).toHaveLength(1)
    const state = (await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!
    expect(state.lastDetectedAt).toEqual(at(1))
    expect(state.lastFiredAt).toEqual(T0)
  })

  it('a new source turns it into an update naming the new IP', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    await seedFailure(H1, '198.51.100.2', 20)
    await evalAt(1)
    expect(fired.map((a) => a.event)).toEqual(['opened', 'updated'])
    expect(fired[1]!.newSourceIps).toEqual(['198.51.100.2'])
    expect(fired[1]!.firstDetectedAt).toEqual(T0)
    const state = (await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!
    expect(state.fireCount).toBe(2)
    expect([...state.subjectKeys].sort()).toEqual(['198.51.100.1', '198.51.100.2'])
  })

  it('a long-running alert fires a reminder after realertAfterHours', async () => {
    await saveDmarcSettingsPatch(H1.ctx, { alerts: { realertAfterHours: 2 } }, 'test')
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    await evalAt(1)
    await evalAt(3)
    expect(fired.map((a) => a.event)).toEqual(['opened', 'reminder'])
  })

  it('realertAfterHours 0 never reminds', async () => {
    await saveDmarcSettingsPatch(H1.ctx, { alerts: { realertAfterHours: 0 } }, 'test')
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    await evalAt(500)
    expect(fired.filter((a) => a.event === 'reminder')).toEqual([])
  })

  it('resolves when the condition clears, and re-opens fresh if it returns', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    await H1.mailer.collections.dmarcFailures.deleteMany({})
    await evalAt(1)
    expect(fired.map((a) => a.event)).toEqual(['opened', 'resolved'])
    expect(fired[1]!.title.startsWith('Resolved: ')).toBe(true)
    let state = (await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!
    expect(state).toMatchObject({ status: 'resolved', resolvedAt: at(1) })

    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(2)
    expect(fired.map((a) => a.event)).toEqual(['opened', 'resolved', 'opened'])
    state = (await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!
    expect(state).toMatchObject({ status: 'open', fireCount: 1, firstDetectedAt: at(2), resolvedAt: null })
  })

  it('policy_ready resolves silently', async () => {
    await seedReport(H1)
    await seedOpenState(H1, 'policy_ready|example.com|quarantine:10', 'policy_ready')
    await evalAt(0)
    expect(fired).toEqual([])
    const state = (await H1.mailer.collections.dmarcAlerts.findOne({ _id: 'policy_ready|example.com|quarantine:10' }))!
    expect(state.status).toBe('resolved')
  })

  it('an alert whose kind was switched off resolves silently', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    await saveDmarcSettingsPatch(H1.ctx, { alerts: { disabledKinds: ['unknown_source_failing'] } }, 'test')
    await evalAt(1)
    expect(fired.map((a) => a.event)).toEqual(['opened'])
    expect((await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!.status).toBe('resolved')
  })

  it('an alert for a domain that became ignored resolves silently', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    await saveDmarcSettingsPatch(H1.ctx, { ignoredDomains: ['example.com'] }, 'test')
    await evalAt(1)
    expect(fired.map((a) => a.event)).toEqual(['opened'])
    expect((await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!.status).toBe('resolved')
  })

  it('a rejecting async hook is recorded as failed', async () => {
    hookMode = 'reject'
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    const state = (await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!
    expect(state.lastDelivery).toMatchObject({ outcome: 'failed', error: 'webhook 500' })
  })

  it('an async hook is awaited before delivery is recorded', async () => {
    hookMode = 'slow'
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    expect(fired).toHaveLength(1)
    expect((await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!.lastDelivery).toMatchObject({ outcome: 'delivered' })
  })

  it('concurrent evaluators resolve, reopen and remind exactly once each', async () => {
    await saveDmarcSettingsPatch(H1.ctx, { alerts: { realertAfterHours: 2 } }, 'test')
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    await H1.mailer.collections.dmarcFailures.deleteMany({})
    await Promise.all([evalAt(1), evalAt(1), evalAt(1)])
    await seedFailure(H1, '198.51.100.1', 50)
    await Promise.all([evalAt(2), evalAt(2), evalAt(2)])
    await Promise.all([evalAt(5), evalAt(5), evalAt(5)])
    expect(fired.map((a) => a.event)).toEqual(['opened', 'resolved', 'opened', 'reminder'])
    expect((await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!.fireCount).toBe(2)
  })

  it('open test-kind rows are never resolved', async () => {
    await seedReport(H1)
    await seedOpenState(H1, 'test|example.com|x', 'test')
    await evalAt(0)
    expect((await H1.mailer.collections.dmarcAlerts.findOne({ _id: 'test|example.com|x' }))!.status).toBe('open')
  })

  it('the tick runs the monitor', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await runTick(H1.ctx)
    expect(fired.map((a) => a.id)).toContain(ID_UNKNOWN)
  })

  it('a throwing hook does not break the tick', async () => {
    hookMode = 'throw'
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await expect(runTick(H1.ctx)).resolves.not.toThrow()
    expect((await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!.lastDelivery).toMatchObject({ outcome: 'failed' })
  })

  it('a throwing hook is recorded and does not break the run', async () => {
    hookMode = 'throw'
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    const res = await evalAt(0)
    expect(res.ran).toBe(true)
    const state = (await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!
    expect(state.status).toBe('open')
    expect(state.lastDelivery).toMatchObject({ outcome: 'failed', error: 'slack is down' })
  })

  it('two instances evaluating at once fire exactly once', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await Promise.all([evalAt(0), evalAt(0), evalAt(0)])
    expect(fired.filter((a) => a.id === ID_UNKNOWN)).toHaveLength(1)
    const state = (await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!
    expect(state.fireCount).toBe(1)
  })

  it('two instances re-firing the same update fire it once', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    await seedFailure(H1, '198.51.100.2', 20)
    await Promise.all([evalAt(1), evalAt(1), evalAt(1)])
    expect(fired.map((a) => a.event)).toEqual(['opened', 'updated'])
  })
})

async function seedOpenState(H: TestMailerHarness, id: string, kind: DmarcAlertStateDoc['kind']) {
  const lastAlert = {
    id, kind, event: 'opened', severity: 'info', domain: 'example.com', title: 't', message: 'm', recommendation: '',
    text: 't', detectedAt: T0, firstDetectedAt: T0, window: { start: T0, end: T0 },
    summary: { domain: 'example.com', policy: 'none', pct: 100, windowDays: 7, reportCount: 0, totalMessages: 0, passCount: 0, failCount: 0, alignmentRate: null, lastReportAt: null },
    sources: [], newSourceIps: [], threshold: null, suggestedPolicy: null, dnsIssues: [], adminUrl: null,
  } as DmarcAlert
  await H.mailer.collections.dmarcAlerts.insertOne({
    _id: id, kind, domain: 'example.com', status: 'open', severity: 'info', title: 't', subjectKeys: [],
    firstDetectedAt: T0, lastDetectedAt: T0, lastFiredAt: T0, fireCount: 1, resolvedAt: null, lastAlert, lastDelivery: null,
  })
}

describe('switches and throttle', () => {
  it('alerts disabled → evaluation does not run and open alerts are left alone', async () => {
    await seedReport(H1)
    await seedFailure(H1, '198.51.100.1', 50)
    await evalAt(0)
    await saveDmarcSettingsPatch(H1.ctx, { alerts: { enabled: false } }, 'test')
    await H1.mailer.collections.dmarcFailures.deleteMany({})
    const res = await evalAt(1)
    expect(res).toMatchObject({ ran: false, reason: 'disabled', fired: 0 })
    expect((await H1.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!.status).toBe('open')
  })

  it('without force, evaluation runs at most once an hour per process', async () => {
    await seedReport(H1)
    const first = await evaluateDmarcAlerts(H1.ctx, { now: T0, resolver: resolver() })
    const second = await evaluateDmarcAlerts(H1.ctx, { now: T0, resolver: resolver() })
    expect(first.ran).toBe(true)
    expect(second).toMatchObject({ ran: false, reason: 'throttled' })
  })
})

describe('runDmarcDnsChecks', () => {
  it('checks each monitored domain and stores the result', async () => {
    await seedReport(H1)
    const results = await runDmarcDnsChecks(H1.ctx, { now: T0, resolver: resolver() })
    expect(results.map((r) => r.domain)).toEqual(['example.com'])
    const doc = (await H1.mailer.collections.dmarcDnsChecks.findOne({ _id: 'example.com' }))!
    expect(doc.checkedAt).toEqual(T0)
    expect(doc.result.ok).toBe(true)
  })

  it('skips a domain checked within dnsCheckIntervalHours (shared across instances via the DB)', async () => {
    await seedReport(H1)
    await runDmarcDnsChecks(H1.ctx, { now: T0, resolver: resolver() })
    const r = resolver()
    expect(await runDmarcDnsChecks(H1.ctx, { now: at(23), resolver: r })).toEqual([])
    expect(r.calls).toEqual([])
    expect(await runDmarcDnsChecks(H1.ctx, { now: at(25), resolver: resolver() })).toHaveLength(1)
    expect(await runDmarcDnsChecks(H1.ctx, { now: at(26), resolver: resolver(), force: true })).toHaveLength(1)
  })

  it('dnsCheckIntervalHours 0 disables scheduled checks but not forced ones', async () => {
    await seedReport(H1)
    await saveDmarcSettingsPatch(H1.ctx, { alerts: { dnsCheckIntervalHours: 0 } }, 'test')
    expect(await runDmarcDnsChecks(H1.ctx, { now: T0, resolver: resolver() })).toEqual([])
    expect(await runDmarcDnsChecks(H1.ctx, { now: T0, resolver: resolver(), force: true })).toHaveLength(1)
  })

  it('a single named domain is always checked', async () => {
    await seedReport(H1)
    await runDmarcDnsChecks(H1.ctx, { now: T0, resolver: resolver() })
    expect(await runDmarcDnsChecks(H1.ctx, { now: at(1), resolver: resolver(), domain: 'example.com' })).toHaveLength(1)
  })

  it('refuses a domain that is not monitored', async () => {
    await expect(runDmarcDnsChecks(H1.ctx, { now: T0, resolver: resolver(), domain: 'evil.example' })).rejects.toThrow(/not monitored/)
  })

  it('never checks ignored domains', async () => {
    await seedReport(H1)
    await saveDmarcSettingsPatch(H1.ctx, { ignoredDomains: ['example.com'] }, 'test')
    const r = resolver()
    expect(await runDmarcDnsChecks(H1.ctx, { now: T0, resolver: r, force: true })).toEqual([])
    expect(r.calls).toEqual([])
  })

  it('a DNS error alert opens from a stored check', async () => {
    await seedReport(H1)
    const broken: DmarcDnsResolver = { ...resolver(), resolveTxt: (h) => Promise.reject(Object.assign(new Error(h), { code: 'ENOTFOUND' })) }
    await runDmarcDnsChecks(H1.ctx, { now: T0, resolver: broken, force: true })
    await evalAt(0)
    expect(fired.map((a) => a.id)).toContain('dns_misconfigured|example.com|')
  })
})

describe('sendTestDmarcAlert', () => {
  it('delivers a test alert through the hook without creating state', async () => {
    const { delivery, alert } = await sendTestDmarcAlert(H1.ctx, { now: T0 })
    expect(delivery.outcome).toBe('delivered')
    expect(alert.kind).toBe('test')
    expect(fired.map((a) => a.kind)).toEqual(['test'])
    expect(await H1.mailer.collections.dmarcAlerts.countDocuments()).toBe(0)
    expect(await H1.mailer.collections.auditLog.countDocuments({ action: 'dmarc.alert.test' })).toBe(1)
  })

  it('reports a failing hook', async () => {
    hookMode = 'throw'
    const { delivery } = await sendTestDmarcAlert(H1.ctx, { now: T0 })
    expect(delivery).toMatchObject({ outcome: 'failed', error: 'slack is down' })
  })
})

// ---------------------------------------------------------------------------
// H2: a `dmarc` config block, no hook.
// ---------------------------------------------------------------------------

describe('with a dmarc config block and no hook', () => {
  let H2: TestMailerHarness

  beforeAll(async () => {
    H2 = await createTestMailer({
      config: {
        senderDomains: { 'news.example.com': { kind: 'marketing' } },
        dmarc: { adminUrl: 'https://app.example.com/admin/mailer/', alerts: { unknownSourceMinMessages: 1 } },
      },
    })
  }, 120_000)

  afterAll(async () => {
    if (H2) await H2.stop()
  })

  beforeEach(async () => {
    await clearAll(H2)
  })

  it('config alone activates the monitor', async () => {
    const out = await runDmarcMonitor(H2.ctx, { now: T0, resolver: resolver(), force: true })
    expect(out.ran).toBe(true)
    expect(await H2.mailer.collections.dmarcDnsChecks.countDocuments()).toBeGreaterThan(0)
  })

  it('a subdomain that inherits a monitored org domain policy reports only that', async () => {
    await runDmarcDnsChecks(H2.ctx, { now: T0, resolver: resolver(), force: true })
    const sub = (await H2.mailer.collections.dmarcDnsChecks.findOne({ _id: 'news.example.com' }))!
    expect(sub.result.issues.map((i) => i.code)).toEqual(['inherits_org_policy'])
  })

  it('records no_handler and carries the config adminUrl and thresholds', async () => {
    await seedReport(H2)
    await seedFailure(H2, '198.51.100.9', 1)
    await evaluateDmarcAlerts(H2.ctx, { now: T0, resolver: resolver(), force: true })
    const state = (await H2.mailer.collections.dmarcAlerts.findOne({ _id: ID_UNKNOWN }))!
    expect(state.lastDelivery).toMatchObject({ outcome: 'no_handler' })
    expect(state.lastAlert.adminUrl).toBe('https://app.example.com/admin/mailer/')
    expect(state.lastAlert.text.endsWith('https://app.example.com/admin/mailer/')).toBe(true)
    const t = await sendTestDmarcAlert(H2.ctx, { now: T0 })
    expect(t.delivery.outcome).toBe('no_handler')
  })
})
