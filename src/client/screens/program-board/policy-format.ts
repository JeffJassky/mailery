/** Policy chips: icon + short value, tooltip carries label and the full value. */
import type { ProgramDefinition, RecipientRule } from '../../../shared/types'

export type ChipKey = 'gap' | 'window' | 'quiet' | 'sunset' | 'holdout' | 'recipients' | 'entry' | 'exit' | 'complete'
export type ChipIcon = 'Clock' | 'Calendar' | 'Moon' | 'Sunset' | 'Split' | 'Users' | 'LogIn' | 'LogOut' | 'Flag'

export interface PolicyChip {
  key: ChipKey
  icon: ChipIcon
  value: string
  tip: string
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function recipientsLabel(r: RecipientRule): string {
  if (r === 'owners') return 'Owners'
  if (r === 'admins') return 'Admins'
  if (r === 'all_members') return 'Members'
  return r.adapter
}

export function gapChip(days: number): PolicyChip {
  return { key: 'gap', icon: 'Clock', value: `${trimNum(days)}d`, tip: `Min gap between emails: ${plural(days, 'day', 'days')}` }
}

export function windowChip(d: ProgramDefinition['policy']['delivery']): PolicyChip | null {
  if (!d) return null
  const time = d.timeOfDay
  if (!d.weekdaysOnly && !time) return null
  const value = [d.weekdaysOnly ? 'Wkdays' : '', time ?? ''].filter(Boolean).join(' ')
  const when = [d.weekdaysOnly ? 'weekdays' : 'every day', time ? `at ${time}` : ''].filter(Boolean).join(' ')
  const zone = d.useContactTimezone
    ? `in the contact's timezone${d.timezone ? ` (fallback ${d.timezone})` : ''}`
    : d.timezone ?? ''
  return { key: 'window', icon: 'Calendar', value, tip: `Delivery window: ${[when, zone].filter(Boolean).join(' ')}` }
}

export function quietChip(hours: number | undefined): PolicyChip | null {
  if (!hours) return null
  return { key: 'quiet', icon: 'Moon', value: `${trimNum(hours)}h`, tip: `Quiet for ${trimNum(hours)} h after a session` }
}

export function sunsetChip(s: ProgramDefinition['policy']['sunset']): PolicyChip | null {
  if (!s) return null
  return {
    key: 'sunset',
    icon: 'Sunset',
    value: `${s.slowAfter} · ${s.askAfter}`,
    tip: `Slows after ${s.slowAfter} unanswered (×${trimNum(s.slowFactor)}), asks after ${s.askAfter}`,
  }
}

export function holdoutChip(pct: number | undefined): PolicyChip | null {
  if (!pct) return null
  return { key: 'holdout', icon: 'Split', value: `${trimNum(pct)}%`, tip: `Holdout: ${trimNum(pct)}% get nothing` }
}

export function policyChips(def: ProgramDefinition): PolicyChip[] {
  const out: Array<PolicyChip | null> = [
    def.policy.minGapDays != null ? gapChip(def.policy.minGapDays) : null,
    windowChip(def.policy.delivery),
    quietChip(def.policy.suppressIfSessionWithinHours),
    sunsetChip(def.policy.sunset),
    holdoutChip(def.holdoutPct),
    def.recipients
      ? { key: 'recipients', icon: 'Users', value: recipientsLabel(def.recipients), tip: `Recipients: ${recipientsLabel(def.recipients)}` }
      : null,
    def.entry?.eventName
      ? { key: 'entry', icon: 'LogIn', value: def.entry.eventName, tip: `Enters on "${def.entry.eventName}"` }
      : null,
    def.exit?.eventNames?.length
      ? { key: 'exit', icon: 'LogOut', value: String(def.exit.eventNames.length), tip: `Exits on: ${def.exit.eventNames.join(', ')}` }
      : null,
    def.exit?.onComplete?.fireEvent
      ? {
          key: 'complete',
          icon: 'Flag',
          value: def.exit.onComplete.fireEvent,
          tip: `Fires "${def.exit.onComplete.fireEvent}" on completion`,
        }
      : null,
  ]
  return out.filter((c): c is PolicyChip => !!c)
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}
