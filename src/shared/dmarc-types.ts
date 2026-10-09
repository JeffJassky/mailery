/**
 * DMARC Monitoring contract (0.21). Shared by the runner modules, the admin
 * API, the `onDmarcAlert` hook and the admin SPA (as `Wire<T>`, dates as ISO strings).
 * Spec: plans/18-dmarc-monitoring.md.
 */

export type DmarcPolicy = 'none' | 'quarantine' | 'reject'
export type DmarcAuthResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'temperror' | 'permerror' | 'none' | 'unknown'

export type DmarcAlertKind =
  | 'unknown_source_failing'
  | 'known_source_failing'
  | 'alignment_drop'
  | 'reports_stopped'
  | 'policy_ready'
  | 'dns_misconfigured'
  | 'test'

/** Every kind an operator can switch off. `test` is not one of them. */
export const DMARC_ALERT_KINDS: ReadonlyArray<Exclude<DmarcAlertKind, 'test'>> = [
  'unknown_source_failing',
  'known_source_failing',
  'alignment_drop',
  'reports_stopped',
  'policy_ready',
  'dns_misconfigured',
]

export type DmarcAlertEvent = 'opened' | 'updated' | 'reminder' | 'resolved' | 'test'
export type DmarcAlertSeverity = 'info' | 'warning' | 'critical'

export interface DmarcAlertSettings {
  enabled: boolean
  disabledKinds: Array<Exclude<DmarcAlertKind, 'test'>>
  /** Lookback, in days, for the source and alignment rules. */
  windowDays: number
  unknownSourceMinMessages: number
  knownSourceMinMessages: number
  /** 0.5–1. Alert when the window's alignment rate is below this. */
  alignmentMinRate: number
  alignmentMinMessages: number
  reportsStoppedDays: number
  /** Hours before an unchanged open alert fires again as `reminder`. 0 = never. */
  realertAfterHours: number
  /** Hours between scheduled DNS checks per domain. 0 = never on the tick. */
  dnsCheckIntervalHours: number
}

export interface DmarcMonitoringSettings {
  alerts: DmarcAlertSettings
  /** The rua= mailbox reports should be sent to, e.g. `reports@dmarc-in.example.com`. */
  reportAddress: string | null
  extraDomains: string[]
  ignoredDomains: string[]
}

export type DmarcSettingsPatch = Partial<Omit<DmarcMonitoringSettings, 'alerts'>> & {
  alerts?: Partial<DmarcAlertSettings>
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

/** Injectable for tests. The default wraps `node:dns/promises`. */
export interface DmarcDnsResolver {
  resolveTxt(host: string): Promise<string[][]>
  resolveMx(host: string): Promise<Array<{ exchange: string; priority: number }>>
  reverse(ip: string): Promise<string[]>
}

export type DmarcDnsIssueCode =
  | 'lookup_failed'
  | 'dmarc_missing'
  | 'dmarc_multiple'
  | 'dmarc_invalid'
  | 'rua_missing'
  | 'rua_missing_report_address'
  | 'external_auth_missing'
  | 'rua_domain_no_mx'
  | 'spf_missing'
  | 'spf_multiple'
  | 'spf_permissive'
  | 'policy_none'
  | 'pct_partial'
  | 'inherits_org_policy'

export interface DmarcDnsIssue {
  code: DmarcDnsIssueCode
  severity: 'error' | 'warning' | 'info'
  message: string
  /** The exact record that fixes it, when one exists. */
  fix: { host: string; type: 'TXT' | 'MX'; value: string } | null
}

export interface ParsedDmarcRecord {
  valid: boolean
  policy: DmarcPolicy | null
  subdomainPolicy: DmarcPolicy | null
  pct: number | null
  rua: string[]
  ruf: string[]
  adkim: 'r' | 's' | null
  aspf: 'r' | 's' | null
}

export interface DmarcDnsCheckResult {
  domain: string
  checkedAt: Date
  /** Set when the domain has no record of its own and the organizational domain's applies. */
  inheritedFrom: string | null
  dmarc: {
    host: string
    found: boolean
    raw: string[]
    policy: DmarcPolicy | null
    subdomainPolicy: DmarcPolicy | null
    pct: number | null
    rua: string[]
    ruf: string[]
    adkim: 'r' | 's' | null
    aspf: 'r' | 's' | null
  }
  externalAuth: Array<{ ruaAddress: string; ruaDomain: string; host: string; authorized: boolean }>
  ruaMx: Array<{ ruaDomain: string; mx: string[]; sendgridInbound: boolean }>
  spf: { found: boolean; raw: string[]; all: string | null }
  issues: DmarcDnsIssue[]
  /** True when no issue has severity `error`. */
  ok: boolean
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface DmarcAlertSource {
  ip: string
  ptr: string | null
  label: string | null
  messages: number
  daysSeen: number
  firstSeenDay: string
  lastSeenDay: string
  headerFrom: string[]
  dkimResult: DmarcAuthResult
  spfResult: DmarcAuthResult
  disposition: string
  reporters: string[]
}

export interface DmarcAlertDomainSummary {
  domain: string
  policy: DmarcPolicy | null
  pct: number | null
  windowDays: number
  reportCount: number
  totalMessages: number
  passCount: number
  failCount: number
  alignmentRate: number | null
  lastReportAt: Date | null
}

/** The payload `MailerConfig.onDmarcAlert` receives. */
export interface DmarcAlert {
  /** Stable key `${kind}|${domain}|${subject}`. Same id = same ongoing problem. */
  id: string
  kind: DmarcAlertKind
  event: DmarcAlertEvent
  severity: DmarcAlertSeverity
  domain: string
  title: string
  message: string
  recommendation: string
  /** Plain text, ready to paste into Slack or an email body. */
  text: string
  detectedAt: Date
  firstDetectedAt: Date
  window: { start: Date; end: Date }
  summary: DmarcAlertDomainSummary
  /** At most 25, by message count descending. */
  sources: DmarcAlertSource[]
  /** For event `updated`: IPs that were not in the alert before. Otherwise `[]`. */
  newSourceIps: string[]
  threshold: { name: string; limit: number; actual: number } | null
  suggestedPolicy: { policy: DmarcPolicy; pct: number; reason: string } | null
  dnsIssues: DmarcDnsIssue[]
  adminUrl: string | null
}

export type DmarcAlertCandidate = Omit<
  DmarcAlert,
  'event' | 'firstDetectedAt' | 'text' | 'adminUrl' | 'newSourceIps'
> & {
  /** Source IPs or issue codes. A key not seen before turns a reminder into `updated`. */
  subjectKeys: string[]
}

export type DmarcAlertDelivery =
  | { outcome: 'delivered'; at: Date }
  | { outcome: 'no_handler'; at: Date }
  | { outcome: 'failed'; at: Date; error: string }

// ---------------------------------------------------------------------------
// Admin surface
// ---------------------------------------------------------------------------

export interface DmarcInboundState {
  mounted: true
  path: string
  allowedDomains: string[]
}

export interface DmarcMonitoredDomain {
  domain: string
  origin: Array<'config' | 'extra' | 'reports'>
  ignored: boolean
}

/** `GET /dmarc/monitoring`. */
export interface DmarcMonitoringPayload {
  settings: DmarcMonitoringSettings
  defaults: DmarcMonitoringSettings
  hasDbOverride: boolean
  alertHandlerConfigured: boolean
  inbound: {
    mounted: boolean
    path: string | null
    /** `${publicUrl}/m${path}`. Never contains the secret. */
    url: string | null
    allowedDomains: string[]
    lastInboundReportAt: Date | null
  }
  domains: Array<
    DmarcMonitoredDomain & {
      lastReportAt: Date | null
      reportCount30d: number
      dns: DmarcDnsCheckResult | null
    }
  >
  alerts: { open: DmarcAlertStateView[]; recent: DmarcAlertStateView[] }
}

/** A `mailer_dmarc_alerts` row as the admin API returns it. */
export interface DmarcAlertStateView {
  id: string
  kind: DmarcAlertKind
  domain: string
  status: 'open' | 'resolved'
  severity: DmarcAlertSeverity
  title: string
  firstDetectedAt: Date
  lastDetectedAt: Date
  lastFiredAt: Date
  fireCount: number
  resolvedAt: Date | null
  lastAlert: DmarcAlert
  lastDelivery: DmarcAlertDelivery | null
}

/** A server type as it crosses JSON: every `Date` becomes an ISO string. */
export type Wire<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<Wire<U>>
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T
