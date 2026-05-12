/**
 * Suppression checks. INVARIANT 3: re-checked at send time, never trusted
 * from enqueue time. INVARIANT 9: hashed-suppression records (GDPR forget)
 * block sends without retaining the plaintext email.
 */

import type { Collections } from '../models/index.js'
import type { SuppressionScope, TemplateKind } from '../../shared/enums.js'
import { sha256Hex } from '../tokens.js'

export interface SuppressionResult {
  suppressed: boolean
  scope?: string
  reason?: string
}

const SCOPES_BY_KIND: Record<TemplateKind, SuppressionScope[]> = {
  marketing: ['all', 'marketing'],
  transactional: ['all', 'transactional'],
}

export async function isSuppressed(
  collections: Collections,
  email: string,
  kind: TemplateKind,
): Promise<SuppressionResult> {
  const normalized = email.toLowerCase()
  const allowed = SCOPES_BY_KIND[kind]

  const byEmail = await collections.suppressions.findOne({
    email: normalized,
    scope: { $in: allowed },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
  if (byEmail) return { suppressed: true, scope: byEmail.scope, reason: byEmail.reason }

  const hashed = await collections.suppressions.findOne({
    emailHash: sha256Hex(normalized),
    scope: { $in: allowed },
  })
  if (hashed) return { suppressed: true, scope: hashed.scope, reason: hashed.reason }

  return { suppressed: false }
}
