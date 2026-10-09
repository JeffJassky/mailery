/**
 * DMARC alert rules and text. Pure: no I/O, no clock reads (`now` is input).
 * Spec: plans/18-dmarc-monitoring.md §6.
 */

import type { DmarcFailureDoc, DmarcReportDoc } from '../models/index.js'
import type { DmarcAlertStateDoc } from '../models/index.js'
import { cleanReportText } from './dmarc-text.js'
import {
  DMARC_ALERT_KINDS,
  type DmarcAlert,
  type DmarcAlertCandidate,
  type DmarcAlertDomainSummary,
  type DmarcAlertEvent,
  type DmarcAlertKind,
  type DmarcAlertSource,
  type DmarcAlertSeverity,
  type DmarcDnsCheckResult,
  type DmarcDnsIssue,
  type DmarcMonitoringSettings,
} from '../../shared/dmarc-types.js'
import { suggestPolicyProgression, type ResolvedSourceTag } from './dmarc.js'

export interface DmarcAlertInput {
  now: Date
  settings: DmarcMonitoringSettings
  /** Already lowercased. Ignored domains may be present; the rules skip them. */
  monitoredDomains: string[]
  /** Reports with `rangeEnd` in the last 35 days. */
  reports: Array<
    Pick<
      DmarcReportDoc,
      | 'reportId'
      | 'orgName'
      | 'domain'
      | 'policyP'
      | 'policyPct'
      | 'rangeStart'
      | 'rangeEnd'
      | 'totalMessages'
      | 'passCount'
      | 'failCount'
    >
  >
  /**
   * The newest report per domain over all time (not only the 35-day load), so
   * `reports_stopped` stays detected however long a domain has been silent.
   */
  latestReports: Map<string, Pick<DmarcReportDoc, 'rangeEnd' | 'policyP' | 'policyPct'>>
  /** Failure rows with `receivedAt` in the last 30 days (capped; see plans/18 §6.4). */
  failures: DmarcFailureDoc[]
  tags: Map<string, ResolvedSourceTag>
  /** Latest stored DNS check per domain. */
  dnsChecks: Map<string, DmarcDnsCheckResult>
}

export function dmarcAlertId(kind: DmarcAlertKind, domain: string, subject: string): string {
  return `${kind}|${domain}|${subject}`
}

const DAY = 86_400_000
const MAX_SOURCES = 25
const MAX_SUBJECT_KEYS = 500

function num(n: number): string {
  return n.toLocaleString('en-US')
}

function pct1(rate: number): string {
  return (rate * 100).toFixed(1)
}

interface SourceAgg {
  ip: string
  messages: number
  days: Set<string>
  headerFrom: Set<string>
  latest: { day: string; count: number; row: DmarcFailureDoc }
  firstDay: string
  lastDay: string
  reportIds: Set<string>
}

function aggregateSources(
  rows: DmarcFailureDoc[],
  reports: DmarcAlertInput['reports'],
  tags: Map<string, ResolvedSourceTag>,
): Array<{ source: DmarcAlertSource; known: boolean }> {
  const byIp = new Map<string, SourceAgg>()
  for (const row of rows) {
    let a = byIp.get(row.sourceIp)
    if (!a) {
      a = {
        ip: row.sourceIp,
        messages: 0,
        days: new Set(),
        headerFrom: new Set(),
        latest: { day: row.day, count: row.count, row },
        firstDay: row.day,
        lastDay: row.day,
        reportIds: new Set(),
      }
      byIp.set(row.sourceIp, a)
    }
    a.messages += row.count
    a.days.add(row.day)
    a.headerFrom.add(row.headerFrom.toLowerCase())
    a.reportIds.add(row.reportId)
    if (row.day < a.firstDay) a.firstDay = row.day
    if (row.day > a.lastDay) a.lastDay = row.day
    if (row.day > a.latest.day || (row.day === a.latest.day && row.count > a.latest.count)) {
      a.latest = { day: row.day, count: row.count, row }
    }
  }
  return Array.from(byIp.values()).map((a) => {
    const tag = tags.get(a.ip)
    const reporters = Array.from(
      new Set(reports.filter((r) => a.reportIds.has(r.reportId)).map((r) => r.orgName)),
    ).sort()
    return {
      known: !!tag,
      source: {
        ip: a.ip,
        ptr: null,
        label: tag?.label ?? null,
        messages: a.messages,
        daysSeen: a.days.size,
        firstSeenDay: a.firstDay,
        lastSeenDay: a.lastDay,
        headerFrom: Array.from(a.headerFrom).sort(),
        dkimResult: a.latest.row.dkimResult,
        spfResult: a.latest.row.spfResult,
        disposition: a.latest.row.dispositionApplied,
        reporters,
      },
    }
  })
}

export function computeDmarcAlertCandidates(input: DmarcAlertInput): DmarcAlertCandidate[] {
  const { now, settings, tags } = input
  const a = settings.alerts
  if (!a.enabled) return []

  const windowStart = new Date(now.getTime() - a.windowDays * DAY)
  const windowStartDay = windowStart.toISOString().slice(0, 10)
  const ignoredDomains = new Set(settings.ignoredDomains)
  const domains = Array.from(new Set(input.monitoredDomains)).filter((d) => !ignoredDomains.has(d)).sort()
  const enabled = (kind: Exclude<DmarcAlertKind, 'test'>) => !a.disabledKinds.includes(kind)
  const ignoredIps = new Set(Array.from(tags.values()).filter((t) => t.ignored).map((t) => t.ip))
  const knownIps = new Set(Array.from(tags.values()).filter((t) => !t.ignored).map((t) => t.ip))

  const out: DmarcAlertCandidate[] = []

  for (const domain of domains) {
    const allReports = input.reports.filter((r) => r.domain === domain)
    const winReports = allReports.filter((r) => r.rangeEnd.getTime() >= windowStart.getTime())
    const winRows = input.failures.filter((f) => f.domain === domain && f.day >= windowStartDay)
    const dns = input.dnsChecks.get(domain)

    const newest = input.latestReports.get(domain)

    const pass = winReports.reduce((n, r) => n + r.passCount, 0)
    const fail = winReports.reduce((n, r) => n + r.failCount, 0)
    const total = pass + fail
    const summary: DmarcAlertDomainSummary = {
      domain,
      policy: newest ? newest.policyP : (dns?.dmarc.policy ?? null),
      pct: newest ? newest.policyPct : (dns?.dmarc.pct ?? null),
      windowDays: a.windowDays,
      reportCount: winReports.length,
      totalMessages: total,
      passCount: pass,
      failCount: fail,
      alignmentRate: total === 0 ? null : pass / total,
      lastReportAt: newest ? newest.rangeEnd : null,
    }

    const make = (
      kind: Exclude<DmarcAlertKind, 'test'>,
      subject: string,
      severity: DmarcAlertSeverity,
      f: Pick<DmarcAlertCandidate, 'title' | 'message' | 'recommendation'> &
        Partial<Pick<DmarcAlertCandidate, 'sources' | 'subjectKeys' | 'threshold' | 'suggestedPolicy' | 'dnsIssues'>>,
    ): DmarcAlertCandidate => ({
      id: dmarcAlertId(kind, domain, subject),
      kind,
      severity,
      domain,
      title: f.title,
      message: f.message,
      recommendation: f.recommendation,
      detectedAt: now,
      window: { start: windowStart, end: now },
      summary,
      sources: f.sources ?? [],
      threshold: f.threshold ?? null,
      suggestedPolicy: f.suggestedPolicy ?? null,
      dnsIssues: f.dnsIssues ?? [],
      subjectKeys: f.subjectKeys ?? [],
    })

    const candidates = new Map<Exclude<DmarcAlertKind, 'test'>, DmarcAlertCandidate>()

    const rows = winRows.filter((r) => !ignoredIps.has(r.sourceIp))
    const sources = aggregateSources(rows, input.reports, tags)

    const sourceRule = (known: boolean, limit: number) => {
      const hits = sources.filter((s) => s.known === known && s.source.messages >= limit).map((s) => s.source)
      hits.sort((x, y) => y.messages - x.messages || (x.ip < y.ip ? -1 : 1))
      return hits
    }

    if (enabled('unknown_source_failing')) {
      const limit = a.unknownSourceMinMessages
      const hits = sourceRule(false, limit)
      if (hits.length > 0) {
        const sum = hits.reduce((n, s) => n + s.messages, 0)
        const note = summary.policy === null || summary.policy === 'none'
          ? ' Your policy is p=none, so receivers delivered these messages anyway.'
          : ''
        candidates.set(
          'unknown_source_failing',
          make('unknown_source_failing', '', hits.some((s) => s.messages >= limit * 10) ? 'critical' : 'warning', {
            title: `${hits.length} unknown sender(s) failing DMARC for ${domain}`,
            message: `${num(sum)} message(s) claiming to be from ${domain} failed DMARC in the last ${a.windowDays} days, sent from ${hits.length} IP address(es) you have not identified. This is either a tool you forgot to set up (SPF/DKIM) or someone spoofing your domain.${note}`,
            recommendation:
              "Open DMARC Monitoring and look at each IP's reverse DNS. If it is yours, fix its SPF/DKIM and tag it. If it is not, tag it as ignored and keep moving toward p=reject.",
            sources: hits.slice(0, MAX_SOURCES),
            subjectKeys: hits.slice(0, MAX_SUBJECT_KEYS).map((s) => s.ip),
            threshold: { name: 'unknownSourceMinMessages', limit, actual: sum },
          }),
        )
      }
    }

    if (enabled('known_source_failing')) {
      const limit = a.knownSourceMinMessages
      const hits = sourceRule(true, limit)
      if (hits.length > 0) {
        const sum = hits.reduce((n, s) => n + s.messages, 0)
        const labels = Array.from(new Set(hits.map((s) => s.label ?? s.ip)))
        const shown = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` +${labels.length - 3} more` : '')
        candidates.set(
          'known_source_failing',
          make('known_source_failing', '', 'critical', {
            title: `${shown} failing DMARC for ${domain}`,
            message: `${num(sum)} message(s) from senders you tagged as yours failed DMARC in the last ${a.windowDays} days. Your own mail is at risk of going to spam or being rejected.`,
            recommendation:
              'Check that the DKIM key for this sender is still published and that its sending IPs are in your SPF record. A recent DNS or provider change is the usual cause.',
            sources: hits.slice(0, MAX_SOURCES),
            subjectKeys: hits.slice(0, MAX_SUBJECT_KEYS).map((s) => s.ip),
            threshold: { name: 'knownSourceMinMessages', limit, actual: sum },
          }),
        )
      }
    }

    if (enabled('alignment_drop')) {
      const ignoredFail = winRows.filter((r) => ignoredIps.has(r.sourceIp)).reduce((n, r) => n + r.count, 0)
      const adjTotal = pass + Math.max(0, fail - ignoredFail)
      if (adjTotal >= a.alignmentMinMessages) {
        const rate = pass / adjTotal
        if (rate < a.alignmentMinRate) {
          candidates.set(
            'alignment_drop',
            make('alignment_drop', '', rate < 0.9 ? 'critical' : 'warning', {
              title: `DMARC pass rate for ${domain} dropped to ${pct1(rate)}%`,
              message: `${num(pass)} of ${num(adjTotal)} messages passed DMARC in the last ${a.windowDays} days (${pct1(rate)}%), below your ${pct1(a.alignmentMinRate)}% threshold.`,
              recommendation: 'Open DMARC Monitoring and sort the failing sources by volume. The top one explains most of the drop.',
              threshold: { name: 'alignmentMinRate', limit: a.alignmentMinRate, actual: rate },
            }),
          )
        }
      }
    }

    if (enabled('reports_stopped') && newest) {
      const cutoff = now.getTime() - a.reportsStoppedDays * DAY
      if (newest.rangeEnd.getTime() < cutoff) {
        candidates.set(
          'reports_stopped',
          make('reports_stopped', '', 'warning', {
            title: `No DMARC reports for ${domain} in ${a.reportsStoppedDays} days`,
            message: `Receivers normally send a report every day they get mail from ${domain}. The last one covered ${newest.rangeEnd.toISOString().slice(0, 10)}. Either the domain stopped sending, the rua= address changed, or the inbound webhook is failing.`,
            recommendation:
              "Run the DNS check in DMARC Monitoring, then look at your inbound-parse provider's activity log for rejected requests.",
          }),
        )
      }
    }

    if (enabled('policy_ready')) {
      const suggested = suggestPolicyProgression({
        reports: allReports.map((r) => ({ rangeEnd: r.rangeEnd, passCount: r.passCount, failCount: r.failCount })),
        failures: input.failures
          .filter((f) => f.domain === domain)
          .map((f) => ({ sourceIp: f.sourceIp, count: f.count, receivedAt: f.receivedAt })),
        knownSourceIps: knownIps,
        ignoredSourceIps: ignoredIps,
        currentPolicy: newest ? newest.policyP : null,
        currentPct: newest ? newest.policyPct : null,
        now,
      })
      if (suggested) {
        const rua = settings.reportAddress ?? '<your rua mailbox>'
        candidates.set(
          'policy_ready',
          make('policy_ready', `${suggested.policy}:${suggested.pct}`, 'info', {
            title: `${domain} is ready for p=${suggested.policy}${suggested.pct === 100 ? '' : ` pct=${suggested.pct}`}`,
            message: suggested.reason,
            recommendation: `Publish: npx mailery setup-dmarc --domain ${domain} --rua-mailbox ${rua} --policy ${suggested.policy} --pct ${suggested.pct}`,
            suggestedPolicy: { policy: suggested.policy, pct: suggested.pct, reason: suggested.reason },
          }),
        )
      }
    }

    if (enabled('dns_misconfigured') && dns) {
      const errors: DmarcDnsIssue[] = dns.issues.filter((i) => i.severity === 'error')
      if (errors.length > 0) {
        candidates.set(
          'dns_misconfigured',
          make('dns_misconfigured', '', errors.some((i) => i.code === 'dmarc_missing') ? 'critical' : 'warning', {
            title: `DMARC DNS problem for ${domain}`,
            message: errors.map((i) => i.message).join(' '),
            recommendation:
              'Add or fix the record(s) shown in DMARC Monitoring → Setup. Each issue lists the exact record to publish.',
            dnsIssues: errors,
            subjectKeys: errors.map((i) => i.code),
          }),
        )
      }
    }

    for (const kind of DMARC_ALERT_KINDS) {
      const c = candidates.get(kind)
      if (c) out.push(c)
    }
  }

  return out
}

export function finalizeDmarcAlert(
  candidate: DmarcAlertCandidate,
  extra: { event: DmarcAlertEvent; firstDetectedAt: Date; newSourceIps: string[]; adminUrl: string | null },
): DmarcAlert {
  const { subjectKeys: _subjectKeys, ...rest } = candidate
  const base: Omit<DmarcAlert, 'text'> = {
    ...rest,
    event: extra.event,
    firstDetectedAt: extra.firstDetectedAt,
    newSourceIps: extra.newSourceIps,
    adminUrl: extra.adminUrl,
  }
  return { ...base, text: formatDmarcAlertText(base) }
}

export function formatDmarcAlertText(alert: Omit<DmarcAlert, 'text'>): string {
  const s = alert.summary
  const blocks: string[] = [`[${alert.severity.toUpperCase()}] ${cleanReportText(alert.title)}\n${cleanReportText(alert.message)}`]

  const pctPart = s.pct !== null && s.pct !== 100 ? `, pct=${s.pct}` : ''
  blocks.push(
    [
      `Domain: ${cleanReportText(alert.domain)} (policy p=${s.policy === null ? 'unknown' : cleanReportText(s.policy)}${pctPart})`,
      `Last ${s.windowDays}d: ${num(s.totalMessages)} messages, ${s.alignmentRate === null ? 'n/a' : `${pct1(s.alignmentRate)}%`} passing, ${num(s.reportCount)} reports`,
    ].join('\n'),
  )

  if (alert.sources.length > 0) {
    const lines = ['Sources:']
    for (const src of alert.sources.slice(0, 10)) {
      const label = src.label ? ` [${cleanReportText(src.label)}]` : ''
      const reporters = src.reporters.length > 0 ? src.reporters.map((r) => cleanReportText(r)).join(', ') : 'unknown'
      const ptr = src.ptr ? cleanReportText(src.ptr) : 'no reverse DNS'
      lines.push(
        `  ${cleanReportText(src.ip, 64)} (${ptr})${label} — ${num(src.messages)} msgs, DKIM ${cleanReportText(src.dkimResult)}, SPF ${cleanReportText(src.spfResult)}, reported by ${reporters}`,
      )
    }
    if (alert.sources.length > 10) lines.push(`  …and ${alert.sources.length - 10} more`)
    blocks.push(lines.join('\n'))
  }

  if (alert.dnsIssues.length > 0) {
    const lines = ['DNS issues:']
    for (const i of alert.dnsIssues) {
      const fix = i.fix
        ? ` → publish ${cleanReportText(i.fix.host)} ${i.fix.type} "${cleanReportText(i.fix.value, 255)}"`
        : ''
      lines.push(`  - ${cleanReportText(i.message)}${fix}`)
    }
    blocks.push(lines.join('\n'))
  }

  const footer: string[] = []
  if (alert.recommendation) footer.push(`What to do: ${alert.recommendation}`)
  if (alert.adminUrl) footer.push(alert.adminUrl)
  if (footer.length > 0) blocks.push(footer.join('\n'))

  return blocks.join('\n\n')
}

export function buildResolvedAlert(state: DmarcAlertStateDoc, now: Date, adminUrl: string | null): DmarcAlert {
  const base: Omit<DmarcAlert, 'text'> = {
    id: state._id,
    kind: state.kind,
    event: 'resolved',
    severity: 'info',
    domain: state.domain,
    title: `Resolved: ${state.title}`,
    message: 'This condition is no longer detected.',
    recommendation: '',
    detectedAt: now,
    firstDetectedAt: state.firstDetectedAt,
    window: state.lastAlert.window,
    summary: state.lastAlert.summary,
    sources: [],
    newSourceIps: [],
    threshold: null,
    suggestedPolicy: null,
    dnsIssues: [],
    adminUrl,
  }
  return { ...base, text: formatDmarcAlertText(base) }
}

export function buildTestDmarcAlert(domain: string, now: Date, adminUrl: string | null): DmarcAlert {
  const today = now.toISOString().slice(0, 10)
  const base: Omit<DmarcAlert, 'text'> = {
    id: `test|${domain}|${now.toISOString()}`,
    kind: 'test',
    event: 'test',
    severity: 'info',
    domain,
    title: 'Test alert from Mailery DMARC Monitoring',
    message: 'If you can read this, onDmarcAlert is wired up. Real alerts look like this one.',
    recommendation: '',
    detectedAt: now,
    firstDetectedAt: now,
    window: { start: new Date(now.getTime() - 7 * DAY), end: now },
    summary: {
      domain,
      policy: null,
      pct: null,
      windowDays: 7,
      reportCount: 0,
      totalMessages: 0,
      passCount: 0,
      failCount: 0,
      alignmentRate: null,
      lastReportAt: null,
    },
    sources: [
      {
        ip: '203.0.113.10',
        ptr: 'mail.example.net',
        label: null,
        messages: 42,
        daysSeen: 1,
        firstSeenDay: today,
        lastSeenDay: today,
        headerFrom: [domain],
        dkimResult: 'fail',
        spfResult: 'fail',
        disposition: 'none',
        reporters: ['google.com'],
      },
    ],
    newSourceIps: [],
    threshold: null,
    suggestedPolicy: null,
    dnsIssues: [],
    adminUrl,
  }
  return { ...base, text: formatDmarcAlertText(base) }
}
