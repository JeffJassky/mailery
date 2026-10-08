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
import { notImplemented } from './not-implemented.js'

export async function getPreferences(
  _collections: Collections,
  _categories: CategoryDef[],
  _email: string,
): Promise<PreferenceState> {
  return notImplemented('getPreferences', 'PR2')
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
  _collections: Collections,
  _categories: CategoryDef[],
  _email: string,
  _update: PreferenceUpdate,
  _opts: { source: string; now?: Date },
): Promise<PreferenceWriteResult> {
  return notImplemented('setPreferences', 'PR2')
}
