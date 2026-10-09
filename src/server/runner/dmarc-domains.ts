/**
 * Which domains DMARC Monitoring watches. Spec: plans/18-dmarc-monitoring.md §6.2.
 * CONTRACT STUB — PR 1C replaces every body. Signatures are fixed.
 */

import type { MailerConfig } from '../config.js'
import type { DmarcMonitoredDomain, DmarcMonitoringSettings } from '../../shared/dmarc-types.js'

export type SenderDomainConfig = Pick<
  MailerConfig,
  'senderDomains' | 'fromDefaults' | 'transactionalFromDefaults' | 'senderAddress'
>

/**
 * Domains this deployment sends from, plus each one's organizational domain
 * (via `psl`). Lowercased, deduplicated, sorted.
 */
export function deriveSenderDomains(config: SenderDomainConfig): string[] {
  throw new Error(`not implemented: plans/18 §6.2 (${Object.keys(config).length})`)
}

export function resolveMonitoredDomains(
  config: SenderDomainConfig,
  settings: DmarcMonitoringSettings,
  reportDomains: string[],
): DmarcMonitoredDomain[] {
  throw new Error(`not implemented: plans/18 §6.2 (${Object.keys(config).length}, ${settings.extraDomains.length}, ${reportDomains.length})`)
}
