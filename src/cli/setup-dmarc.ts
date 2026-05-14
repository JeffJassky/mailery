/**
 * `mailery setup-dmarc` — publish a DMARC policy record for a domain.
 *
 *   npx mailery setup-dmarc \
 *     --domain news.example.com \
 *     --rua-mailbox dmarc-reports@example.com \
 *     --policy none \
 *     --cloudflare
 *
 * What it does:
 *   1. Build the DMARC TXT record string (RFC 7489).
 *   2. If `--cloudflare`, publish it as a TXT record at `_dmarc.<domain>`.
 *      Otherwise print the record so the operator can publish manually.
 *   3. Idempotent — re-running with the same inputs is a no-op.
 *
 * Why default to `p=none`:
 *   Tightening straight to `p=quarantine` or `p=reject` without monitoring
 *   first can drop legitimate mail you didn't know about (SaaS tools sending
 *   as you, etc). The recommended progression is none → quarantine → reject.
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN — only if --cloudflare; needs Zone:Read + DNS:Edit
 */

import { cloudflareClient, inferZone } from './cloudflare.js'

export type DmarcPolicy = 'none' | 'quarantine' | 'reject'

export interface SetupDmarcOpts {
  /** Domain to publish DMARC for, e.g. `'news.example.com'`. */
  domain: string
  /** RUA aggregate-report mailbox, e.g. `'dmarc-reports@example.com'`. */
  ruaMailbox: string
  /** Forensic-report mailbox (RUF). Most operators leave this unset. */
  rufMailbox?: string
  /** DMARC enforcement policy. Default 'none' (monitor only). */
  policy?: DmarcPolicy
  /** Percent of failing mail subject to the policy (1-100). Default 100. */
  pct?: number
  /** SPF alignment mode: 'r' (relaxed, default) or 's' (strict). */
  aspf?: 'r' | 's'
  /** DKIM alignment mode: 'r' (relaxed, default) or 's' (strict). */
  adkim?: 'r' | 's'
  /** Publish via Cloudflare API. Otherwise prints DNS instructions. */
  cloudflare?: boolean
  /** Override the parent zone when --cloudflare is set. */
  cloudflareZone?: string
  logger?: { log?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
  fetchFn?: typeof fetch
  env?: Record<string, string | undefined>
}

export interface SetupDmarcResult {
  domain: string
  /** The full TXT record value. */
  recordValue: string
  /** The DNS host the record is published at, e.g. `_dmarc.news.example.com`. */
  recordHost: string
  /** Whether DNS was actually pushed (vs printed for manual publish). */
  cloudflarePushed: 'created' | 'updated' | 'noop' | 'skipped'
}

export async function setupDmarc(opts: SetupDmarcOpts): Promise<SetupDmarcResult> {
  const env = opts.env ?? process.env
  const log = opts.logger ?? console
  const info = (m: string) => log.log?.(m)
  const warn = (m: string) => log.warn?.(m)
  const f = opts.fetchFn ?? globalThis.fetch

  if (!opts.domain) throw new Error('--domain is required')
  if (!opts.ruaMailbox) throw new Error('--rua-mailbox is required (RUA aggregate-report mailbox)')
  // RFC 7489 allows a comma-separated list of mailboxes (e.g. for parallel
  // ingest to a primary and a backup mailbox). Validate each address.
  const ruaMailboxes = opts.ruaMailbox.split(',').map((s) => s.trim()).filter(Boolean)
  for (const m of ruaMailboxes) {
    if (!isValidEmail(m)) throw new Error(`--rua-mailbox is not a valid email: ${m}`)
  }
  if (opts.rufMailbox && !isValidEmail(opts.rufMailbox)) {
    throw new Error(`--ruf-mailbox is not a valid email: ${opts.rufMailbox}`)
  }

  const pct = opts.pct ?? 100
  if (pct < 1 || pct > 100) throw new Error('--pct must be between 1 and 100')

  if (opts.cloudflare && !env.CLOUDFLARE_API_TOKEN) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN env var is required when --cloudflare is set.\n' +
        '  Create one at: https://dash.cloudflare.com/profile/api-tokens\n' +
        '  Needs: Zone:Read + DNS:Edit on the zone you\'re publishing into.',
    )
  }

  const recordValue = buildDmarcRecord({
    policy: opts.policy ?? 'none',
    rua: ruaMailboxes.join(','),
    ruf: opts.rufMailbox,
    pct,
    aspf: opts.aspf ?? 'r',
    adkim: opts.adkim ?? 'r',
  })

  const recordHost = `_dmarc.${opts.domain}`

  info('')
  info(`=== ${opts.domain} ===`)
  info(`DMARC record:`)
  info(`  ${recordHost} TXT "${recordValue}"`)

  let cloudflarePushed: SetupDmarcResult['cloudflarePushed'] = 'skipped'

  if (opts.cloudflare) {
    const cf = cloudflareClient(env.CLOUDFLARE_API_TOKEN!, f)
    const zoneName = opts.cloudflareZone ?? inferZone(opts.domain)
    const zoneId = await cf.findZoneId(zoneName)
    if (!zoneId) {
      throw new Error(
        `Cloudflare zone "${zoneName}" not found. ` +
          `Either the token doesn't have access, or the zone isn't on Cloudflare. ` +
          `Pass --cloudflare-zone <zone> if the zone name differs from the eTLD+1.`,
      )
    }
    cloudflarePushed = await cf.upsertRecord(zoneId, { type: 'TXT', host: recordHost, data: recordValue })
    info(`Cloudflare ${cloudflarePushed}: ${recordHost} TXT`)
  } else {
    info('')
    info('— skipping Cloudflare publish (no --cloudflare). Add this record to your DNS provider:')
    info(`    Host: ${recordHost}`)
    info(`    Type: TXT`)
    info(`    Value: ${recordValue}`)
  }

  if ((opts.policy ?? 'none') === 'none') {
    info('')
    info('Recommended next steps:')
    info('  1. Wait 1-2 weeks while RUA reports arrive at ' + opts.ruaMailbox)
    info('  2. Upload reports to mailery (Health → DMARC RUA reports → Upload)')
    info('  3. Tag known sources in the admin UI so untagged senders surface')
    info('  4. Once all your legitimate sources align, tighten to p=quarantine pct=10, then ramp pct, then p=reject')
  }
  if ((opts.policy ?? 'none') !== 'none' && (opts.pct ?? 100) === 100) {
    warn('')
    warn('You are publishing a non-monitor policy at pct=100. If any of your legitimate sending sources are not')
    warn('yet fully aligned, mail will be quarantined or rejected starting immediately. Consider --pct 10 first.')
  }

  return { domain: opts.domain, recordValue, recordHost, cloudflarePushed }
}

// ---------------------------------------------------------------------------
// Record builder
// ---------------------------------------------------------------------------

export interface BuildDmarcRecordOpts {
  policy: DmarcPolicy
  rua: string
  ruf?: string
  pct: number
  aspf: 'r' | 's'
  adkim: 'r' | 's'
}

export function buildDmarcRecord(opts: BuildDmarcRecordOpts): string {
  // RFC 7489 allows a comma-separated list of `mailto:` URIs in rua / ruf.
  const ruaList = opts.rua.split(',').map((m) => `mailto:${m.trim()}`).filter((m) => m !== 'mailto:').join(',')
  const parts: string[] = [
    'v=DMARC1',
    `p=${opts.policy}`,
    `rua=${ruaList}`,
  ]
  if (opts.ruf) {
    const rufList = opts.ruf.split(',').map((m) => `mailto:${m.trim()}`).filter((m) => m !== 'mailto:').join(',')
    parts.push(`ruf=${rufList}`)
  }
  if (opts.pct !== 100) parts.push(`pct=${opts.pct}`)
  if (opts.aspf !== 'r') parts.push(`aspf=${opts.aspf}`)
  if (opts.adkim !== 'r') parts.push(`adkim=${opts.adkim}`)
  return parts.join('; ')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}
