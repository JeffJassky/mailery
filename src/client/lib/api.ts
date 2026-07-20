/**
 * Typed fetch wrappers against /admin/mailer/api/*. Used by every screen that
 * needs live data. No mock fallback — screens render their own loading /
 * error / empty UI when a fetch is pending or fails.
 */

const BASE = '/admin/mailer/api'

async function json<T = unknown>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${input}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const api = {
  me: () => json<MePayload>('/me'),
  dashboard: () => json<DashboardPayload>('/dashboard'),

  // Events registry
  events: () =>
    json<{ registered: { name: string; dedupePolicy: string }[]; seen: string[] }>('/events'),

  // Flows
  flows: () => json<any[]>('/flows'),
  flow: (slug: string) => json<any>(`/flows/${encodeURIComponent(slug)}`),
  createFlow: (body: { slug: string; name: string; description?: string; trigger: { eventName: string; once?: boolean }; goal?: string; audience?: string }) =>
    json<{ ok: boolean; slug: string }>('/flows', { method: 'POST', body: JSON.stringify(body) }),
  updateFlowDraft: (slug: string, body: Record<string, unknown>) =>
    json<{ ok: boolean }>(`/flows/${slug}/draft`, { method: 'PATCH', body: JSON.stringify(body) }),
  publishFlow: (slug: string) => json<{ ok: boolean; version: number }>(`/flows/${slug}/publish`, { method: 'POST' }),
  deleteFlow: (slug: string) => json<{ ok: boolean }>(`/flows/${slug}`, { method: 'DELETE' }),
  pauseFlow: (slug: string) => json<{ ok: boolean }>(`/flows/${slug}/pause`, { method: 'POST' }),
  resumeFlow: (slug: string) => json<{ ok: boolean }>(`/flows/${slug}/resume`, { method: 'POST' }),

  // Templates
  templates: () => json<any[]>('/templates'),
  template: (slug: string) => json<any>(`/templates/${slug}`),
  createTemplate: (body: { slug: string; name: string; kind: 'marketing' | 'transactional'; subject?: string; preheader?: string; fromName?: string; fromEmail?: string }) =>
    json<{ ok: boolean; slug: string }>('/templates', { method: 'POST', body: JSON.stringify(body) }),
  updateTemplateDraft: (slug: string, body: Record<string, unknown>) =>
    json<{ ok: boolean }>(`/templates/${slug}/draft`, { method: 'PATCH', body: JSON.stringify(body) }),
  publishTemplate: (slug: string, body?: { bypassMailTester?: boolean }) =>
    json<{ ok: boolean; version: number; warnings: any[] }>(`/templates/${slug}/publish`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),
  previewTemplate: (slug: string, body: { useDraft?: boolean; sampleContact?: any; vars?: any; contactId?: string; eventProperties?: Record<string, unknown> }) =>
    json<PreviewResponse>(`/templates/${slug}/preview`, { method: 'POST', body: JSON.stringify(body) }),
  sendTestTemplate: (slug: string, body: { to: string; sampleData?: any; contactId?: string; eventProperties?: Record<string, unknown> }) =>
    json<{ ok: boolean; providerId: string }>(`/templates/${slug}/send-test`, { method: 'POST', body: JSON.stringify(body) }),
  varsSchema: () => json<VarsSchemaResponse>('/vars-schema'),

  // Broadcasts
  broadcasts: () => json<any[]>('/broadcasts'),
  broadcast: (slug: string) => json<any>(`/broadcasts/${slug}`),
  createBroadcast: (body: { slug: string; name: string; templateSlug: string; segmentDefinition?: any }) =>
    json<{ ok: boolean; slug: string }>('/broadcasts', { method: 'POST', body: JSON.stringify(body) }),
  updateBroadcast: (slug: string, body: Record<string, unknown>) =>
    json<{ ok: boolean }>(`/broadcasts/${slug}`, { method: 'PATCH', body: JSON.stringify(body) }),
  countSegment: (slug: string, segmentDefinition: any) =>
    json<{ upperBound: number; approximate: boolean; computedMs: number }>(`/broadcasts/${slug}/segment/count`, { method: 'POST', body: JSON.stringify({ segmentDefinition }) }),
  scheduleBroadcast: (slug: string, body: { scheduledAt: string; confirmedCount: number; respectRecipientTimezone?: boolean }) =>
    json<{ ok: boolean }>(`/broadcasts/${slug}/schedule`, { method: 'POST', body: JSON.stringify(body) }),
  cancelBroadcast: (slug: string) => json<{ ok: boolean }>(`/broadcasts/${slug}/cancel`, { method: 'POST' }),

  // Contacts / sends / suppressions / audit / health
  contacts: (cursor?: string) => json<{ contacts: any[]; nextCursor?: string }>(`/contacts${cursor ? `?cursor=${cursor}` : ''}`),
  contact: (externalId: string) => json<any>(`/contacts/${encodeURIComponent(externalId)}`),
  sends: (status?: string) => json<any[]>(`/sends${status ? `?status=${status}` : ''}`),
  send: (id: string) => json<any>(`/sends/${id}`),
  suppressions: () => json<any[]>('/suppressions'),
  addSuppression: (body: { email: string; scope: string; reason: string; source?: string; notes?: string }) =>
    json<{ ok: boolean }>('/suppressions', { method: 'POST', body: JSON.stringify(body) }),
  audit: () => json<any[]>('/audit'),
  health: () => json<HealthPayload>('/health'),
  healthTrips: () => json<any[]>('/health/trips'),
  resumeHealth: (target?: { senderDomain: string; kind: 'marketing' | 'transactional' }) =>
    json<{ ok: boolean; resumed: number }>('/health/resume', {
      method: 'POST',
      body: target ? JSON.stringify(target) : undefined,
    }),
  setupStatus: () => json<SetupStatus>('/setup-status'),

  // DNSBL
  dnsbl: () => json<DnsblPayload>('/dnsbl'),
  recheckDnsbl: () =>
    json<{ ran: boolean; reason?: string; totalChecks?: number; listedCount?: number }>(
      '/dnsbl/recheck',
      { method: 'POST' },
    ),

  // Postmaster Tools
  postmaster: () => json<PostmasterPayload>('/postmaster'),
  refreshPostmaster: () =>
    json<{ ran: boolean; reason?: string; fetched?: number; trippedDomains?: string[] }>(
      '/postmaster/refresh',
      { method: 'POST' },
    ),

  // Microsoft SNDS
  snds: () => json<SndsPayload>('/snds'),
  refreshSnds: () =>
    json<{ ran: boolean; reason?: string; rowsParsed?: number; rowsPersisted?: number }>(
      '/snds/refresh',
      { method: 'POST' },
    ),

  // DMARC RUA
  dmarc: () => json<DmarcPayload>('/dmarc'),
  uploadDmarc: async (file: File): Promise<DmarcUploadResult> => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${BASE}/dmarc/upload`, { method: 'POST', credentials: 'same-origin', body: fd })
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<DmarcUploadResult>
  },
  hygiene: () => json<HygieneReport>('/hygiene'),

  mailTesterStatus: (slug: string) =>
    json<MailTesterStatusResponse>(`/templates/${encodeURIComponent(slug)}/mail-tester`),
  startMailTesterCheck: (slug: string) =>
    json<MailTesterStartResponse>(`/templates/${encodeURIComponent(slug)}/mail-tester-check`, {
      method: 'POST',
    }),
  fetchMailTesterResult: (slug: string, checkId: string) =>
    json<MailTesterResultResponse>(
      `/templates/${encodeURIComponent(slug)}/mail-tester-result?checkId=${encodeURIComponent(checkId)}`,
    ),

  lintTemplate: (slug: string, body: LintRequestBody, signal?: AbortSignal) =>
    json<LintResponse>(`/templates/${encodeURIComponent(slug)}/lint`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  tagDmarcSource: (ip: string, body: { label: string; ignored?: boolean }) =>
    json<{ ok: boolean }>(`/dmarc/sources/${encodeURIComponent(ip)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  untagDmarcSource: (ip: string) =>
    json<{ ok: boolean; deleted: number }>(`/dmarc/sources/${encodeURIComponent(ip)}`, {
      method: 'DELETE',
    }),
}

export type CheckSeverity = 'ok' | 'warn' | 'error'

export interface SetupCheck {
  name: string
  label: string
  severity: CheckSeverity
  message: string
  hint?: string
}

export interface SetupStatus {
  overall: CheckSeverity
  generatedAt: string
  checks: SetupCheck[]
}

export interface MePayload {
  actor: string
  counts: { flows: number; templates: number; broadcasts: number; contacts: number; suppressions: number }
  /** `status` is null when no tick has run yet (unknown, not healthy). */
  health: { status: string | null }
  providers: { names: string[]; default: string }
  broadcastConfirmationThreshold: number
}

export interface MailTesterFeedback {
  category: string
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface MailTesterScore {
  templateSlug: string
  contentKey: string
  checkId: string
  score: number
  feedback: MailTesterFeedback[]
  rawSummary: string | null
  fetchedAt: string
  expiresAt: string
}

export interface MailTesterStatusResponse {
  configured: boolean
  minScore: number
  cacheHours: number
  score: MailTesterScore | null
}

export interface MailTesterStartResponse {
  cached: boolean
  status: 'pending' | 'ready'
  checkId?: string
  contentKey?: string
  score?: MailTesterScore
  message?: string
}

export interface MailTesterResultResponse {
  status: 'pending' | 'ready'
  score: MailTesterScore | null
}

export interface PreviewResponse {
  subject: string
  preheader: string
  html: string
  plainText: string
  contact?: { externalId: string; email: string }
}

export interface VarsSchemaResponse {
  /** JSON Schema of the host's varsAdapter, or null when none configured. */
  schema: Record<string, unknown> | null
  /** Render-context keys mailery always provides ({{unsubscribeUrl}}, {{contact.*}}, …). */
  builtins: string[]
}

export interface LintIssue {
  rule: string
  severity: 'error' | 'warning' | 'info'
  message: string
  hint?: string
}

export interface LintResponse {
  errors: LintIssue[]
  warnings: LintIssue[]
  infos: LintIssue[]
  compileFailed: boolean
}

export interface LintRequestBody {
  subject?: string
  preheader?: string
  mjml?: string
  editorJson?: Record<string, unknown> | null
  fromEmail?: string
  kind?: 'marketing' | 'transactional'
}

export interface HygieneBucket {
  label: string
  minDays?: number | null
  maxDays?: number | null
  neverEngaged?: boolean
  count: number
  pctOfTotal: number
}

export interface HygieneReport {
  totalSubscribers: number
  totalWithSends: number
  buckets: HygieneBucket[]
  sunsetCandidate: {
    count: number
    pctOfTotal: number
    cohortLifetime: {
      totalSends: number
      bouncedRate: number
      hardBouncedRate: number
      complaintRate: number
    } | null
    projectedImpact: {
      recentTotalSends: number
      recentBounced: number
      recentComplained: number
      cohortRecentSends: number
      cohortRecentBounced: number
      cohortRecentComplained: number
      currentOverallBounceRate: number
      projectedBounceRate: number
      currentOverallComplaintRate: number
      projectedComplaintRate: number
    } | null
  }
  computedAt: string
}

export interface DmarcDomainSummary {
  domain: string
  passCount: number
  failCount: number
  totalMessages: number
  reportCount: number
  latestRangeEnd: string | null
  alignmentRate: number | null
  currentPolicy: 'none' | 'quarantine' | 'reject' | null
  currentPct: number | null
  progression: {
    policy: 'none' | 'quarantine' | 'reject'
    pct: number
    reason: string
    current: { policy: 'none' | 'quarantine' | 'reject' | null; pct: number | null }
  } | null
  series: Array<{ day: string; alignmentRate: number | null }>
}

export interface DmarcSourceRow {
  sourceIp: string
  domain: string
  totalMessages: number
  daysSeen: number
  lastSeen: string
  dkimResult: string
  spfResult: string
  dispositionApplied: string
  label: string | null
  ignored: boolean
  tagSource: 'config' | 'db' | null
}

export interface DmarcReportRow {
  reportId: string
  orgName: string
  email: string
  domain: string
  policyP: string
  policyPct: number
  rangeStart: string
  rangeEnd: string
  totalMessages: number
  passCount: number
  failCount: number
  receivedAt: string
}

export interface DmarcPayload {
  domains: DmarcDomainSummary[]
  sources: DmarcSourceRow[]
  recentReports: DmarcReportRow[]
  retentionDays: number
}

export interface DmarcUploadResult {
  ok: true
  reportId: string
  domain: string
  rangeStart: string
  rangeEnd: string
  totalMessages: number
  passCount: number
  failCount: number
  duplicate: boolean
}

export type SndsFilterResult = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN'

export interface SndsSnapshot {
  ip: string
  activityStart: string
  activityEnd: string
  rcptCommands: number
  dataCommands: number
  messageRecipients: number
  filterResult: SndsFilterResult
  complaintRate: number | null
  trapMessageCount: number
  sampleHelo: string | null
  sampleMailFrom: string | null
  fetchedAt: string
}

export interface SndsPayload {
  configured: boolean
  intervalHours: number
  ips: Array<{
    ip: string
    latest: SndsSnapshot | null
    history: SndsSnapshot[]
  }>
}

export type PostmasterReputation = 'HIGH' | 'MEDIUM' | 'LOW' | 'BAD' | 'REPUTATION_CATEGORY_UNSPECIFIED'

export interface PostmasterSnapshot {
  domain: string
  date: string
  domainReputation: PostmasterReputation | null
  ipReputations: Array<{ reputation: PostmasterReputation; ipCount: number }> | null
  userReportedSpamRatio: number | null
  spfSuccessRatio: number | null
  dkimSuccessRatio: number | null
  dmarcSuccessRatio: number | null
  outboundEncryptionRatio: number | null
  inboundEncryptionRatio: number | null
  deliveryErrors: Array<{ errorType: string; errorClass: string; errorRatio: number }> | null
  spammyFeedbackLoops: Array<{ id: string; spamRatio: number }> | null
  fetchedAt: string
}

export interface PostmasterPayload {
  configured: boolean
  intervalHours: number
  domains: Array<{
    domain: string
    latest: PostmasterSnapshot | null
    history: PostmasterSnapshot[]
  }>
}

export interface DnsblCheck {
  _id?: string
  target: string
  targetKind: 'domain' | 'ip'
  list: string
  listLabel: string
  result: 'clean' | 'listed' | 'error'
  returnCodes: string[]
  errorMessage: string | null
  runAt: string
}

export interface DnsblPayload {
  checks: DnsblCheck[]
  latestRunAt: string | null
  intervalHours: number
}

export interface HealthBucket {
  _id: string
  senderDomain: string | null
  kind: 'marketing' | 'transactional' | null
  status: 'healthy' | 'degraded' | 'tripped'
  rates: { bounceRate: number; hardBounceRate: number; complaintRate: number; failureRate: number }
  counters: {
    sent: number; delivered: number; bounced: number; hardBounced: number
    softBounced: number; complained: number; failedToSend: number
  }
  trippedAt: string | null
  trippedReason: string | null
  manuallyResumedAt: string | null
  windowStartedAt: string
  windowDurationMs: number
  updatedAt: string
}

export interface HealthPayload {
  status: 'healthy' | 'degraded' | 'tripped' | null
  rates: HealthBucket['rates'] | null
  counters: HealthBucket['counters'] | null
  aggregate: HealthBucket | null
  buckets: HealthBucket[]
  thresholds: {
    hardBounceRatePctTrip?: number
    complaintRatePctTrip?: number
    combinedBounceRatePctTrip?: number
    failedToSendRatePctDegrade?: number
  }
}

export interface DashboardPayload {
  kpis: {
    sends: { value: number; delta: number | null }
    deliveredRate: { value: number | null; delta: number | null; bounced: number }
    openRate: { value: number | null; delta: number | null }
    clickRate: { value: number | null; delta: number | null }
  }
  series: { hourly: { sends: number[]; opens: number[] } }
  health: { status: string | null; rates: Record<string, number> | null; thresholds: Record<string, number> }
  queue: {
    inFlight: number | null
    delayed: number | null
    providerOk: boolean | null
    providerName: string
  }
  recentFlows: any[]
  recentSends: any[]
  recentAudit: any[]
}
