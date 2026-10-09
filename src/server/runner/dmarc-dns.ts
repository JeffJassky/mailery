/**
 * DMARC DNS verification and reverse DNS. Spec: plans/18-dmarc-monitoring.md §7.
 * CONTRACT STUB — PR 1A replaces every body. Signatures are fixed.
 */

import type {
  DmarcDnsCheckResult,
  DmarcDnsResolver,
  ParsedDmarcRecord,
} from '../../shared/dmarc-types.js'

export const defaultDmarcDnsResolver: DmarcDnsResolver = {
  resolveTxt: () => Promise.reject(new Error('not implemented: plans/18 §7')),
  resolveMx: () => Promise.reject(new Error('not implemented: plans/18 §7')),
  reverse: () => Promise.reject(new Error('not implemented: plans/18 §7')),
}

/** Registrable domain via `psl`: `news.example.co.uk` → `example.co.uk`. Lowercased. */
export function organizationalDomain(domain: string): string {
  throw new Error(`not implemented: plans/18 §7 (${domain})`)
}

export function parseDmarcRecord(raw: string): ParsedDmarcRecord {
  throw new Error(`not implemented: plans/18 §7 (${raw})`)
}

export interface CheckDmarcDnsOptions {
  resolver?: DmarcDnsResolver
  reportAddress?: string | null
  now?: Date
  /** The organizational domain is itself monitored, so an inherited record is reported there. */
  orgDomainInSet?: boolean
}

export async function checkDmarcDns(domain: string, opts: CheckDmarcDnsOptions = {}): Promise<DmarcDnsCheckResult> {
  throw new Error(`not implemented: plans/18 §7 (${domain}, ${Object.keys(opts).length})`)
}

export interface LookupPtrOptions {
  resolver?: DmarcDnsResolver
  timeoutMs?: number
  concurrency?: number
}

export async function lookupPtr(ips: string[], opts: LookupPtrOptions = {}): Promise<Map<string, string | null>> {
  throw new Error(`not implemented: plans/18 §7 (${ips.length}, ${Object.keys(opts).length})`)
}

export function _clearPtrCache(): void {
  throw new Error('not implemented: plans/18 §7')
}
