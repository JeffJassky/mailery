/**
 * DMARC DNS verification and reverse DNS. Spec: plans/18-dmarc-monitoring.md §7.
 */

import { Resolver } from 'node:dns/promises'

import psl from 'psl'

import type {
  DmarcDnsCheckResult,
  DmarcDnsIssue,
  DmarcDnsResolver,
  DmarcPolicy,
  ParsedDmarcRecord,
} from '../../shared/dmarc-types.js'

// Bounded so a dead resolver cannot hold up the runner tick that calls this.
const systemResolver = new Resolver({ timeout: 3000, tries: 2 })

export const defaultDmarcDnsResolver: DmarcDnsResolver = {
  resolveTxt: (host) => systemResolver.resolveTxt(host),
  resolveMx: (host) => systemResolver.resolveMx(host),
  reverse: (ip) => systemResolver.reverse(ip),
}

/** Registrable domain via `psl`: `news.example.co.uk` → `example.co.uk`. Lowercased. */
export function organizationalDomain(domain: string): string {
  const d = domain.toLowerCase()
  return psl.get(d) ?? d
}

const POLICIES: readonly string[] = ['none', 'quarantine', 'reject']
const DMARC_RE = /^v=DMARC1\s*(;|$)/i
const NO_RECORDS = new Set(['ENOTFOUND', 'ENODATA'])

function parseAddresses(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((a) => a.trim().replace(/^mailto:/i, '').replace(/![^!]*$/, '').trim().toLowerCase())
    .filter((a) => a.length > 0)
}

function alignment(value: string | undefined): 'r' | 's' | null {
  return value === 'r' || value === 's' ? value : null
}

export function parseDmarcRecord(raw: string): ParsedDmarcRecord {
  const tags = new Map<string, string>()
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    if (!key || tags.has(key)) continue
    tags.set(key, part.slice(eq + 1).trim())
  }
  const lower = (k: string) => tags.get(k)?.toLowerCase()
  const policyOf = (v: string | undefined): DmarcPolicy | null =>
    v !== undefined && POLICIES.includes(v) ? (v as DmarcPolicy) : null
  const policy = policyOf(lower('p'))
  const pctRaw = tags.get('pct')
  const pctNum = pctRaw !== undefined && /^\d+$/.test(pctRaw) ? Number(pctRaw) : null
  return {
    valid: policy !== null,
    policy,
    subdomainPolicy: policyOf(lower('sp')),
    pct: pctNum !== null && pctNum <= 100 ? pctNum : null,
    rua: parseAddresses(tags.get('rua')),
    ruf: parseAddresses(tags.get('ruf')),
    adkim: alignment(lower('adkim')),
    aspf: alignment(lower('aspf')),
  }
}

export interface CheckDmarcDnsOptions {
  resolver?: DmarcDnsResolver
  reportAddress?: string | null
  now?: Date
  /** The organizational domain is itself monitored, so an inherited record is reported there. */
  orgDomainInSet?: boolean
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

function fillDmarc(result: DmarcDnsCheckResult, records: string[]): ParsedDmarcRecord {
  const parsed = parseDmarcRecord(records[0]!)
  const { valid: _valid, ...fields } = parsed
  result.dmarc = { ...result.dmarc, found: true, raw: records, ...fields }
  return parsed
}

export async function checkDmarcDns(domain: string, opts: CheckDmarcDnsOptions = {}): Promise<DmarcDnsCheckResult> {
  const resolver = opts.resolver ?? defaultDmarcDnsResolver
  const issues: DmarcDnsIssue[] = []
  const org = organizationalDomain(domain)
  const reportAddress = opts.reportAddress ? opts.reportAddress.toLowerCase() : null

  const lookupFailed = (what: string, err: unknown) =>
    issues.push({
      code: 'lookup_failed',
      severity: 'warning',
      message: `DNS lookup for ${what} failed (${errorCode(err)}); the checks that depend on it were skipped.`,
      fix: null,
    })

  /** `null` = the lookup failed (already reported); `[]` = no records. */
  const txt = async (host: string): Promise<string[] | null> => {
    try {
      return (await resolver.resolveTxt(host)).map((chunks) => chunks.join(''))
    } catch (err) {
      if (NO_RECORDS.has(errorCode(err))) return []
      lookupFailed(`TXT ${host}`, err)
      return null
    }
  }

  const result: DmarcDnsCheckResult = {
    domain,
    checkedAt: opts.now ?? new Date(),
    inheritedFrom: null,
    dmarc: {
      host: `_dmarc.${domain}`,
      found: false,
      raw: [],
      policy: null,
      subdomainPolicy: null,
      pct: null,
      rua: [],
      ruf: [],
      adkim: null,
      aspf: null,
    },
    externalAuth: [],
    ruaMx: [],
    spf: { found: false, raw: [], all: null },
    issues,
    ok: true,
  }
  const finish = (): DmarcDnsCheckResult => {
    result.ok = !issues.some((i) => i.severity === 'error')
    return result
  }

  const noMx = (ruaDomain: string) =>
    issues.push({
      code: 'rua_domain_no_mx',
      severity: 'error',
      message: `${ruaDomain} has no MX record, so it cannot receive reports.`,
      fix: null,
    })

  const checkRua = async (rua: string[]): Promise<void> => {
    if (rua.length === 0) {
      issues.push({
        code: 'rua_missing',
        severity: 'error',
        message: 'The DMARC record has no rua= tag, so no aggregate reports are being sent.',
        fix: null,
      })
    } else if (reportAddress && !rua.includes(reportAddress)) {
      issues.push({
        code: 'rua_missing_report_address',
        severity: 'warning',
        message: `rua= does not include ${opts.reportAddress}, so reports will not reach this monitor.`,
        fix: null,
      })
    }

    const policyDomain = result.inheritedFrom ?? domain
    const seen = new Set<string>()
    for (const ruaAddress of rua) {
      const ruaDomain = ruaAddress.slice(ruaAddress.lastIndexOf('@') + 1)
      if (!ruaDomain) continue
      if (organizationalDomain(ruaDomain) !== org) {
        const host = `${policyDomain}._report._dmarc.${ruaDomain}`
        const auth = await txt(host)
        if (auth !== null) {
          const authorized = auth.some((r) => DMARC_RE.test(r))
          result.externalAuth.push({ ruaAddress, ruaDomain, host, authorized })
          if (!authorized) {
            issues.push({
              code: 'external_auth_missing',
              severity: 'error',
              message: `${ruaDomain} has not authorized ${policyDomain} to send it reports; receivers will drop them.`,
              fix: { host, type: 'TXT', value: 'v=DMARC1' },
            })
          }
        }
      }
      if (seen.has(ruaDomain)) continue
      seen.add(ruaDomain)
      try {
        const mx = (await resolver.resolveMx(ruaDomain)).map((m) => m.exchange.toLowerCase().replace(/\.$/, ''))
        result.ruaMx.push({ ruaDomain, mx, sendgridInbound: mx.some((e) => e.endsWith('sendgrid.net')) })
        if (mx.length === 0) noMx(ruaDomain)
      } catch (err) {
        if (NO_RECORDS.has(errorCode(err))) {
          result.ruaMx.push({ ruaDomain, mx: [], sendgridInbound: false })
          noMx(ruaDomain)
        } else {
          lookupFailed(`MX ${ruaDomain}`, err)
        }
      }
    }
  }

  const own = await txt(`_dmarc.${domain}`)
  let records = own?.filter((r) => DMARC_RE.test(r)) ?? []
  let orgLookupFailed = false
  if (own !== null && records.length === 0 && domain !== org) {
    // A failed subdomain lookup (own === null) deliberately skips this fall-through.
    const inherited = await txt(`_dmarc.${org}`)
    orgLookupFailed = inherited === null
    const found = inherited?.filter((r) => DMARC_RE.test(r)) ?? []
    if (found.length > 0) {
      records = found
      result.inheritedFrom = org
      result.dmarc.host = `_dmarc.${org}`
      issues.push({
        code: 'inherits_org_policy',
        severity: 'info',
        message: `${domain} has no DMARC record of its own and inherits the policy published at _dmarc.${org}.`,
        fix: null,
      })
      if (opts.orgDomainInSet) {
        fillDmarc(result, records)
        return finish()
      }
    }
  }

  if (own !== null && records.length === 0 && !orgLookupFailed) {
    issues.push({
      code: 'dmarc_missing',
      severity: 'error',
      message: `No DMARC record at _dmarc.${domain}.`,
      fix: {
        host: `_dmarc.${domain}`,
        type: 'TXT',
        value: `v=DMARC1; p=none; rua=mailto:${opts.reportAddress ?? 'you@example.com'}`,
      },
    })
  } else if (records.length > 1) {
    result.dmarc.found = true
    result.dmarc.raw = records
    issues.push({
      code: 'dmarc_multiple',
      severity: 'error',
      message: 'More than one DMARC record is published; receivers ignore DMARC entirely.',
      fix: null,
    })
  } else if (records.length === 1) {
    const parsed = fillDmarc(result, records)
    if (!parsed.valid) {
      issues.push({
        code: 'dmarc_invalid',
        severity: 'error',
        message: 'The DMARC record has no valid p= tag (none, quarantine or reject).',
        fix: null,
      })
    }
    await checkRua(parsed.rua)
  }

  const spfTxt = await txt(domain)
  if (spfTxt !== null) {
    const raw = spfTxt.filter((r) => /^v=spf1(\s|$)/i.test(r))
    const tokens = raw[0]?.split(/\s+/) ?? []
    const all = raw.length === 1 ? ([...tokens].reverse().find((t) => /^[+?~-]?all$/i.test(t)) ?? null) : null
    result.spf = { found: raw.length > 0, raw, all }
    if (raw.length === 0) {
      issues.push({ code: 'spf_missing', severity: 'warning', message: `No SPF record at ${domain}.`, fix: null })
    } else if (raw.length > 1) {
      issues.push({
        code: 'spf_multiple',
        severity: 'error',
        message: 'More than one SPF record is published; SPF evaluation fails with a permanent error.',
        fix: null,
      })
    } else if (all) {
      const a = all.toLowerCase()
      if (a === '+all' || a === 'all') {
        issues.push({
          code: 'spf_permissive',
          severity: 'error',
          message: `SPF ends in ${all}, which authorizes every sender on the internet.`,
          fix: null,
        })
      } else if (a === '?all') {
        issues.push({
          code: 'spf_permissive',
          severity: 'warning',
          message: 'SPF ends in ?all (neutral), which never fails any sender.',
          fix: null,
        })
      }
    }
  }

  if (result.dmarc.policy === 'none') {
    issues.push({
      code: 'policy_none',
      severity: 'info',
      message: 'Policy is p=none (monitor only); spoofed mail is still delivered.',
      fix: null,
    })
  }
  if (result.dmarc.pct !== null && result.dmarc.pct < 100) {
    issues.push({
      code: 'pct_partial',
      severity: 'info',
      message: `The policy applies to only ${result.dmarc.pct}% of failing mail.`,
      fix: null,
    })
  }
  return finish()
}

export interface LookupPtrOptions {
  resolver?: DmarcDnsResolver
  timeoutMs?: number
  concurrency?: number
}

const PTR_TTL_MS = 24 * 60 * 60 * 1000
const PTR_MAX_ENTRIES = 1000
const ptrCache = new Map<string, { value: string | null; at: number }>()

function cachePtr(ip: string, value: string | null): void {
  ptrCache.delete(ip)
  ptrCache.set(ip, { value, at: Date.now() })
  while (ptrCache.size > PTR_MAX_ENTRIES) {
    const oldest = ptrCache.keys().next().value
    if (oldest === undefined) break
    ptrCache.delete(oldest)
  }
}

export async function lookupPtr(ips: string[], opts: LookupPtrOptions = {}): Promise<Map<string, string | null>> {
  const resolver = opts.resolver ?? defaultDmarcDnsResolver
  const timeoutMs = opts.timeoutMs ?? 2000
  const concurrency = Math.max(1, opts.concurrency ?? 8)
  const out = new Map<string, string | null>()
  const pending: string[] = []
  const now = Date.now()
  for (const ip of new Set(ips)) {
    const hit = ptrCache.get(ip)
    if (hit && now - hit.at < PTR_TTL_MS) out.set(ip, hit.value)
    else pending.push(ip)
  }

  const one = async (ip: string): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), timeoutMs)
      })
      const names = await Promise.race([resolver.reverse(ip), timeout])
      const value = names[0]?.trim().replace(/\.$/, '').toLowerCase() || null
      out.set(ip, value)
      cachePtr(ip, value)
    } catch (err) {
      out.set(ip, null)
      // Only a definitive "no PTR" is worth remembering; timeouts and SERVFAILs are transient.
      if (NO_RECORDS.has(errorCode(err))) cachePtr(ip, null)
    } finally {
      clearTimeout(timer)
    }
  }

  let next = 0
  const worker = async (): Promise<void> => {
    while (next < pending.length) await one(pending[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
  return out
}

export function _clearPtrCache(): void {
  ptrCache.clear()
}
