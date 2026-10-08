/**
 * Suppression checks. INVARIANT 3: re-checked at send time, never trusted
 * from enqueue time. INVARIANT 9: hashed-suppression records (GDPR forget)
 * block sends without retaining the plaintext email.
 */

import type { Collections } from '../models/index.js'
import type { SuppressionScope, TemplateKind } from '../../shared/enums.js'
import { sha256Hex } from '../tokens.js'

/**
 * The scopes that block a send (0.21 rule, INVARIANT 4 extended by 22):
 *
 *   transactional             → ['all', 'transactional']
 *   marketing, no category    → ['all', 'marketing', 'marketing_pause']
 *   marketing, category C     → ['all', 'marketing', 'marketing_pause', 'category:C']
 *
 * A category on a transactional template is ignored (publish rejects it, so
 * it only reaches here from a hand-edited document).
 *
 * `isSuppressed` and `suppressedEmails` take the template's category as an
 * optional last argument and use exactly this list — with no category they
 * behave as in 0.20.
 */
export function blockingScopes(kind: TemplateKind, category?: string | null): SuppressionScope[] {
  if (kind === 'transactional') return ['all', 'transactional']
  if (category) return ['all', 'marketing', 'marketing_pause', `category:${category}`]
  return ['all', 'marketing', 'marketing_pause']
}

export interface SuppressionResult {
  suppressed: boolean
  scope?: string
  reason?: string
  /** The matching row's expiry (a pause, a temporary suppression); null/absent when permanent. */
  expiresAt?: Date | null
}

export async function isSuppressed(
  collections: Collections,
  email: string,
  kind: TemplateKind,
  /** Template category (0.21); selects `blockingScopes(kind, category)`. */
  category?: string | null,
): Promise<SuppressionResult> {
  const normalized = email.toLowerCase()
  const allowed = blockingScopes(kind, category)

  const byEmail = await collections.suppressions.findOne({
    email: normalized,
    scope: { $in: allowed },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
  if (byEmail) return { suppressed: true, scope: byEmail.scope, reason: byEmail.reason, expiresAt: byEmail.expiresAt ?? null }

  // Every row carries emailHash, so this lookup matches plaintext rows too —
  // it must honour expiresAt as well, or a temporary suppression never lifts.
  const hashed = await collections.suppressions.findOne({
    emailHash: sha256Hex(normalized),
    scope: { $in: allowed },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
  if (hashed) return { suppressed: true, scope: hashed.scope, reason: hashed.reason, expiresAt: hashed.expiresAt ?? null }

  return { suppressed: false }
}

/**
 * `isSuppressed` for a batch: the lower-cased addresses among `emails` that
 * are suppressed for `kind`. Same two lookups, same scope and expiry rules,
 * two queries in total instead of two per address — broadcast dispatch and
 * the recipient count both use it, so they agree with each other and with
 * the send-time check.
 */
export async function suppressedEmails(
  collections: Collections,
  emails: string[],
  kind: TemplateKind,
  /** Template category (0.21). See `isSuppressed`. */
  category?: string | null,
): Promise<Set<string>> {
  const normalized = [...new Set(emails.map((e) => e.toLowerCase()))]
  if (normalized.length === 0) return new Set()
  const allowed = blockingScopes(kind, category)
  const live = { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }
  const byHash = new Map(normalized.map((e) => [sha256Hex(e), e]))
  const [plain, hashed] = await Promise.all([
    collections.suppressions.distinct('email', { email: { $in: normalized }, scope: { $in: allowed }, ...live }),
    collections.suppressions.distinct('emailHash', { emailHash: { $in: [...byHash.keys()] }, scope: { $in: allowed }, ...live }),
  ])
  const out = new Set<string>()
  for (const e of plain) if (typeof e === 'string') out.add(e)
  for (const h of hashed) {
    const e = byHash.get(String(h))
    if (e) out.add(e)
  }
  return out
}
