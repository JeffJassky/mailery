/**
 * DMARC alert rules and text. Pure: no I/O, no clock reads (`now` is input).
 * Spec: plans/18-dmarc-monitoring.md §6. CONTRACT STUB — PR 1B replaces every
 * body except `dmarcAlertId`. Signatures are fixed.
 */

import type { DmarcFailureDoc, DmarcReportDoc } from '../models/index.js'
import type { DmarcAlertStateDoc } from '../models/index.js'
import type {
  DmarcAlert,
  DmarcAlertCandidate,
  DmarcAlertEvent,
  DmarcAlertKind,
  DmarcDnsCheckResult,
  DmarcMonitoringSettings,
} from '../../shared/dmarc-types.js'
import type { ResolvedSourceTag } from './dmarc.js'

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
  /** Failure rows with `receivedAt` in the last 30 days. */
  failures: DmarcFailureDoc[]
  tags: Map<string, ResolvedSourceTag>
  /** Latest stored DNS check per domain. */
  dnsChecks: Map<string, DmarcDnsCheckResult>
}

export function dmarcAlertId(kind: DmarcAlertKind, domain: string, subject: string): string {
  return `${kind}|${domain}|${subject}`
}

export function computeDmarcAlertCandidates(input: DmarcAlertInput): DmarcAlertCandidate[] {
  throw new Error(`not implemented: plans/18 §6 (${input.monitoredDomains.length})`)
}

export function finalizeDmarcAlert(
  candidate: DmarcAlertCandidate,
  extra: { event: DmarcAlertEvent; firstDetectedAt: Date; newSourceIps: string[]; adminUrl: string | null },
): DmarcAlert {
  throw new Error(`not implemented: plans/18 §6 (${candidate.id}, ${extra.event})`)
}

export function formatDmarcAlertText(alert: Omit<DmarcAlert, 'text'>): string {
  throw new Error(`not implemented: plans/18 §6.3 (${alert.id})`)
}

export function buildResolvedAlert(state: DmarcAlertStateDoc, now: Date, adminUrl: string | null): DmarcAlert {
  throw new Error(`not implemented: plans/18 §6.3 (${state._id}, ${now.toISOString()}, ${adminUrl})`)
}

export function buildTestDmarcAlert(domain: string, now: Date, adminUrl: string | null): DmarcAlert {
  throw new Error(`not implemented: plans/18 §6.3 (${domain}, ${now.toISOString()}, ${adminUrl})`)
}
