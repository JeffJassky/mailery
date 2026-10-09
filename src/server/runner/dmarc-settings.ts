/**
 * DMARC Monitoring settings: defaults ← `MailerConfig.dmarc` ← admin-UI patch.
 * Spec: plans/18-dmarc-monitoring.md §6.1. CONTRACT STUB — PR 1B replaces every
 * body except `DMARC_SETTINGS_DEFAULTS`. Signatures are fixed.
 */

import type { DmarcConfig } from '../config.js'
import type { DmarcMonitoringSettings, DmarcSettingsPatch } from '../../shared/dmarc-types.js'
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

export function mergeDmarcSettings(
  config: DmarcConfig | undefined,
  patch: DmarcSettingsPatch | null,
): DmarcMonitoringSettings {
  throw new Error(`not implemented: plans/18 §6.1 (${String(config)}, ${String(patch)})`)
}

export function validateDmarcSettingsPatch(
  body: unknown,
): { ok: true; patch: DmarcSettingsPatch } | { ok: false; message: string } {
  throw new Error(`not implemented: plans/18 §6.1 (${String(body)})`)
}

export async function loadDmarcSettings(
  ctx: RunnerContext,
): Promise<{ settings: DmarcMonitoringSettings; hasDbOverride: boolean }> {
  throw new Error(`not implemented: plans/18 §6.1 (${String(ctx)})`)
}

export async function saveDmarcSettingsPatch(
  ctx: RunnerContext,
  patch: DmarcSettingsPatch,
  actor: string,
): Promise<DmarcMonitoringSettings> {
  throw new Error(`not implemented: plans/18 §6.1 (${String(ctx)}, ${String(patch)}, ${actor})`)
}

export async function clearDmarcSettingsPatch(ctx: RunnerContext): Promise<DmarcMonitoringSettings> {
  throw new Error(`not implemented: plans/18 §6.1 (${String(ctx)})`)
}
