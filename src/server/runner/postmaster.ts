/**
 * Google Postmaster Tools API client + daily puller.
 *
 *  - Exchanges the operator-provided OAuth refresh token for short-lived
 *    access tokens (cached until ~5 minutes before expiry).
 *  - Pulls per-domain TrafficStats for each registered sender domain.
 *  - Persists one PostmasterSnapshot per (domain, day).
 *  - When a snapshot reports `domainReputation: 'BAD'`, trips the
 *    (domain × marketing) health bucket so the runner stops dispatching
 *    marketing mail from that domain.
 *
 * Setup is one-time and external — operator creates an OAuth client in their
 * own Google Cloud project, performs the consent flow, and configures the
 * refresh token in MailerConfig.postmaster.
 */

import type { PostmasterConfig } from '../config.js'
import type {
  PostmasterReputation,
  PostmasterSnapshotDoc,
} from '../models/index.js'
import { extractDomain } from '../templates/sender-domain.js'
import type { RunnerContext } from './index.js'
import { healthBucketId } from '../models/index.js'

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const POSTMASTER_BASE = 'https://gmailpostmastertools.googleapis.com/v1'
const FETCH_TIMEOUT_MS = 15_000

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

async function fetchWithTimeout(fetcher: Fetcher, url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetcher(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

export interface PostmasterClient {
  listDomains(): Promise<Array<{ name: string; createTime?: string }>>
  getLatestTrafficStats(domain: string): Promise<TrafficStat | null>
}

interface OAuthResponse {
  access_token: string
  expires_in: number
  scope?: string
  token_type?: string
}

export interface TrafficStat {
  /** Resource name, e.g. `domains/example.com/trafficStats/20240101`. */
  name: string
  domainReputation?: PostmasterReputation
  ipReputations?: Array<{ reputation: PostmasterReputation; ipCount: string | number }>
  userReportedSpamRatio?: number
  spfSuccessRatio?: number
  dkimSuccessRatio?: number
  dmarcSuccessRatio?: number
  inboundEncryptionRatio?: number
  outboundEncryptionRatio?: number
  deliveryErrors?: Array<{ errorType: string; errorClass: string; errorRatio: number }>
  spammyFeedbackLoops?: Array<{ id: string; spamRatio: number }>
}

export function createPostmasterClient(
  cfg: Pick<PostmasterConfig, 'clientId' | 'clientSecret' | 'refreshToken'>,
  fetcher: Fetcher = globalThis.fetch,
): PostmasterClient {
  let cached: { accessToken: string; expiresAt: number } | null = null

  async function getAccessToken(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cached.accessToken
    }
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: 'refresh_token',
    })
    const res = await fetchWithTimeout(fetcher, OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) {
      throw new Error(`Postmaster OAuth token refresh failed: ${res.status} ${await safeText(res)}`)
    }
    const data = (await res.json()) as OAuthResponse
    cached = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    }
    return cached.accessToken
  }

  async function authedGet<T>(path: string): Promise<T> {
    const token = await getAccessToken()
    const res = await fetchWithTimeout(fetcher, `${POSTMASTER_BASE}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(`Postmaster GET ${path} failed: ${res.status} ${await safeText(res)}`)
    }
    return (await res.json()) as T
  }

  return {
    async listDomains() {
      const data = await authedGet<{ domains?: Array<{ name: string; createTime?: string }> }>('/domains')
      return data.domains ?? []
    },

    async getLatestTrafficStats(domain: string) {
      // Postmaster traffic stats are reported with a ~2-day delay. Pull the
      // most recent available; the API returns them in reverse-chronological
      // order when no date range is specified.
      const data = await authedGet<{ trafficStats?: TrafficStat[] }>(
        `/domains/${encodeURIComponent(domain)}/trafficStats?pageSize=1`,
      )
      return data.trafficStats?.[0] ?? null
    },
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return '<no body>'
  }
}

// ---------------------------------------------------------------------------
// Puller
// ---------------------------------------------------------------------------

export interface RunPostmasterOptions {
  client?: PostmasterClient
  fetcher?: Fetcher
  force?: boolean
}

export interface RunPostmasterResult {
  ran: boolean
  reason?: string
  fetched?: number
  trippedDomains?: string[]
}

export async function runPostmasterPull(
  ctx: RunnerContext,
  opts: RunPostmasterOptions = {},
): Promise<RunPostmasterResult> {
  const cfg = ctx.config.postmaster
  if (!cfg) return { ran: false, reason: 'not_configured' }

  const intervalHours = cfg.intervalHours ?? 24
  if (!opts.force && intervalHours <= 0) {
    return { ran: false, reason: 'disabled' }
  }

  const client =
    opts.client ?? createPostmasterClient(cfg, opts.fetcher)
  const allDomains = resolveDomains(ctx, cfg)
  if (allDomains.length === 0) {
    return { ran: false, reason: 'no_domains' }
  }

  // Per-domain throttle — fetch only domains whose latest snapshot is
  // older than intervalHours. Previously a single global timestamp across
  // all domains locked unfetched / partially-failed domains out of the
  // next run for a full window.
  let domains = allDomains
  if (!opts.force) {
    const cutoff = Date.now() - intervalHours * 60 * 60 * 1000
    const latest = await ctx.collections.postmasterSnapshots
      .find({ domain: { $in: allDomains } }, { projection: { domain: 1, fetchedAt: 1 } })
      .sort({ fetchedAt: -1 })
      .limit(allDomains.length * 8)
      .toArray()
    const lastByDomain = new Map<string, number>()
    for (const s of latest) {
      const ts = new Date(s.fetchedAt).getTime()
      const cur = lastByDomain.get(s.domain) ?? 0
      if (ts > cur) lastByDomain.set(s.domain, ts)
    }
    domains = allDomains.filter((d) => (lastByDomain.get(d) ?? 0) < cutoff)
    if (domains.length === 0) {
      return { ran: false, reason: 'not_due' }
    }
  }

  // Fetch all domains in parallel — they're independent HTTP calls and
  // serial ordering only multiplies tick latency.
  const fetches = await Promise.all(
    domains.map(async (domain) => {
      try {
        const stat = await client.getLatestTrafficStats(domain)
        return { domain, stat, error: null as Error | null }
      } catch (err: any) {
        console.error(`mailery: postmaster fetch failed for ${domain}`, err)
        return { domain, stat: null, error: err as Error }
      }
    }),
  )

  let fetched = 0
  const trippedDomains: string[] = []
  for (const { domain, stat } of fetches) {
    if (!stat) continue
    const snapshot = toSnapshot(domain, stat)
    if (!snapshot) continue
    fetched++

    await ctx.collections.postmasterSnapshots.updateOne(
      { domain: snapshot.domain, date: snapshot.date },
      { $set: snapshot },
      { upsert: true },
    )

    if (snapshot.domainReputation === 'BAD') {
      // Trip every kind the registry says this domain is allowed to send
      // as. If the registry doesn't know this domain at all, skip the
      // auto-trip — we have no signal that the operator wants this domain
      // gated by mailery.
      const kindsToTrip = kindsForDomain(ctx, domain)
      for (const kind of kindsToTrip) {
        const tripped = await tripBucket(ctx, domain, kind, snapshot)
        if (tripped) trippedDomains.push(`${domain}|${kind}`)
      }
    }
  }

  return { ran: true, fetched, trippedDomains }
}

function kindsForDomain(ctx: RunnerContext, domain: string): Array<'marketing' | 'transactional'> {
  const registry = ctx.config.senderDomains ?? {}
  const entry = registry[domain.toLowerCase()]
  if (!entry) return []
  if (entry.kind === 'both') return ['marketing', 'transactional']
  return [entry.kind]
}

function resolveDomains(ctx: RunnerContext, cfg: PostmasterConfig): string[] {
  if (cfg.domains && cfg.domains.length > 0) {
    return cfg.domains.map((d) => d.toLowerCase())
  }
  const out = new Set<string>()
  const registry = ctx.config.senderDomains
  if (registry) {
    for (const d of Object.keys(registry)) out.add(d.toLowerCase())
  }
  const f = ctx.config.fromDefaults?.email ? extractDomain(ctx.config.fromDefaults.email) : null
  if (f) out.add(f)
  const t = ctx.config.transactionalFromDefaults?.email
    ? extractDomain(ctx.config.transactionalFromDefaults.email)
    : null
  if (t) out.add(t)
  return Array.from(out)
}

function toSnapshot(domain: string, stat: TrafficStat): PostmasterSnapshotDoc | null {
  // `name` looks like `domains/example.com/trafficStats/20240115`. Bail out
  // when the format isn't recognized rather than overwriting today's snapshot
  // every run — the previous fallback to today's UTC date silently rewrote
  // legitimate data when the API format ever drifted.
  const m = /\/trafficStats\/(\d{8})$/.exec(stat.name ?? '')
  if (!m) {
    console.error(`mailery: postmaster snapshot for ${domain} has unrecognized name "${stat.name}" — skipping`)
    return null
  }
  const yyyymmdd = m[1]!
  const date = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`

  return {
    domain,
    date,
    domainReputation: stat.domainReputation ?? null,
    ipReputations: stat.ipReputations
      ? stat.ipReputations.map((r) => ({
          reputation: r.reputation,
          ipCount: typeof r.ipCount === 'string' ? Number(r.ipCount) : r.ipCount,
        }))
      : null,
    userReportedSpamRatio: stat.userReportedSpamRatio ?? null,
    spfSuccessRatio: stat.spfSuccessRatio ?? null,
    dkimSuccessRatio: stat.dkimSuccessRatio ?? null,
    dmarcSuccessRatio: stat.dmarcSuccessRatio ?? null,
    outboundEncryptionRatio: stat.outboundEncryptionRatio ?? null,
    inboundEncryptionRatio: stat.inboundEncryptionRatio ?? null,
    deliveryErrors: stat.deliveryErrors ?? null,
    spammyFeedbackLoops: stat.spammyFeedbackLoops ?? null,
    fetchedAt: new Date(),
  }
}

/**
 * Set a (domain × kind) bucket to `tripped` so the dispatcher holds matching
 * sends. The bucket is created on demand if it doesn't exist yet — Postmaster
 * can flag a domain before mailery has ever sent from it.
 */
async function tripBucket(
  ctx: RunnerContext,
  domain: string,
  kind: 'marketing' | 'transactional',
  snapshot: PostmasterSnapshotDoc,
): Promise<boolean> {
  const id = healthBucketId(domain, kind)
  const reason = `Postmaster Tools reports ${domain} reputation = BAD on ${snapshot.date}`

  // Only update + alert when the bucket transitions to tripped — otherwise a
  // sustained BAD reputation would fire onCircuitBreakerTrip on every pull.
  const prior = await ctx.collections.health.findOne({ _id: id })
  if (prior?.status === 'tripped') {
    return false
  }

  await ctx.collections.health.updateOne(
    { _id: id },
    {
      $set: {
        status: 'tripped',
        trippedAt: new Date(),
        trippedReason: reason,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        _id: id,
        senderDomain: domain,
        kind,
        windowStartedAt: new Date(),
        windowDurationMs: ctx.config.circuitBreaker.windowMinutes * 60 * 1000,
        manuallyResumedAt: null,
        counters: { sent: 0, delivered: 0, bounced: 0, hardBounced: 0, softBounced: 0, complained: 0, failedToSend: 0 },
        rates: { bounceRate: 0, hardBounceRate: 0, complaintRate: 0, failureRate: 0 },
      },
    },
    { upsert: true },
  )
  if (ctx.config.onCircuitBreakerTrip) {
    try {
      await ctx.config.onCircuitBreakerTrip({ reason, rates: { userReportedSpamRatio: snapshot.userReportedSpamRatio ?? 0 } })
    } catch {
      /* swallow */
    }
  }
  return true
}
