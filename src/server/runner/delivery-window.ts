/**
 * Delivery-window math. Pure — no I/O, no Date.now(); callers pass `now`.
 *
 * Given the moment a send step becomes runnable, `computeDeliveryTime`
 * returns the earliest instant the email is allowed to go out. It only ever
 * moves forward: a send already inside its window returns `now` unchanged.
 *
 * Timezone handling uses the Intl API (no dependency). DST transitions are
 * resolved with a two-pass offset fix; the worst case during a transition is
 * being off by the shifted hour, which is fine for email delivery.
 */

import type { DeliveryWindow } from '../../shared/types.js'

/**
 * Ticks fire with jitter, so a send arriving shortly AFTER its timeOfDay slot
 * still goes out rather than waiting a full day.
 */
const TIME_OF_DAY_GRACE_MS = 60 * 60_000

export function computeDeliveryTime(
  now: Date,
  window: DeliveryWindow,
  contactTimezone?: string,
): Date {
  const tz = pickTimezone(window, contactTimezone)
  let candidate = now

  if (window.timeOfDay) {
    const [hh, mm] = window.timeOfDay.split(':').map(Number) as [number, number]
    const local = localParts(candidate, tz)
    const todaySlot = utcFromLocal(local.y, local.mo, local.d, hh, mm, tz)
    if (candidate.getTime() < todaySlot.getTime()) {
      candidate = todaySlot
    } else if (candidate.getTime() - todaySlot.getTime() > TIME_OF_DAY_GRACE_MS) {
      const next = addLocalDays(local, 1)
      candidate = utcFromLocal(next.y, next.mo, next.d, hh, mm, tz)
    }
    // else: within grace of today's slot — send now.
  }

  if (window.weekdaysOnly) {
    for (let guard = 0; guard < 3; guard++) {
      const local = localParts(candidate, tz)
      if (local.weekday !== 'Sat' && local.weekday !== 'Sun') break
      const shift = local.weekday === 'Sat' ? 2 : 1
      const moved = addLocalDays(local, shift)
      // Preserve the local clock time (timeOfDay slot, or the wall-clock
      // moment the step became runnable).
      candidate = utcFromLocal(moved.y, moved.mo, moved.d, local.hh, local.mi, tz)
    }
  }

  return candidate
}

function pickTimezone(window: DeliveryWindow, contactTimezone?: string): string {
  const candidates = [
    window.useContactTimezone ? contactTimezone : undefined,
    window.timezone,
    'UTC',
  ]
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz
  }
  return 'UTC'
}

const validatedZones = new Map<string, boolean>()

function isValidTimezone(tz: string): boolean {
  const cached = validatedZones.get(tz)
  if (cached !== undefined) return cached
  let ok = true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    ok = false
  }
  validatedZones.set(tz, ok)
  return ok
}

interface LocalParts {
  y: number
  mo: number
  d: number
  hh: number
  mi: number
  ss: number
  weekday: string // 'Mon'…'Sun'
}

const partFormatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hour12: false,
    })
    partFormatters.set(tz, f)
  }
  return f
}

function localParts(date: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {}
  for (const p of formatterFor(tz).formatToParts(date)) parts[p.type] = p.value
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour) % 24, // Intl emits '24' for midnight in some locales
    mi: Number(parts.minute),
    ss: Number(parts.second),
    weekday: parts.weekday!,
  }
}

/** UTC instant for a wall-clock time in `tz`. Two passes to converge across DST. */
function utcFromLocal(y: number, mo: number, d: number, hh: number, mi: number, tz: string): Date {
  let ts = Date.UTC(y, mo - 1, d, hh, mi, 0)
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(ts), tz)
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mi, p.ss)
    const offset = asUtc - ts
    ts = Date.UTC(y, mo - 1, d, hh, mi, 0) - offset
  }
  return new Date(ts)
}

/** Add days to a local calendar date (normalizes month/year rollover). */
function addLocalDays(p: LocalParts, days: number): { y: number; mo: number; d: number } {
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d + days))
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}
