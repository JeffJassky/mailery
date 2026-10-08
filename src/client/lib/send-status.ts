/** Contact-policy wording for a send row (0.21). */

const REASONS: Record<string, string> = {
  min_gap: 'minimum gap since the last email',
  rolling_cap: 'rolling send cap reached',
  quiet_hours: 'quiet hours',
  blackout: 'blackout dates',
  priority: 'a higher-priority email is due first',
}

/** "quiet hours · until 3/2/2027, 8:00 AM" for a deferred send; the exit reason for a cancelled one; else ''. */
export function sendStatusNote(s: any): string {
  if (!s) return ''
  if (s.status === 'deferred') {
    const why = REASONS[s.policyDeferral?.reason] ?? s.policyDeferral?.reason ?? 'contact policy'
    const until = s.notBefore ? ` · until ${new Date(s.notBefore).toLocaleString()}` : ''
    const times = (s.policyDeferral?.count ?? 0) > 1 ? ` · deferred ${s.policyDeferral.count}×` : ''
    return `${why}${until}${times}`
  }
  if (s.status === 'cancelled' && s.exitReason) return String(s.exitReason).replace(/_/g, ' ')
  return ''
}
