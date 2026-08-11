/**
 * The one place an unsubscribe is written.
 *
 * Extracted from `Mailer.unsubscribe` so the tick drain
 * (`runner/pending-unsubs.ts`) can replay a journaled opt-out through exactly
 * the same two writes. A second copy of this logic is how a replayed
 * unsubscribe quietly stops matching the real one.
 *
 * Both writes are idempotent, which is what makes the drain safe to re-run:
 *   - the suppression is a `$setOnInsert` upsert keyed on (email, scope), so
 *     re-applying never rewrites `addedAt`/`source` of the original opt-out
 *   - the subscription update is a `$set` to a terminal state
 */

import type { Collections } from './models/index.js'
import type { UnsubscribeInput } from '../shared/schemas.js'
import { sha256Hex } from './tokens.js'

/**
 * Apply an unsubscribe: suppression row + subscription status.
 *
 * `input` must already be parsed by `unsubscribeInputSchema` — the caller owns
 * validation so this stays a pure write.
 */
export async function applyUnsubscribe(
  collections: Collections,
  input: UnsubscribeInput,
  now: Date = new Date(),
): Promise<void> {
  const normalized = input.email

  await collections.suppressions.updateOne(
    { email: normalized, scope: input.scope },
    {
      $setOnInsert: {
        email: normalized,
        emailHash: sha256Hex(normalized),
        scope: input.scope,
        // mailer_suppressions canonical reason — see plans/02-data-model.md.
        reason: 'unsubscribed' as const,
        source: input.source,
        notes: input.notes ?? null,
        addedAt: now,
        expiresAt: null,
      },
    },
    { upsert: true },
  )

  await collections.subscriptions.updateOne(
    { emailAtSubscribe: normalized },
    {
      $set: {
        status: 'unsubscribed' as const,
        unsubscribedAt: now,
        unsubscribeReason: input.reason,
        updatedAt: now,
      },
    },
  )
}
