/**
 * Typed fetch wrappers against /admin/mailer/api/*. Used by every screen that
 * needs live data; falls back to `lib/mock.ts` when the API endpoint isn't
 * reachable (useful for offline preview).
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
  me: () => json<{ actor: string; permissions: Record<string, boolean> }>('/me'),
  dashboard: () => json<DashboardPayload>('/dashboard'),
  flows: () => json<any[]>('/flows'),
  flow: (slug: string) => json<any>(`/flows/${encodeURIComponent(slug)}`),
  pauseFlow: (slug: string) => json<{ ok: boolean }>(`/flows/${slug}/pause`, { method: 'POST' }),
  resumeFlow: (slug: string) => json<{ ok: boolean }>(`/flows/${slug}/resume`, { method: 'POST' }),
  templates: () => json<any[]>('/templates'),
  template: (slug: string) => json<any>(`/templates/${slug}`),
  broadcasts: () => json<any[]>('/broadcasts'),
  contacts: (cursor?: string) => json<{ contacts: any[]; nextCursor?: string }>(`/contacts${cursor ? `?cursor=${cursor}` : ''}`),
  contact: (externalId: string) => json<any>(`/contacts/${encodeURIComponent(externalId)}`),
  sends: (status?: string) => json<any[]>(`/sends${status ? `?status=${status}` : ''}`),
  send: (id: string) => json<any>(`/sends/${id}`),
  suppressions: () => json<any[]>('/suppressions'),
  addSuppression: (body: { email: string; scope: string; reason: string; source?: string; notes?: string }) =>
    json<{ ok: boolean }>('/suppressions', { method: 'POST', body: JSON.stringify(body) }),
  audit: () => json<any[]>('/audit'),
  health: () => json<any>('/health'),
  resumeHealth: () => json<{ ok: boolean }>('/health/resume', { method: 'POST' }),
}

export interface DashboardPayload {
  kpis: {
    sends: { value: number; delta: number | null }
    deliveredRate: { value: number; delta: number | null; bounced: number }
    openRate: { value: number; delta: number | null; exclBots: boolean }
    clickRate: { value: number; delta: number | null }
  }
  health: { status: string; rates: Record<string, number> }
  queue: { inFlight: number; delayed: number; providerOk: boolean; providerName: string }
  recentFlows: any[]
  recentSends: any[]
  recentAudit: any[]
}
