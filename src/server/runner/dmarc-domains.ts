/**
 * Which domains DMARC Monitoring watches. Spec: plans/18-dmarc-monitoring.md §6.2.
 */

import psl from 'psl'

import { DOMAIN_PATTERN } from './dmarc.js'

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
  const out = new Set<string>()
  const add = (raw: string | undefined) => {
    const domain = raw?.trim().toLowerCase().replace(/^\.+/, '')
    if (!domain) return
    out.add(domain)
    out.add(orgDomain(domain))
  }
  for (const domain of Object.keys(config.senderDomains ?? {})) add(domain)
  add(emailDomain(config.fromDefaults?.email))
  add(emailDomain(config.transactionalFromDefaults?.email))
  // senderAddress is a postal address (CAN-SPAM footer), never a domain.
  return [...out].sort()
}

export function resolveMonitoredDomains(
  config: SenderDomainConfig,
  settings: DmarcMonitoringSettings,
  reportDomains: string[],
): DmarcMonitoredDomain[] {
  const origins = new Map<string, Set<DmarcMonitoredDomain['origin'][number]>>()
  const add = (raw: string, origin: DmarcMonitoredDomain['origin'][number]) => {
    const domain = raw.trim().toLowerCase()
    if (!domain) return
    let set = origins.get(domain)
    if (!set) origins.set(domain, (set = new Set()))
    set.add(origin)
  }
  for (const d of deriveSenderDomains(config)) add(d, 'config')
  for (const d of settings.extraDomains) add(d, 'extra')
  // Rows stored before 0.21 validated nothing; never let one become a monitored domain.
  for (const d of reportDomains) if (DOMAIN_PATTERN.test(d.trim().toLowerCase())) add(d, 'reports')

  const ignored = new Set(settings.ignoredDomains.map((d) => d.trim().toLowerCase()))
  const order = ['config', 'extra', 'reports'] as const
  return [...origins.keys()].sort().map((domain) => ({
    domain,
    origin: order.filter((o) => origins.get(domain)!.has(o)),
    ignored: ignored.has(domain),
  }))
}

function orgDomain(domain: string): string {
  return psl.get(domain) ?? domain
}

function emailDomain(email: string | undefined): string | undefined {
  if (typeof email !== 'string') return undefined
  const at = email.lastIndexOf('@')
  return at === -1 ? undefined : email.slice(at + 1)
}
