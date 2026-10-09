/**
 * DMARC alert rules, text and builders (plans/18-dmarc-monitoring.md §6).
 * Pure functions, no Mongo. Contract tests: red until PR 1B lands.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  buildResolvedAlert,
  buildTestDmarcAlert,
  computeDmarcAlertCandidates,
  dmarcAlertId,
  finalizeDmarcAlert,
  formatDmarcAlertText,
  type DmarcAlertInput,
} from '../../src/server/runner/dmarc-alerts.js'
import { DMARC_SETTINGS_DEFAULTS } from '../../src/server/runner/dmarc-settings.js'
import type { ResolvedSourceTag } from '../../src/server/runner/dmarc.js'
import type { DmarcAlertStateDoc, DmarcFailureDoc } from '../../src/server/models/index.js'
import type {
  DmarcAlert,
  DmarcAlertCandidate,
  DmarcDnsCheckResult,
  DmarcMonitoringSettings,
} from '../../src/shared/dmarc-types.js'

const DAY = 86_400_000
const NOW = new Date('2026-10-09T12:00:00Z')
const D = 'example.com'

// The rules must take time only from `input.now`. Pinning the system clock far
// away makes any stray Date.now() (e.g. in suggestPolicyProgression) fail here.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2031-06-01T00:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
})

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY)
}
function dayStr(n: number): string {
  return daysAgo(n).toISOString().slice(0, 10)
}

let seq = 0
function report(
  over: Partial<DmarcAlertInput['reports'][number]> & { ago?: number } = {},
): DmarcAlertInput['reports'][number] {
  const end = daysAgo(over.ago ?? 1)
  const pass = over.passCount ?? 100
  const fail = over.failCount ?? 0
  return {
    reportId: over.reportId ?? `r${++seq}`,
    orgName: over.orgName ?? 'google.com',
    domain: over.domain ?? D,
    policyP: over.policyP ?? 'none',
    policyPct: over.policyPct ?? 100,
    rangeStart: new Date(end.getTime() - DAY),
    rangeEnd: end,
    totalMessages: pass + fail,
    passCount: pass,
    failCount: fail,
  }
}

function failure(ip: string, count: number, over: Partial<DmarcFailureDoc> & { ago?: number } = {}): DmarcFailureDoc {
  return {
    reportId: over.reportId ?? 'r-fail',
    domain: over.domain ?? D,
    sourceIp: ip,
    count,
    headerFrom: over.headerFrom ?? D,
    dkimResult: over.dkimResult ?? 'fail',
    spfResult: over.spfResult ?? 'fail',
    dispositionApplied: over.dispositionApplied ?? 'none',
    day: over.day ?? dayStr(over.ago ?? 1),
    receivedAt: over.receivedAt ?? NOW,
  }
}

function tag(ip: string, label: string, ignored = false): [string, ResolvedSourceTag] {
  return [ip, { ip, label, ignored, source: 'db' }]
}

function settings(alerts: Partial<DmarcMonitoringSettings['alerts']> = {}, rest: Partial<DmarcMonitoringSettings> = {}) {
  const s = structuredClone(DMARC_SETTINGS_DEFAULTS)
  Object.assign(s.alerts, alerts)
  return { ...s, ...rest }
}

function latestOf(reports: DmarcAlertInput['reports']): DmarcAlertInput['latestReports'] {
  const m: DmarcAlertInput['latestReports'] = new Map()
  for (const r of reports) {
    const cur = m.get(r.domain)
    if (!cur || r.rangeEnd > cur.rangeEnd) m.set(r.domain, { rangeEnd: r.rangeEnd, policyP: r.policyP, policyPct: r.policyPct })
  }
  return m
}

function input(over: Partial<DmarcAlertInput> = {}): DmarcAlertInput {
  const reports = over.reports ?? [report({ reportId: 'r-fail', passCount: 5000, failCount: 0 })]
  return {
    now: NOW,
    settings: settings(),
    monitoredDomains: [D],
    reports,
    latestReports: latestOf(reports),
    failures: [],
    tags: new Map(),
    dnsChecks: new Map(),
    ...over,
  }
}

function only(cands: DmarcAlertCandidate[], kind: DmarcAlertCandidate['kind']) {
  return cands.filter((c) => c.kind === kind)
}

describe('dmarcAlertId', () => {
  it('is kind|domain|subject', () => {
    expect(dmarcAlertId('policy_ready', D, 'quarantine:10')).toBe('policy_ready|example.com|quarantine:10')
    expect(dmarcAlertId('alignment_drop', D, '')).toBe('alignment_drop|example.com|')
  })
})

describe('unknown_source_failing', () => {
  it('fires for IPs at the threshold, ignores IPs below it', () => {
    const c = only(
      computeDmarcAlertCandidates(input({ failures: [failure('198.51.100.1', 10), failure('198.51.100.2', 9)] })),
      'unknown_source_failing',
    )
    expect(c).toHaveLength(1)
    expect(c[0]!.id).toBe('unknown_source_failing|example.com|')
    expect(c[0]!.subjectKeys).toEqual(['198.51.100.1'])
    expect(c[0]!.sources.map((s) => s.ip)).toEqual(['198.51.100.1'])
    expect(c[0]!.severity).toBe('warning')
    expect(c[0]!.threshold).toEqual({ name: 'unknownSourceMinMessages', limit: 10, actual: 10 })
    expect(c[0]!.title).toBe('1 unknown sender(s) failing DMARC for example.com')
    expect(c[0]!.message).toBe(
      '10 message(s) claiming to be from example.com failed DMARC in the last 7 days, sent from 1 IP address(es) you have not identified. This is either a tool you forgot to set up (SPF/DKIM) or someone spoofing your domain. Your policy is p=none, so receivers delivered these messages anyway.',
    )
    expect(c[0]!.recommendation).toMatch(/reverse DNS/)
  })

  it('does not fire below the threshold', () => {
    expect(only(computeDmarcAlertCandidates(input({ failures: [failure('198.51.100.2', 9)] })), 'unknown_source_failing')).toEqual([])
  })

  it('sums an IP across days and reports', () => {
    const c = only(
      computeDmarcAlertCandidates(
        input({ failures: [failure('198.51.100.1', 6, { ago: 1 }), failure('198.51.100.1', 4, { ago: 3, reportId: 'r2' })] }),
      ),
      'unknown_source_failing',
    )[0]!
    expect(c.sources[0]).toMatchObject({ messages: 10, daysSeen: 2, firstSeenDay: dayStr(3), lastSeenDay: dayStr(1) })
  })

  it('uses the report day, not when the row was received (a backlog upload does not alert)', () => {
    const c = computeDmarcAlertCandidates(input({ failures: [failure('198.51.100.1', 500, { ago: 20, receivedAt: NOW })] }))
    expect(only(c, 'unknown_source_failing')).toEqual([])
  })

  it('omits the p=none note when the policy is enforcing', () => {
    const c = only(
      computeDmarcAlertCandidates(
        input({
          reports: [report({ reportId: 'r-fail', passCount: 5000, policyP: 'reject' })],
          failures: [failure('198.51.100.1', 10)],
        }),
      ),
      'unknown_source_failing',
    )[0]!
    expect(c.message).not.toMatch(/p=none/)
    expect(c.summary.policy).toBe('reject')
  })

  it('is critical when any IP sends ten times the threshold', () => {
    const c = only(computeDmarcAlertCandidates(input({ failures: [failure('198.51.100.1', 100)] })), 'unknown_source_failing')[0]!
    expect(c.severity).toBe('critical')
  })

  it('tagged IPs are not unknown', () => {
    const c = computeDmarcAlertCandidates(
      input({
        failures: [failure('149.72.1.1', 50), failure('203.0.113.9', 50)],
        tags: new Map([tag('149.72.1.1', 'SendGrid'), tag('203.0.113.9', 'Forwarder', true)]),
      }),
    )
    expect(only(c, 'unknown_source_failing')).toEqual([])
  })

  it('caps subject keys at 500, highest volume first', () => {
    const failures = Array.from({ length: 600 }, (_, i) => failure(`10.${Math.floor(i / 250)}.${i % 250}.1`, 10 + i))
    const c = only(computeDmarcAlertCandidates(input({ failures })), 'unknown_source_failing')[0]!
    expect(c.subjectKeys).toHaveLength(500)
    expect(c.subjectKeys).toContain(failures[599]!.sourceIp)
    expect(c.subjectKeys).not.toContain(failures[0]!.sourceIp)
  })

  it('caps sources at 25 by volume but keeps every IP as a subject key', () => {
    const failures = Array.from({ length: 30 }, (_, i) => failure(`198.51.100.${i + 1}`, 10 + i))
    const c = only(computeDmarcAlertCandidates(input({ failures })), 'unknown_source_failing')[0]!
    expect(c.sources).toHaveLength(25)
    expect(c.subjectKeys).toHaveLength(30)
    expect(c.sources[0]!.messages).toBe(39)
    expect(c.sources.map((s) => s.messages)).toEqual([...c.sources.map((s) => s.messages)].sort((a, b) => b - a))
  })

  it('fills each source from its rows and the reports that carried them', () => {
    const c = only(
      computeDmarcAlertCandidates(
        input({
          reports: [
            report({ reportId: 'g1', orgName: 'google.com', passCount: 5000 }),
            report({ reportId: 'y1', orgName: 'Yahoo', passCount: 10 }),
          ],
          failures: [
            failure('198.51.100.1', 7, { reportId: 'g1', ago: 2, headerFrom: 'example.com', dkimResult: 'fail', spfResult: 'pass' }),
            failure('198.51.100.1', 5, { reportId: 'y1', ago: 1, headerFrom: 'Example.com', dkimResult: 'none', spfResult: 'softfail', dispositionApplied: 'quarantine' }),
          ],
        }),
      ),
      'unknown_source_failing',
    )[0]!
    expect(c.sources[0]).toEqual({
      ip: '198.51.100.1',
      ptr: null,
      label: null,
      messages: 12,
      daysSeen: 2,
      firstSeenDay: dayStr(2),
      lastSeenDay: dayStr(1),
      headerFrom: ['example.com'],
      dkimResult: 'none',
      spfResult: 'softfail',
      disposition: 'quarantine',
      reporters: ['Yahoo', 'google.com'],
    })
  })
})

describe('known_source_failing', () => {
  it('fires at its own threshold, critical, titled by label', () => {
    const c = only(
      computeDmarcAlertCandidates(
        input({
          failures: [failure('149.72.1.1', 5), failure('149.72.1.2', 4)],
          tags: new Map([tag('149.72.1.1', 'SendGrid'), tag('149.72.1.2', 'SendGrid 2')]),
        }),
      ),
      'known_source_failing',
    )
    expect(c).toHaveLength(1)
    expect(c[0]!.severity).toBe('critical')
    expect(c[0]!.subjectKeys).toEqual(['149.72.1.1'])
    expect(c[0]!.title).toBe('SendGrid failing DMARC for example.com')
    expect(c[0]!.sources[0]!.label).toBe('SendGrid')
    expect(c[0]!.threshold).toEqual({ name: 'knownSourceMinMessages', limit: 5, actual: 5 })
  })

  it('lists at most three labels, by volume, then a count', () => {
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5']
    const c = only(
      computeDmarcAlertCandidates(
        input({
          failures: ips.map((ip, i) => failure(ip, 10 + i)),
          tags: new Map(ips.map((ip, i) => tag(ip, `L${i + 1}`))),
        }),
      ),
      'known_source_failing',
    )[0]!
    expect(c.title).toBe('L5, L4, L3 +2 more failing DMARC for example.com')
  })

  it('ignored tags never alert', () => {
    const c = computeDmarcAlertCandidates(
      input({ failures: [failure('203.0.113.9', 500)], tags: new Map([tag('203.0.113.9', 'Forwarder', true)]) }),
    )
    expect(only(c, 'known_source_failing')).toEqual([])
  })
})

describe('alignment_drop', () => {
  const r = (pass: number, fail: number) => [report({ reportId: 'r-fail', passCount: pass, failCount: fail })]

  it('fires below the rate once there are enough messages', () => {
    const c = only(computeDmarcAlertCandidates(input({ reports: r(970, 30) })), 'alignment_drop')
    expect(c).toHaveLength(1)
    expect(c[0]!.id).toBe('alignment_drop|example.com|')
    expect(c[0]!.severity).toBe('warning')
    expect(c[0]!.subjectKeys).toEqual([])
    expect(c[0]!.title).toBe('DMARC pass rate for example.com dropped to 97.0%')
    expect(c[0]!.message).toBe('970 of 1,000 messages passed DMARC in the last 7 days (97.0%), below your 98.0% threshold.')
    expect(c[0]!.threshold).toEqual({ name: 'alignmentMinRate', limit: 0.98, actual: 0.97 })
  })

  it('does not fire at exactly the rate', () => {
    expect(only(computeDmarcAlertCandidates(input({ reports: r(980, 20) })), 'alignment_drop')).toEqual([])
  })

  it('does not fire on too little mail', () => {
    expect(only(computeDmarcAlertCandidates(input({ reports: r(50, 49) })), 'alignment_drop')).toEqual([])
  })

  it('is critical below 90%', () => {
    expect(only(computeDmarcAlertCandidates(input({ reports: r(800, 200) })), 'alignment_drop')[0]!.severity).toBe('critical')
  })

  it('the message counts pass + adjusted fail; the summary stays raw', () => {
    const c = only(
      computeDmarcAlertCandidates(
        input({
          reports: r(900, 100),
          failures: [failure('203.0.113.9', 25)],
          tags: new Map([tag('203.0.113.9', 'Forwarder', true)]),
        }),
      ),
      'alignment_drop',
    )[0]!
    expect(c.message).toBe('900 of 975 messages passed DMARC in the last 7 days (92.3%), below your 98.0% threshold.')
    expect(c.summary.totalMessages).toBe(1000)
    expect(c.summary.alignmentRate).toBe(0.9)
    expect(c.sources).toEqual([])
  })

  it('discounts failures from ignored sources', () => {
    const c = computeDmarcAlertCandidates(
      input({
        reports: r(970, 30),
        failures: [failure('203.0.113.9', 25)],
        tags: new Map([tag('203.0.113.9', 'Forwarder', true)]),
      }),
    )
    expect(only(c, 'alignment_drop')).toEqual([])
  })

  it('only counts reports inside the window', () => {
    const c = computeDmarcAlertCandidates(
      input({ reports: [report({ ago: 10, passCount: 0, failCount: 5000 }), report({ ago: 1, passCount: 1000 })] }),
    )
    expect(only(c, 'alignment_drop')).toEqual([])
  })
})

describe('reports_stopped', () => {
  it('fires when the newest report is older than reportsStoppedDays', () => {
    const c = only(computeDmarcAlertCandidates(input({ reports: [report({ ago: 10 })] })), 'reports_stopped')
    expect(c).toHaveLength(1)
    expect(c[0]!.severity).toBe('warning')
    expect(c[0]!.title).toBe('No DMARC reports for example.com in 7 days')
    expect(c[0]!.message).toContain(dayStr(10))
  })

  it('does not fire while reports are recent', () => {
    expect(only(computeDmarcAlertCandidates(input({ reports: [report({ ago: 6 })] })), 'reports_stopped')).toEqual([])
  })

  it('uses every input report, not only the window', () => {
    const c = computeDmarcAlertCandidates(input({ reports: [report({ ago: 5 })], settings: settings({ windowDays: 3 }) }))
    expect(only(c, 'reports_stopped')).toEqual([])
  })

  it('keeps firing long after the last report left the 35-day load', () => {
    const latest = daysAgo(60)
    const c = only(
      computeDmarcAlertCandidates(
        input({ reports: [], latestReports: new Map([[D, { rangeEnd: latest, policyP: 'quarantine', policyPct: 100 }]]) }),
      ),
      'reports_stopped',
    )
    expect(c).toHaveLength(1)
    expect(c[0]!.message).toContain(dayStr(60))
    expect(c[0]!.summary).toMatchObject({ lastReportAt: latest, policy: 'quarantine', pct: 100, reportCount: 0 })
  })

  it('does not fire for a domain that never had reports', () => {
    expect(only(computeDmarcAlertCandidates(input({ reports: [] })), 'reports_stopped')).toEqual([])
  })
})

describe('policy_ready', () => {
  const thirty = () => Array.from({ length: 30 }, (_, i) => report({ ago: i % 25, passCount: 100, failCount: 0 }))

  it('suggests the next policy step as an info alert keyed by the step', () => {
    const c = only(computeDmarcAlertCandidates(input({ reports: thirty() })), 'policy_ready')
    expect(c).toHaveLength(1)
    expect(c[0]!.id).toBe('policy_ready|example.com|quarantine:10')
    expect(c[0]!.severity).toBe('info')
    expect(c[0]!.suggestedPolicy).toMatchObject({ policy: 'quarantine', pct: 10 })
    expect(c[0]!.title).toBe('example.com is ready for p=quarantine pct=10')
    expect(c[0]!.recommendation).toBe(
      'Publish: npx mailery setup-dmarc --domain example.com --rua-mailbox <your rua mailbox> --policy quarantine --pct 10',
    )
  })

  it('puts the report address into the command when one is set', () => {
    const c = only(
      computeDmarcAlertCandidates(input({ reports: thirty(), settings: settings({}, { reportAddress: 'r@in.example.com' }) })),
      'policy_ready',
    )[0]!
    expect(c.recommendation).toContain('--rua-mailbox r@in.example.com')
  })

  it('stays quiet while an unidentified source is failing', () => {
    const c = computeDmarcAlertCandidates(input({ reports: thirty(), failures: [failure('198.51.100.1', 1)] }))
    expect(only(c, 'policy_ready')).toEqual([])
  })
})

describe('dns_misconfigured', () => {
  function dns(issues: DmarcDnsCheckResult['issues']): Map<string, DmarcDnsCheckResult> {
    return new Map([
      [
        D,
        {
          domain: D,
          checkedAt: NOW,
          inheritedFrom: null,
          dmarc: { host: `_dmarc.${D}`, found: false, raw: [], policy: null, subdomainPolicy: null, pct: null, rua: [], ruf: [], adkim: null, aspf: null },
          externalAuth: [],
          ruaMx: [],
          spf: { found: false, raw: [], all: null },
          issues,
          ok: !issues.some((i) => i.severity === 'error'),
        },
      ],
    ])
  }

  it('fires on error issues only, carrying them, critical when the record is missing', () => {
    const c = only(
      computeDmarcAlertCandidates(
        input({
          dnsChecks: dns([
            { code: 'dmarc_missing', severity: 'error', message: 'No DMARC record.', fix: { host: '_dmarc.example.com', type: 'TXT', value: 'v=DMARC1; p=none; rua=mailto:you@example.com' } },
            { code: 'spf_missing', severity: 'warning', message: 'No SPF.', fix: null },
          ]),
        }),
      ),
      'dns_misconfigured',
    )
    expect(c).toHaveLength(1)
    expect(c[0]!.severity).toBe('critical')
    expect(c[0]!.subjectKeys).toEqual(['dmarc_missing'])
    expect(c[0]!.dnsIssues.map((i) => i.code)).toEqual(['dmarc_missing'])
    expect(c[0]!.title).toBe('DMARC DNS problem for example.com')
    expect(c[0]!.message).toBe('No DMARC record.')
  })

  it('other error issues are warnings', () => {
    const c = only(
      computeDmarcAlertCandidates(input({ dnsChecks: dns([{ code: 'external_auth_missing', severity: 'error', message: 'x', fix: null }]) })),
      'dns_misconfigured',
    )[0]!
    expect(c.severity).toBe('warning')
  })

  it('warnings alone do not alert', () => {
    const c = computeDmarcAlertCandidates(input({ dnsChecks: dns([{ code: 'spf_missing', severity: 'warning', message: 'x', fix: null }]) }))
    expect(only(c, 'dns_misconfigured')).toEqual([])
  })
})

describe('switches and scope', () => {
  const noisy = () =>
    input({
      reports: [report({ reportId: 'r-fail', passCount: 500, failCount: 500 }), report({ domain: 'other.io', ago: 20 })],
      failures: [failure('198.51.100.1', 500), failure('198.51.100.2', 500, { domain: 'other.io' })],
      monitoredDomains: [D, 'other.io'],
    })

  it('produces several kinds for a noisy domain, sorted by domain then kind order', () => {
    const c = computeDmarcAlertCandidates(noisy())
    expect(c.map((x) => `${x.domain}:${x.kind}`)).toEqual([
      'example.com:unknown_source_failing',
      'example.com:alignment_drop',
      'other.io:unknown_source_failing',
      'other.io:reports_stopped',
    ])
  })

  it('alerts.enabled false → nothing', () => {
    expect(computeDmarcAlertCandidates({ ...noisy(), settings: settings({ enabled: false }) })).toEqual([])
  })

  it('a disabled kind is skipped', () => {
    const c = computeDmarcAlertCandidates({ ...noisy(), settings: settings({ disabledKinds: ['unknown_source_failing'] }) })
    expect(c.some((x) => x.kind === 'unknown_source_failing')).toBe(false)
    expect(c.some((x) => x.kind === 'alignment_drop')).toBe(true)
  })

  it('ignored domains are skipped', () => {
    const c = computeDmarcAlertCandidates({ ...noisy(), settings: settings({}, { ignoredDomains: ['other.io'] }) })
    expect(c.every((x) => x.domain === D)).toBe(true)
  })

  it('domains outside monitoredDomains are skipped', () => {
    const c = computeDmarcAlertCandidates({ ...noisy(), monitoredDomains: [D] })
    expect(c.every((x) => x.domain === D)).toBe(true)
  })

  it('windowDays moves the window', () => {
    const c = computeDmarcAlertCandidates(input({ failures: [failure('198.51.100.1', 50, { ago: 10 })], settings: settings({ windowDays: 14 }) }))
    expect(only(c, 'unknown_source_failing')).toHaveLength(1)
  })
})

describe('summary', () => {
  it('describes the domain over the window', () => {
    const c = computeDmarcAlertCandidates(
      input({
        reports: [
          report({ reportId: 'r-fail', ago: 1, passCount: 900, failCount: 100, policyP: 'quarantine', policyPct: 25 }),
          report({ ago: 3, passCount: 100, failCount: 0, policyP: 'none' }),
          report({ ago: 20, passCount: 7, failCount: 7 }),
        ],
        failures: [failure('198.51.100.1', 100)],
      }),
    )[0]!
    expect(c.summary).toEqual({
      domain: D,
      policy: 'quarantine',
      pct: 25,
      windowDays: 7,
      reportCount: 2,
      totalMessages: 1100,
      passCount: 1000,
      failCount: 100,
      alignmentRate: 1000 / 1100,
      lastReportAt: daysAgo(1),
    })
    expect(c.window).toEqual({ start: daysAgo(7), end: NOW })
    expect(c.detectedAt).toEqual(NOW)
  })
})

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function baseAlert(over: Partial<Omit<DmarcAlert, 'text'>> = {}): Omit<DmarcAlert, 'text'> {
  return {
    id: 'unknown_source_failing|example.com|',
    kind: 'unknown_source_failing',
    event: 'opened',
    severity: 'warning',
    domain: D,
    title: 'T',
    message: 'M',
    recommendation: 'R',
    detectedAt: NOW,
    firstDetectedAt: NOW,
    window: { start: daysAgo(7), end: NOW },
    summary: {
      domain: D,
      policy: 'none',
      pct: 100,
      windowDays: 7,
      reportCount: 3,
      totalMessages: 1234,
      passCount: 1200,
      failCount: 34,
      alignmentRate: 1200 / 1234,
      lastReportAt: daysAgo(1),
    },
    sources: [
      {
        ip: '198.51.100.7', ptr: 'mail.bad.example', label: null, messages: 30, daysSeen: 2,
        firstSeenDay: dayStr(2), lastSeenDay: dayStr(1), headerFrom: [D], dkimResult: 'fail', spfResult: 'fail',
        disposition: 'none', reporters: ['google.com', 'Yahoo'],
      },
      {
        ip: '203.0.113.5', ptr: null, label: 'Old CRM', messages: 4, daysSeen: 1,
        firstSeenDay: dayStr(1), lastSeenDay: dayStr(1), headerFrom: [D], dkimResult: 'none', spfResult: 'softfail',
        disposition: 'none', reporters: [],
      },
    ],
    newSourceIps: [],
    threshold: null,
    suggestedPolicy: null,
    dnsIssues: [],
    adminUrl: 'https://app.example.com/admin/mailer/#dmarc',
    ...over,
  }
}

describe('formatDmarcAlertText', () => {
  it('source alert', () => {
    expect(formatDmarcAlertText(baseAlert())).toBe(
      [
        '[WARNING] T',
        'M',
        '',
        'Domain: example.com (policy p=none)',
        'Last 7d: 1,234 messages, 97.2% passing, 3 reports',
        '',
        'Sources:',
        '  198.51.100.7 (mail.bad.example) — 30 msgs, DKIM fail, SPF fail, reported by google.com, Yahoo',
        '  203.0.113.5 (no reverse DNS) [Old CRM] — 4 msgs, DKIM none, SPF softfail, reported by unknown',
        '',
        'What to do: R',
        'https://app.example.com/admin/mailer/#dmarc',
      ].join('\n'),
    )
  })

  it('DNS alert with no data, no recommendation and no admin URL', () => {
    const text = formatDmarcAlertText(
      baseAlert({
        severity: 'critical',
        title: 'DMARC DNS problem for x.io',
        message: 'No DMARC record. Two SPF records.',
        recommendation: '',
        domain: 'x.io',
        summary: { domain: 'x.io', policy: null, pct: null, windowDays: 7, reportCount: 0, totalMessages: 0, passCount: 0, failCount: 0, alignmentRate: null, lastReportAt: null },
        sources: [],
        dnsIssues: [
          { code: 'dmarc_missing', severity: 'error', message: 'No DMARC record.', fix: { host: '_dmarc.x.io', type: 'TXT', value: 'v=DMARC1; p=none; rua=mailto:you@example.com' } },
          { code: 'spf_multiple', severity: 'error', message: 'Two SPF records.', fix: null },
        ],
        adminUrl: null,
      }),
    )
    expect(text).toBe(
      [
        '[CRITICAL] DMARC DNS problem for x.io',
        'No DMARC record. Two SPF records.',
        '',
        'Domain: x.io (policy p=unknown)',
        'Last 7d: 0 messages, n/a passing, 0 reports',
        '',
        'DNS issues:',
        '  - No DMARC record. → publish _dmarc.x.io TXT "v=DMARC1; p=none; rua=mailto:you@example.com"',
        '  - Two SPF records.',
      ].join('\n'),
    )
  })

  it('shows pct when it is not 100', () => {
    const t = formatDmarcAlertText(baseAlert({ summary: { ...baseAlert().summary, policy: 'quarantine', pct: 25 } }))
    expect(t).toContain('Domain: example.com (policy p=quarantine, pct=25)')
  })

  it('report and DNS strings can never add lines or Slack links to the text', () => {
    const src = baseAlert().sources[0]!
    const t = formatDmarcAlertText(
      baseAlert({
        sources: [
          {
            ...src,
            ip: '1.2.3.4\n[CRITICAL] rotate keys at <https://evil.example|here>',
            ptr: 'ptr\r\nInjected: yes',
            label: 'L\tabel<x>',
            reporters: ['Yahoo\n\nWhat to do: click <https://evil.example>'],
          },
        ],
        dnsIssues: [{ code: 'dmarc_invalid', severity: 'error', message: 'bad\nrecord <a>', fix: { host: '_dmarc.x\n', type: 'TXT', value: 'v=DMARC1\n<https://e|x>' } }],
      }),
    )
    const lines = t.split('\n')
    expect(lines.filter((l) => l.startsWith('[')).length).toBe(1)
    expect(lines.filter((l) => l.startsWith('What to do:')).length).toBe(1)
    expect(t).not.toMatch(/[<>]/)
    expect(t).not.toContain('\r')
    expect(t).not.toContain('\t')
    const sourceLines = lines.filter((l) => l.startsWith('  ') && !l.startsWith('  -'))
    expect(sourceLines).toHaveLength(1)
    expect(lines.filter((l) => l.startsWith('  - '))).toHaveLength(1)
  })

  it('lists ten sources, then a count', () => {
    const src = baseAlert().sources[0]!
    const sources = Array.from({ length: 13 }, (_, i) => ({ ...src, ip: `10.0.0.${i}` }))
    const t = formatDmarcAlertText(baseAlert({ sources }))
    expect(t.split('\n').filter((l) => l.startsWith('  10.0.0.'))).toHaveLength(10)
    expect(t).toContain('  …and 3 more')
  })
})

describe('finalizeDmarcAlert', () => {
  it('adds the event fields and the text', () => {
    const cand = only(computeDmarcAlertCandidates(input({ failures: [failure('198.51.100.1', 10)] })), 'unknown_source_failing')[0]!
    const first = daysAgo(2)
    const a = finalizeDmarcAlert(cand, { event: 'updated', firstDetectedAt: first, newSourceIps: ['198.51.100.1'], adminUrl: 'https://x/y' })
    expect(a.event).toBe('updated')
    expect(a.firstDetectedAt).toEqual(first)
    expect(a.newSourceIps).toEqual(['198.51.100.1'])
    expect(a.adminUrl).toBe('https://x/y')
    expect('subjectKeys' in a).toBe(false)
    const { text, ...rest } = a
    expect(text).toBe(formatDmarcAlertText(rest))
  })
})

describe('buildResolvedAlert', () => {
  it('builds an info resolution from the last alert', () => {
    const last = { ...baseAlert({ title: '2 unknown sender(s) failing DMARC for example.com' }), text: 'x' } as DmarcAlert
    const state: DmarcAlertStateDoc = {
      _id: last.id, kind: last.kind, domain: D, status: 'open', severity: 'warning', title: last.title,
      subjectKeys: ['198.51.100.7'], firstDetectedAt: daysAgo(5), lastDetectedAt: daysAgo(1), lastFiredAt: daysAgo(5),
      fireCount: 1, resolvedAt: null, lastAlert: last, lastDelivery: null,
    }
    const a = buildResolvedAlert(state, NOW, 'https://x/y')
    expect(a).toMatchObject({
      id: last.id,
      kind: 'unknown_source_failing',
      event: 'resolved',
      severity: 'info',
      domain: D,
      title: 'Resolved: 2 unknown sender(s) failing DMARC for example.com',
      message: 'This condition is no longer detected.',
      recommendation: '',
      detectedAt: NOW,
      firstDetectedAt: daysAgo(5),
      sources: [],
      dnsIssues: [],
      newSourceIps: [],
      adminUrl: 'https://x/y',
      summary: last.summary,
    })
    expect(a.text.startsWith('[INFO] Resolved: 2 unknown sender(s)')).toBe(true)
  })
})

describe('buildTestDmarcAlert', () => {
  it('is a complete, obviously fake alert', () => {
    const a = buildTestDmarcAlert('example.com', NOW, null)
    expect(a.kind).toBe('test')
    expect(a.event).toBe('test')
    expect(a.severity).toBe('info')
    expect(a.domain).toBe('example.com')
    expect(a.title).toBe('Test alert from Mailery DMARC Monitoring')
    expect(a.sources).toHaveLength(1)
    expect(a.sources[0]).toMatchObject({ ip: '203.0.113.10', ptr: 'mail.example.net' })
    expect(a.id.startsWith('test|example.com|')).toBe(true)
    expect(a.text.startsWith('[INFO] Test alert from Mailery DMARC Monitoring')).toBe(true)
  })
})
