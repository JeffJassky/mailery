/**
 * Mail-Tester deliverability check.
 *
 *  1. Operator clicks "Run deliverability check" in the template editor.
 *  2. Mailery provisions a check (gets a unique test address from Mail-Tester).
 *  3. Mailery sends the rendered draft to that address via the operator's
 *     default provider.
 *  4. Mailery polls Mail-Tester for the score (typically arrives 10-30s after
 *     receipt) and caches it keyed on a content fingerprint.
 *  5. If the score is below `minScore` the publish endpoint refuses unless
 *     the operator passes `bypassMailTester: true` in the publish request.
 *
 * The client interface is pluggable so tests inject a stub. Real
 * implementation hits https://mail-tester.com/api/.
 */

import crypto from 'node:crypto'

import type { MailTesterConfig } from '../config.js'
import type { MailTesterFeedback, MailTesterScoreDoc } from '../models/index.js'
import type { RunnerContext } from './index.js'

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface ProvisionedCheck {
  checkId: string
  emailAddress: string
}

export interface MailTesterResult {
  ready: boolean
  score: number
  feedback: MailTesterFeedback[]
  rawSummary: string | null
}

export interface MailTesterClient {
  provisionCheck(): Promise<ProvisionedCheck>
  fetchResult(checkId: string): Promise<MailTesterResult>
}

const FETCH_TIMEOUT_MS = 15_000

export function createMailTesterClient(
  cfg: MailTesterConfig,
  fetcher: Fetcher = globalThis.fetch,
): MailTesterClient {
  const base = cfg.baseUrl ?? 'https://mail-tester.com/api'

  function sanitize(s: string): string {
    if (!cfg.apiKey) return s
    return s.split(cfg.apiKey).join('<redacted>').split(encodeURIComponent(cfg.apiKey)).join('<redacted>')
  }

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetcher(`${base}/${encodeURIComponent(cfg.apiKey)}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      })
    } catch (err: any) {
      throw new Error(`Mail-Tester ${method} ${sanitize(path)} failed: ${sanitize(String(err?.message ?? err))}`)
    } finally {
      clearTimeout(t)
    }
    if (!res.ok) {
      const text = await safeText(res)
      throw new Error(`Mail-Tester ${method} ${sanitize(path)} → ${res.status}: ${sanitize(text)}`)
    }
    return res.json()
  }

  return {
    async provisionCheck() {
      const data = await call('POST', '/new')
      const checkId = String(data.check_id ?? data.checkId ?? '')
      const emailAddress = String(data.email_address ?? data.email ?? '')
      if (!checkId || !emailAddress) throw new Error('Mail-Tester /new returned an unexpected shape')
      return { checkId, emailAddress }
    },
    async fetchResult(checkId) {
      const data = await call('GET', `/${encodeURIComponent(checkId)}`)
      // Ready is decided independently from score finiteness so a malformed
      // score number can't accidentally surface as `score: 0` and trip the
      // publish gate.
      const ready = Boolean(data.ready ?? data.complete ?? data.score != null)
      const scoreRaw = Number(data.score)
      const score = Number.isFinite(scoreRaw) ? scoreRaw : 0
      const feedback: MailTesterFeedback[] = Array.isArray(data.feedback)
        ? data.feedback.map(normalizeFeedback)
        : []
      const rawSummary = typeof data.summary === 'string' ? data.summary : null
      return { ready: ready && Number.isFinite(scoreRaw), score, feedback, rawSummary }
    },
  }
}

function normalizeFeedback(raw: any): MailTesterFeedback {
  const severity = String(raw.severity ?? 'info').toLowerCase()
  return {
    category: String(raw.category ?? 'other'),
    severity: severity === 'error' || severity === 'warning' || severity === 'info' ? severity : 'info',
    message: String(raw.message ?? ''),
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text() } catch { return '<no body>' }
}

// ---------------------------------------------------------------------------
// Content fingerprint + cache lookups
// ---------------------------------------------------------------------------

export function mailTesterContentKey(input: { bodyHash: string; subject: string; fromEmail: string }): string {
  return crypto
    .createHash('sha256')
    .update(`${input.bodyHash}|${input.subject}|${input.fromEmail}`)
    .digest('hex')
}

export async function findCachedScore(
  ctx: RunnerContext,
  contentKey: string,
): Promise<MailTesterScoreDoc | null> {
  const doc = await ctx.collections.mailTesterScores.findOne({ contentKey })
  if (!doc) return null
  if (new Date(doc.expiresAt).getTime() < Date.now()) return null
  return doc
}

export async function persistScore(
  ctx: RunnerContext,
  input: {
    templateSlug: string
    contentKey: string
    checkId: string
    result: MailTesterResult
  },
): Promise<MailTesterScoreDoc> {
  const cfg = ctx.config.mailTester
  const hours = cfg?.cacheHours ?? 24
  const now = new Date()
  const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000)
  const doc: MailTesterScoreDoc = {
    templateSlug: input.templateSlug,
    contentKey: input.contentKey,
    checkId: input.checkId,
    score: input.result.score,
    feedback: input.result.feedback,
    rawSummary: input.result.rawSummary,
    fetchedAt: now,
    expiresAt,
  }
  await ctx.collections.mailTesterScores.updateOne(
    { contentKey: input.contentKey },
    { $set: doc },
    { upsert: true },
  )
  return doc
}

// ---------------------------------------------------------------------------
// Publish gate
// ---------------------------------------------------------------------------

export interface MailTesterGateResult {
  allowed: boolean
  /** Reason for blocking. Null when allowed. */
  reason: string | null
  /** The cached score (if one exists for the content being published). */
  score: MailTesterScoreDoc | null
}

/**
 * Check whether a publish is allowed under the Mail-Tester gate. The gate
 * only blocks when:
 *   - Mail-Tester is configured AND
 *   - There exists a non-expired cached score for this exact content AND
 *   - That score is below minScore
 *
 * No cached score = silent pass. The operator must run a check explicitly;
 * we never auto-trigger one at publish time.
 */
export async function evaluateMailTesterGate(
  ctx: RunnerContext,
  input: { bodyHash: string; subject: string; fromEmail: string },
): Promise<MailTesterGateResult> {
  const cfg = ctx.config.mailTester
  if (!cfg?.apiKey) return { allowed: true, reason: null, score: null }

  const minScore = cfg.minScore ?? 8.0
  const key = mailTesterContentKey(input)
  const cached = await findCachedScore(ctx, key)
  if (!cached) return { allowed: true, reason: null, score: null }

  if (cached.score < minScore) {
    return {
      allowed: false,
      reason: `Mail-Tester score ${cached.score.toFixed(1)} is below minimum ${minScore.toFixed(1)}`,
      score: cached,
    }
  }
  return { allowed: true, reason: null, score: cached }
}
