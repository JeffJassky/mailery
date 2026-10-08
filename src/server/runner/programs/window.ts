/**
 * Program send time (plans/17-cadence-controls.md F2 + F5): the delivery
 * window with the subject's usual hour, then the mailer-wide blackout dates,
 * applied until stable. Pure. Used by the tick (step 12) and the simulator so
 * the board can never disagree with the engine.
 */

import type { ContactPolicy, DeliveryWindow, Facts, ProgramDefinition } from '../../../shared/types.js'
import { isValidTimeZone } from '../../config.js'
import { blackoutEnd, resolvePolicyTimezone } from '../contact-policy.js'
import { computeDeliveryTime, localParts } from '../delivery-window.js'
import { timezoneFact } from './common.js'

/** Passes of window-then-blackout before giving up (each pass either settles or moves past a range). */
const MAX_PASSES = 50

/** The zone `computeDeliveryTime` resolves for this window and facts. */
function windowZone(window: DeliveryWindow, facts: Facts): string {
  const contactTz = window.useContactTimezone ? timezoneFact(facts) : null
  if (contactTz) return contactTz
  if (window.timezone && isValidTimeZone(window.timezone)) return window.timezone
  return 'UTC'
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * The window the tick actually uses for `facts`: when `useSessionHour` is set
 * and `facts.usual_session_hour_utc` is an integer 0–23, `timeOfDay` becomes
 * that UTC hour (plus `sessionHourOffsetMinutes`) expressed as local HH:mm in
 * the window's resolved zone on the day of `now`. Otherwise `window` unchanged.
 */
export function programDeliveryWindow(window: DeliveryWindow, facts: Facts, now: Date): DeliveryWindow {
  if (window.useSessionHour !== true) return window
  const hour = facts.usual_session_hour_utc
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) return window
  const zone = windowZone(window, facts)
  const today = localParts(now, zone)
  const instant = new Date(Date.UTC(today.y, today.mo - 1, today.d, hour, 0) + (window.sessionHourOffsetMinutes ?? 0) * 60_000)
  const local = localParts(instant, zone)
  return { ...window, timeOfDay: `${pad2(local.hh)}:${pad2(local.mi)}` }
}

/**
 * Earliest instant ≥ `from` at which a program send may go out: the delivery
 * window (`programDeliveryWindow`) and the contact policy's blackout dates,
 * applied until stable (≤ 50 passes). `gate` names the rule that moved the time
 * last; null when `at` equals `from`.
 */
export function programSendTime(
  from: Date,
  def: ProgramDefinition,
  facts: Facts,
  contactPolicy: ContactPolicy | undefined,
): { at: Date; gate: 'delivery-window' | 'blackout' | null } {
  const window = def.policy.delivery
  const dates = contactPolicy?.marketing?.blackoutDates
  const tz = timezoneFact(facts) ?? undefined
  const zone = resolvePolicyTimezone(null, tz, contactPolicy?.marketing?.defaultTimezone)
  let t = from
  let windowMoved = false
  let blackoutMoved = false
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const at = window ? computeDeliveryTime(t, programDeliveryWindow(window, facts, t), tz) : t
    if (at.getTime() !== t.getTime()) windowMoved = true
    const end = blackoutEnd(at, dates, zone)
    if (end === null) {
      t = at
      break
    }
    blackoutMoved = true
    t = end
  }
  return { at: t, gate: blackoutMoved ? 'blackout' : windowMoved ? 'delivery-window' : null }
}
