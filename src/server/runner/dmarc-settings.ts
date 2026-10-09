/**
 * DMARC Monitoring settings: defaults ← `MailerConfig.dmarc` ← admin-UI patch.
 * Spec: plans/18-dmarc-monitoring.md §6.1.
 */

import type { DmarcConfig } from '../config.js'
import {
  DMARC_ALERT_KINDS,
  type DmarcAlertSettings,
  type DmarcMonitoringSettings,
  type DmarcSettingsPatch,
} from '../../shared/dmarc-types.js'
import type { RunnerContext } from './index.js'

export const DMARC_SETTINGS_DEFAULTS: DmarcMonitoringSettings = {
  alerts: {
    enabled: true,
    disabledKinds: [],
    windowDays: 7,
    unknownSourceMinMessages: 10,
    knownSourceMinMessages: 5,
    alignmentMinRate: 0.98,
    alignmentMinMessages: 100,
    reportsStoppedDays: 7,
    realertAfterHours: 168,
    dnsCheckIntervalHours: 24,
  },
  reportAddress: null,
  extraDomains: [],
  ignoredDomains: [],
}

const ALERT_KEYS = Object.keys(DMARC_SETTINGS_DEFAULTS.alerts) as Array<keyof DmarcAlertSettings>
const TOP_KEYS = ['alerts', 'reportAddress', 'extraDomains', 'ignoredDomains']
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_DOMAINS = 100

const INT_RANGES: Partial<Record<keyof DmarcAlertSettings, [number, number]>> = {
  windowDays: [1, 30],
  unknownSourceMinMessages: [1, 1_000_000],
  knownSourceMinMessages: [1, 1_000_000],
  alignmentMinMessages: [1, 1_000_000],
  reportsStoppedDays: [1, 30],
  realertAfterHours: [0, 8760],
  dnsCheckIntervalHours: [0, 720],
}

function normalizeDomains(list: readonly string[]): string[] {
  return Array.from(new Set(list.map((d) => d.trim().toLowerCase()).filter((d) => d !== '')))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function applyLayer(out: DmarcMonitoringSettings, layer: DmarcSettingsPatch | undefined): void {
  if (!layer) return
  if (layer.alerts) {
    const dst = out.alerts as unknown as Record<string, unknown>
    const src = layer.alerts as unknown as Record<string, unknown>
    for (const k of ALERT_KEYS) {
      const v = src[k]
      if (v === undefined) continue
      dst[k] = Array.isArray(v) ? [...v] : v
    }
  }
  if (layer.reportAddress !== undefined) out.reportAddress = layer.reportAddress
  if (layer.extraDomains !== undefined) out.extraDomains = [...layer.extraDomains]
  if (layer.ignoredDomains !== undefined) out.ignoredDomains = [...layer.ignoredDomains]
}

export function mergeDmarcSettings(
  config: DmarcConfig | undefined,
  patch: DmarcSettingsPatch | null,
): DmarcMonitoringSettings {
  const out: DmarcMonitoringSettings = structuredClone(DMARC_SETTINGS_DEFAULTS)
  if (config) {
    applyLayer(out, {
      alerts: config.alerts,
      reportAddress: config.reportAddress,
      extraDomains: config.extraDomains,
      ignoredDomains: config.ignoredDomains,
    })
  }
  applyLayer(out, patch ?? undefined)
  out.extraDomains = normalizeDomains(out.extraDomains)
  out.ignoredDomains = normalizeDomains(out.ignoredDomains)
  return out
}

function validateDomainList(field: string, v: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
  if (!Array.isArray(v)) return { ok: false, message: `${field} must be an array of domains` }
  if (v.length > MAX_DOMAINS) return { ok: false, message: `${field} may hold at most ${MAX_DOMAINS} domains` }
  const value: string[] = []
  for (const d of v) {
    if (typeof d !== 'string') return { ok: false, message: `${field} must contain only strings` }
    const lower = d.trim().toLowerCase()
    if (!DOMAIN_RE.test(lower)) return { ok: false, message: `${field}: "${d}" is not a valid domain` }
    value.push(lower)
  }
  return { ok: true, value }
}

export function validateDmarcSettingsPatch(
  body: unknown,
): { ok: true; patch: DmarcSettingsPatch } | { ok: false; message: string } {
  if (!isPlainObject(body)) return { ok: false, message: 'body must be an object' }
  const patch: DmarcSettingsPatch = {}

  for (const key of Object.keys(body)) {
    if (UNSAFE_KEYS.has(key) || !TOP_KEYS.includes(key)) return { ok: false, message: `unknown field "${key}"` }
  }

  if ('alerts' in body) {
    const a = body.alerts
    if (!isPlainObject(a)) return { ok: false, message: 'alerts must be an object' }
    const alerts: Record<string, unknown> = {}
    for (const key of Object.keys(a)) {
      if (UNSAFE_KEYS.has(key) || !(ALERT_KEYS as string[]).includes(key)) {
        return { ok: false, message: `unknown field "alerts.${key}"` }
      }
      const v = a[key]
      const range = INT_RANGES[key as keyof DmarcAlertSettings]
      if (range) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < range[0] || v > range[1]) {
          return { ok: false, message: `alerts.${key} must be an integer from ${range[0]} to ${range[1]}` }
        }
        alerts[key] = v
      } else if (key === 'alignmentMinRate') {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 1) {
          return { ok: false, message: 'alerts.alignmentMinRate must be a number from 0.5 to 1' }
        }
        alerts[key] = v
      } else if (key === 'enabled') {
        if (typeof v !== 'boolean') return { ok: false, message: 'alerts.enabled must be true or false' }
        alerts[key] = v
      } else {
        const kinds = DMARC_ALERT_KINDS as readonly string[]
        if (!Array.isArray(v) || !v.every((k) => typeof k === 'string' && kinds.includes(k))) {
          return { ok: false, message: `alerts.disabledKinds must be an array of: ${kinds.join(', ')}` }
        }
        alerts[key] = [...v]
      }
    }
    patch.alerts = alerts as Partial<DmarcAlertSettings>
  }

  if ('reportAddress' in body) {
    const v = body.reportAddress
    if (v !== null && (typeof v !== 'string' || !ADDRESS_RE.test(v))) {
      return { ok: false, message: 'reportAddress must be null or an email address' }
    }
    patch.reportAddress = v
  }

  for (const field of ['extraDomains', 'ignoredDomains'] as const) {
    if (!(field in body)) continue
    const r = validateDomainList(field, body[field])
    if (!r.ok) return r
    patch[field] = r.value
  }

  return { ok: true, patch }
}

export async function loadDmarcSettings(
  ctx: RunnerContext,
): Promise<{ settings: DmarcMonitoringSettings; hasDbOverride: boolean }> {
  const doc = await ctx.collections.dmarcSettings.findOne({ _id: 'settings' })
  return { settings: mergeDmarcSettings(ctx.config.dmarc, doc?.patch ?? null), hasDbOverride: doc !== null }
}

export async function saveDmarcSettingsPatch(
  ctx: RunnerContext,
  patch: DmarcSettingsPatch,
  actor: string,
): Promise<DmarcMonitoringSettings> {
  const existing = await ctx.collections.dmarcSettings.findOne({ _id: 'settings' })
  const merged: DmarcSettingsPatch = {}
  const stored = (existing?.patch ?? {}) as Record<string, unknown>
  const incoming = patch as Record<string, unknown>
  const target = merged as Record<string, unknown>
  for (const src of [stored, incoming]) {
    for (const key of Object.keys(src)) {
      if (UNSAFE_KEYS.has(key) || src[key] === undefined) continue
      if (key === 'alerts' && isPlainObject(src.alerts)) {
        const alerts = (target.alerts ?? {}) as Record<string, unknown>
        for (const k of Object.keys(src.alerts)) {
          if (UNSAFE_KEYS.has(k) || src.alerts[k] === undefined) continue
          alerts[k] = src.alerts[k]
        }
        target.alerts = alerts
      } else {
        target[key] = src[key]
      }
    }
  }
  await ctx.collections.dmarcSettings.updateOne(
    { _id: 'settings' },
    { $set: { patch: merged, updatedBy: actor, updatedAt: new Date() } },
    { upsert: true },
  )
  return mergeDmarcSettings(ctx.config.dmarc, merged)
}

export async function clearDmarcSettingsPatch(ctx: RunnerContext): Promise<DmarcMonitoringSettings> {
  await ctx.collections.dmarcSettings.deleteOne({ _id: 'settings' })
  return mergeDmarcSettings(ctx.config.dmarc, null)
}
