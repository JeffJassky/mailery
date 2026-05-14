/**
 * DNSBL monitor. Once a day (or on demand) we DNS-query each configured
 * sender domain against domain block lists (DBLs) and each configured
 * dedicated IP against IP block lists. Results are stored as one doc per
 * (target, list) — the latest result replaces the prior one.
 *
 * No external API. Pure DNS, so it works in any environment that can
 * resolve public hostnames.
 */

import dns from 'node:dns/promises'
import net from 'node:net'
import psl from 'psl'

import type {
  DnsblConfig,
  DnsblListSpec,
} from '../config.js'
import {
  DEFAULT_DOMAIN_DNSBL_LISTS,
  DEFAULT_IP_DNSBL_LISTS,
} from '../config.js'
import type { DnsblCheckDoc, DnsblResult, DnsblTargetKind } from '../models/index.js'
import { extractDomain } from '../templates/sender-domain.js'
import type { RunnerContext } from './index.js'

/**
 * Lists that expect a registrable domain (eTLD+1) rather than the full
 * FQDN. Querying `mail.foo.example.com.multi.surbl.org` returns NXDOMAIN
 * even when `example.com` is listed.
 */
const REGISTRABLE_ONLY_LISTS = new Set(['multi.surbl.org', 'multi.uribl.com'])

/** DNS-query concurrency for parallel lookups. Keep modest to avoid resolver throttling. */
const DNS_CONCURRENCY = 8

export interface Resolver {
  resolve4(hostname: string): Promise<string[]>
}

const defaultResolver: Resolver = {
  resolve4: (hostname) => dns.resolve4(hostname),
}

export interface RunDnsblOptions {
  /** Override the DNS resolver (used in tests). */
  resolver?: Resolver
  /** When true, ignore the throttle and run all checks immediately. */
  force?: boolean
}

export interface RunDnsblResult {
  ran: boolean
  reason?: string
  totalChecks?: number
  listedCount?: number
}

/**
 * Run DNSBL checks for every (target × list) pair. Idempotent — the latest
 * result for each pair is upserted.
 */
export async function runDnsblChecks(
  ctx: RunnerContext,
  opts: RunDnsblOptions = {},
): Promise<RunDnsblResult> {
  const cfg = ctx.config.dnsbl ?? {}
  const intervalHours = cfg.intervalHours ?? 24

  if (!opts.force && intervalHours <= 0) {
    return { ran: false, reason: 'disabled' }
  }

  const targets = collectTargets(ctx, cfg)
  if (targets.domains.length === 0 && targets.ips.length === 0) {
    return { ran: false, reason: 'no_targets' }
  }

  const resolver = opts.resolver ?? defaultResolver
  const domainLists = cfg.domainLists ?? DEFAULT_DOMAIN_DNSBL_LISTS
  const ipLists = cfg.ipLists ?? DEFAULT_IP_DNSBL_LISTS

  const pairs: Array<{
    target: string
    targetKind: DnsblTargetKind
    list: DnsblListSpec
  }> = []
  for (const d of targets.domains) {
    for (const l of domainLists) pairs.push({ target: d, targetKind: 'domain', list: l })
  }
  for (const ip of targets.ips) {
    for (const l of ipLists) pairs.push({ target: ip, targetKind: 'ip', list: l })
  }

  // Per-pair throttle: skip pairs whose existing row is fresher than the
  // interval. Force ignores the throttle. This replaces the previous
  // single-most-recent-check gate that blocked the whole suite based on
  // one stale row.
  const throttleCutoff = opts.force ? null : Date.now() - intervalHours * 60 * 60 * 1000
  let duePairs = pairs
  if (throttleCutoff != null) {
    const existing = await ctx.collections.dnsblChecks
      .find(
        {
          $or: pairs.map((p) => ({ target: p.target, list: p.list.host })),
        },
        { projection: { target: 1, list: 1, runAt: 1 } },
      )
      .toArray()
    const fresh = new Set<string>()
    for (const e of existing) {
      if (new Date(e.runAt).getTime() > throttleCutoff) {
        fresh.add(`${e.target}|${e.list}`)
      }
    }
    duePairs = pairs.filter((p) => !fresh.has(`${p.target}|${p.list.host}`))
    if (duePairs.length === 0) {
      return { ran: false, reason: 'not_due', totalChecks: 0, listedCount: 0 }
    }
  }

  let listedCount = 0

  // Bounded parallelism — DNS lookups are I/O-bound, but blasting all 25+
  // queries at once invites resolver throttling.
  async function processPair(p: typeof pairs[number]) {
    const queryName = buildQueryName(p.target, p.targetKind, p.list.host)
    const lookup = queryName
      ? await queryDnsbl(resolver, queryName)
      : { result: 'error' as DnsblResult, returnCodes: [], errorMessage: 'unsupported target format' }
    // Transient DNS failure: preserve the prior verdict so a momentary
    // resolver hiccup doesn't flip a clean target to 'error' in setup-status.
    if (lookup.transient) return
    if (lookup.result === 'listed') listedCount++
    await ctx.collections.dnsblChecks.updateOne(
      { target: p.target, list: p.list.host },
      {
        $set: {
          target: p.target,
          targetKind: p.targetKind,
          list: p.list.host,
          listLabel: p.list.label,
          result: lookup.result,
          returnCodes: lookup.returnCodes,
          errorMessage: lookup.errorMessage,
          runAt: new Date(),
        },
      },
      { upsert: true },
    )
  }

  let idx = 0
  await Promise.all(
    Array.from({ length: Math.min(DNS_CONCURRENCY, duePairs.length) }, async () => {
      while (idx < duePairs.length) {
        const my = idx++
        await processPair(duePairs[my]!)
      }
    }),
  )

  return { ran: true, totalChecks: duePairs.length, listedCount }
}

/**
 * Targets we'll check: every sender domain we know about + any explicitly
 * configured dedicated IPs. Domains come from `senderDomains` registry plus
 * the From defaults so an operator who only set fromDefaults still gets
 * coverage.
 */
function collectTargets(ctx: RunnerContext, cfg: DnsblConfig): { domains: string[]; ips: string[] } {
  const domains = new Set<string>()
  const registry = ctx.config.senderDomains
  if (registry) {
    for (const d of Object.keys(registry)) domains.add(d.toLowerCase())
  }
  const fromDomain = ctx.config.fromDefaults?.email
    ? extractDomain(ctx.config.fromDefaults.email)
    : null
  if (fromDomain) domains.add(fromDomain)
  const txnDomain = ctx.config.transactionalFromDefaults?.email
    ? extractDomain(ctx.config.transactionalFromDefaults.email)
    : null
  if (txnDomain) domains.add(txnDomain)

  // Both IPv4 and IPv6 are valid query targets — let the lookup layer handle
  // formatting per RFC 5782. Invalid strings are dropped here so they don't
  // produce a row with errorMessage='unsupported target format' on every run.
  return {
    domains: Array.from(domains),
    ips: (cfg.dedicatedIps ?? []).filter((ip) => net.isIP(ip) !== 0),
  }
}

/**
 * Compute the DNS name to query for a (target, list) pair, honoring the
 * per-list peculiarities:
 *   - IPv4: reverse octets and prepend.
 *   - IPv6: reverse nibble-by-nibble per RFC 5782.
 *   - Domain on a registrable-only list (SURBL/URIBL): collapse to eTLD+1.
 *
 * Returns null when the target shape isn't supported by the list (e.g.,
 * IPv4-only list given an IPv6 target).
 */
function buildQueryName(target: string, kind: DnsblTargetKind, listHost: string): string | null {
  if (kind === 'ip') {
    const v = net.isIP(target)
    if (v === 4) return `${reverseIPv4(target)}.${listHost}`
    if (v === 6) return `${reverseIPv6Nibbles(target)}.${listHost}`
    return null
  }
  // Domain — collapse to registrable label for lists that demand it.
  const domain = REGISTRABLE_ONLY_LISTS.has(listHost) ? registrableDomain(target) : target
  return `${domain}.${listHost}`
}

interface QueryResult {
  /** When true, the underlying DNS query failed transiently (SERVFAIL etc).
   * Caller should leave the existing row in place rather than overwrite it. */
  transient?: boolean
  result: DnsblResult
  returnCodes: string[]
  errorMessage: string | null
}

// Transient DNS errors we don't want to treat as a "list error" — these
// indicate a resolver problem or rate-limit at the block-list side and
// should be retried next tick rather than producing a setup-status warn.
const TRANSIENT_DNS_CODES = new Set(['ESERVFAIL', 'EREFUSED', 'ETIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'])

async function queryDnsbl(resolver: Resolver, query: string): Promise<QueryResult> {
  try {
    const records = await resolver.resolve4(query)
    return interpretRecords(records)
  } catch (err: any) {
    const code = err?.code
    // NXDOMAIN / no records → not listed.
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { result: 'clean', returnCodes: [], errorMessage: null }
    }
    // Transient: signal the runner to skip the upsert. Spamhaus and friends
    // SERVFAIL when rate-limiting public resolvers; storing those as 'error'
    // produces setup-status warn churn without operator-actionable signal.
    if (code && TRANSIENT_DNS_CODES.has(code)) {
      return {
        transient: true,
        result: 'error',
        returnCodes: [],
        errorMessage: String(err?.message ?? err),
      }
    }
    return {
      result: 'error',
      returnCodes: [],
      errorMessage: String(err?.message ?? err),
    }
  }
}

export function interpretRecords(records: string[]): QueryResult {
  if (!records || records.length === 0) {
    return { result: 'clean', returnCodes: [], errorMessage: null }
  }
  // Per Spamhaus convention, 127.255.255.x is reserved for query-error /
  // public-resolver / blocked-by-list signals. Treat those as errors so they
  // don't false-positive a "listed" verdict.
  const errorish = records.filter((r) => r.startsWith('127.255.255.'))
  if (errorish.length === records.length) {
    return {
      result: 'error',
      returnCodes: records,
      errorMessage: `list returned reserved code(s): ${records.join(', ')}`,
    }
  }
  const listed = records.filter((r) => r.startsWith('127.') && !r.startsWith('127.255.255.'))
  if (listed.length > 0) {
    return { result: 'listed', returnCodes: records, errorMessage: null }
  }
  return { result: 'clean', returnCodes: records, errorMessage: null }
}

export function reverseIPv4(ip: string): string {
  return ip.split('.').reverse().join('.')
}

/**
 * RFC 5782 §2.4 nibble-reversed form for IPv6. Each hex digit becomes its
 * own label in reverse order. Example:
 *   2001:db8::1
 *   → 1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2
 *
 * Handles IPv4-mapped form (`::ffff:1.2.3.4`) by converting the embedded
 * dot-octet portion into two hex groups before nibble-expanding.
 */
export function reverseIPv6Nibbles(ip: string): string {
  // First convert any embedded IPv4 ("::ffff:1.2.3.4" → "::ffff:0102:0304").
  const v4Match = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip)
  let normalized = ip
  if (v4Match) {
    const octets = v4Match[1]!.split('.').map((o) => Number(o))
    if (octets.length === 4 && octets.every((o) => o >= 0 && o <= 255)) {
      const hi = ((octets[0]! << 8) | octets[1]!).toString(16).padStart(4, '0')
      const lo = ((octets[2]! << 8) | octets[3]!).toString(16).padStart(4, '0')
      normalized = ip.slice(0, v4Match.index) + ':' + hi + ':' + lo
    }
  }

  // Expand `::` shorthand and zero-pad each group to 4 chars.
  const sides = normalized.split('::')
  let groups: string[]
  if (sides.length === 1) {
    groups = sides[0]!.split(':')
  } else {
    const left = sides[0]!.split(':').filter(Boolean)
    const right = sides[1]!.split(':').filter(Boolean)
    const missing = 8 - left.length - right.length
    groups = [...left, ...Array(missing).fill('0'), ...right]
  }
  if (groups.length !== 8) {
    throw new Error(`unexpected IPv6 group count for ${ip}: ${groups.length}`)
  }
  const padded = groups.map((g) => g.toLowerCase().padStart(4, '0')).join('')
  return padded.split('').reverse().join('.')
}

/**
 * Public Suffix List-aware eTLD+1 extraction. Required for SURBL / URIBL
 * which need the registrable domain — `mail.example.co.uk` must collapse to
 * `example.co.uk`, not `co.uk`. Falls back to the original input when PSL
 * can't classify the domain (e.g., a private TLD).
 */
function registrableDomain(domain: string): string {
  const parsed = psl.parse(domain)
  if ('domain' in parsed && parsed.domain) return parsed.domain
  return domain
}
