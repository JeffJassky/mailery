/**
 * DMARC Monitoring runner: scheduled DNS checks, alert evaluation, the alert
 * state machine and hook delivery. Spec: plans/18-dmarc-monitoring.md §6.4–6.6.
 * CONTRACT STUB — PR 2A replaces every body. Signatures are fixed.
 */

import type { DmarcAlert, DmarcAlertDelivery, DmarcDnsCheckResult, DmarcDnsResolver } from '../../shared/dmarc-types.js'
import type { RunnerContext } from './index.js'

export interface DmarcMonitorOptions {
  resolver?: DmarcDnsResolver
  now?: Date
  /** Bypass the hourly evaluation throttle and the per-domain DNS interval. */
  force?: boolean
}

/**
 * Tick entry point. Does nothing — no DNS, no reads beyond one count — unless
 * `config.dmarc` is set or at least one report has been ingested.
 */
export async function runDmarcMonitor(
  ctx: RunnerContext,
  opts: DmarcMonitorOptions = {},
): Promise<{ ran: boolean; reason?: string }> {
  throw new Error(`not implemented: plans/18 §6.6 (${String(ctx)}, ${String(opts)})`)
}

export async function runDmarcDnsChecks(
  ctx: RunnerContext,
  opts: DmarcMonitorOptions & { domain?: string } = {},
): Promise<DmarcDnsCheckResult[]> {
  throw new Error(`not implemented: plans/18 §6.6 (${String(ctx)}, ${String(opts)})`)
}

export async function evaluateDmarcAlerts(
  ctx: RunnerContext,
  opts: DmarcMonitorOptions = {},
): Promise<{ ran: boolean; reason?: string; fired: number; open: number }> {
  throw new Error(`not implemented: plans/18 §6.4 (${String(ctx)}, ${String(opts)})`)
}

export async function fireDmarcAlert(ctx: RunnerContext, alert: DmarcAlert): Promise<DmarcAlertDelivery> {
  throw new Error(`not implemented: plans/18 §6.5 (${String(ctx)}, ${alert.id})`)
}

export async function sendTestDmarcAlert(
  ctx: RunnerContext,
  opts: { now?: Date } = {},
): Promise<{ delivery: DmarcAlertDelivery; alert: DmarcAlert }> {
  throw new Error(`not implemented: plans/18 §6.5 (${String(ctx)}, ${String(opts)})`)
}

/** Tests only: forget the process-local evaluation throttle. */
export function _resetDmarcMonitorThrottle(): void {
  throw new Error('not implemented: plans/18 §6.6')
}
