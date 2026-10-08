/**
 * Preference reads and writes (0.21) — plans/15-programs.md §3.2.
 *
 * A preference is the absence of an opt-out row. Opting out of a category
 * upserts a `category:<id>` suppression (reason 'unsubscribed'); opting back
 * in deletes only rows with reason 'unsubscribed' — a bounce, complaint,
 * manual or GDPR row is not the recipient's preference to reverse.
 *
 * Writes go through `applyUnsubscribe` / `clearUnsubscribeSuppressions` so the
 * preference page, one-click, the API and the journal drain share one code
 * path. A category opt-out never changes `mailer_subscriptions.status`: the
 * recipient is still subscribed to the rest of marketing.
 */

import type { CategoryDef, PreferenceState, PreferenceUpdate } from '../shared/types.js'
import type { SuppressionScope } from '../shared/enums.js'
import type { Collections } from './models/index.js'
import { sha256Hex } from './tokens.js'
import { applyUnsubscribe, clearUnsubscribeSuppressions } from './unsubscribe.js'

export async function getPreferences(
  collections: Collections,
  categories: CategoryDef[],
  email: string,
): Promise<PreferenceState> {
  const normalized = email.toLowerCase()
  // Every row carries emailHash, so one hash lookup also finds plaintext rows
  // and the hashed-only rows GDPR forget leaves behind (INVARIANT 9).
  const rows = await collections.suppressions
    .find({
      $or: [{ email: normalized }, { emailHash: sha256Hex(normalized) }],
      $and: [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }],
    })
    .project<{ scope: string }>({ scope: 1 })
    .toArray()
  const scopes = new Set(rows.map((r) => r.scope))
  const marketing = !scopes.has('all') && !scopes.has('marketing')
  const out: Record<string, boolean> = {}
  for (const c of categories) out[c.id] = marketing && !scopes.has(`category:${c.id}`)
  return { marketing, categories: out, pausedUntil: null } // pausedUntil: PR C (plans/17 F3)
}

/**
 * Pause all marketing email to `email` for `days` days (plans/17 F3): one
 * `marketing_pause` row (reason 'paused') with `expiresAt`; pausing again
 * replaces it. Never touches unsubscribe rows.
 */
export async function pauseMarketing(
  _collections: Collections,
  _email: string,
  _opts: { days: number; source: string; now?: Date },
): Promise<{ pausedUntil: Date }> {
  throw new Error('pauseMarketing: not implemented (plans/17 PR C)')
}

/** Delete the address's `marketing_pause` rows (by email or emailHash). */
export async function resumeMarketing(_collections: Collections, _email: string): Promise<{ resumed: boolean }> {
  throw new Error('resumeMarketing: not implemented (plans/17 PR C)')
}

export interface PreferenceWriteResult {
  /** Scopes newly or already opted out by this update. */
  optedOut: SuppressionScope[]
  /** Scopes whose 'unsubscribed' rows this update deleted. */
  optedIn: SuppressionScope[]
}

/**
 * Apply a preference update. `marketing: false` writes a `marketing` opt-out
 * and ignores `categories`. `marketing: true` clears `marketing`/`all`
 * opt-outs written by unsubscribes. Category ids not in `categories` throw.
 */
export async function setPreferences(
  collections: Collections,
  categories: CategoryDef[],
  email: string,
  update: PreferenceUpdate,
  opts: { source: string; now?: Date },
): Promise<PreferenceWriteResult> {
  const normalized = email.toLowerCase()
  const declared = new Set(categories.map((c) => c.id))
  const entries = Object.entries(update.categories ?? {})
  // Validate before any write: a settings write is all-or-nothing on ids.
  for (const [id] of entries) {
    if (!declared.has(id)) throw new Error(`setPreferences: category "${id}" is not declared in MailerConfig.categories`)
  }

  const optedOut: SuppressionScope[] = []
  const optedIn: SuppressionScope[] = []
  const now = opts.now ?? new Date()

  if (update.marketing === false) {
    await applyUnsubscribe(
      collections,
      { email: normalized, scope: 'marketing', reason: 'user_request', source: opts.source },
      now,
    )
    return { optedOut: ['marketing'], optedIn }
  }

  if (update.marketing === true) {
    await clearUnsubscribeSuppressions(collections, normalized, 'marketing')
    optedIn.push('marketing')
  }

  for (const [id, on] of entries) {
    const scope = `category:${id}` as const
    if (on) {
      await clearUnsubscribeSuppressions(collections, normalized, scope)
      optedIn.push(scope)
    } else {
      await applyUnsubscribe(
        collections,
        { email: normalized, scope, reason: 'user_request', source: opts.source },
        now,
      )
      optedOut.push(scope)
    }
  }
  return { optedOut, optedIn }
}
