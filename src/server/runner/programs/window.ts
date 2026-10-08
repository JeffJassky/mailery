/**
 * Program send time (plans/17-cadence-controls.md F2 + F5): the delivery
 * window with the subject's usual hour, then the mailer-wide blackout dates,
 * applied until stable. Pure. Used by the tick (step 12) and the simulator so
 * the board can never disagree with the engine.
 */

import type { ContactPolicy, DeliveryWindow, Facts, ProgramDefinition } from '../../../shared/types.js'

/**
 * The window the tick actually uses for `facts`: when `useSessionHour` is set
 * and `facts.usual_session_hour_utc` is an integer 0–23, `timeOfDay` becomes
 * that UTC hour (plus `sessionHourOffsetMinutes`) expressed as local HH:mm in
 * the window's resolved zone on the day of `now`. Otherwise `window` unchanged.
 */
export function programDeliveryWindow(_window: DeliveryWindow, _facts: Facts, _now: Date): DeliveryWindow {
  throw new Error('programDeliveryWindow: not implemented (plans/17 PR B)')
}

/**
 * Earliest instant ≥ `from` at which a program send may go out: the delivery
 * window (`programDeliveryWindow`) and the contact policy's blackout dates,
 * applied until stable (≤ 50 passes). `gate` names the rule that moved the time
 * last; null when `at` equals `from`.
 */
export function programSendTime(
  _from: Date,
  _def: ProgramDefinition,
  _facts: Facts,
  _contactPolicy: ContactPolicy | undefined,
): { at: Date; gate: 'delivery-window' | 'blackout' | null } {
  throw new Error('programSendTime: not implemented (plans/17 PR B)')
}
