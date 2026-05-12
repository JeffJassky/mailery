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
  publishTemplate: (slug: string) =>
    json<{ ok: boolean; version: number; warnings: any[] }>(`/templates/${slug}/publish`, { method: 'POST' }),
  previewTemplate: (slug: string, body: { useDraft?: boolean; sampleContact?: any; vars?: any }) =>
    json<{ subject: string; preheader: string; html: string; plainText: string }>(`/templates/${slug}/preview`, { method: 'POST', body: JSON.stringify(body) }),
  sendTestTemplate: (slug: string, body: { to: string; sampleData?: any }) =>
    json<{ ok: boolean; providerId: string }>(`/templates/${slug}/send-test`, { method: 'POST', body: JSON.stringify(body) }),

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
  health: () => json<any>('/health'),
  healthTrips: () => json<any[]>('/health/trips'),
  resumeHealth: () => json<{ ok: boolean }>('/health/resume', { method: 'POST' }),
  setupStatus: () => json<SetupStatus>('/setup-status'),
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
