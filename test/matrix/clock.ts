/**
 * Frozen-clock helpers for the matrix suites.
 *
 * **Only `Date` is faked.** Faking `setTimeout`/`setInterval` stalls the
 * MongoDB driver's connection heartbeats and the suite hangs — so time is
 * moved with `vi.setSystemTime`, never `vi.advanceTimersByTime` (there are no
 * faked timers to advance). Everything the runner reads for scheduling goes
 * through `Date.now()` / `new Date()`:
 *
 *   - `handleWait`               src/server/runner/step.ts:80
 *   - `computeDeliveryTime`      src/server/runner/step.ts:58
 *   - `sweepStrandedFlowRuns`    src/server/runner/sweep.ts:14
 *
 * so freezing `Date` is enough to make weekday/weekend, time-of-day and
 * multi-day-wait behaviour testable in milliseconds.
 *
 * Freeze *after* the harness is built (mongodb-memory-server startup should
 * see a real clock) and restore *before* `H.stop()`.
 */

import { vi } from 'vitest'

/** Freeze the clock at an absolute instant. Accepts an ISO string or a Date. */
export function freezeAt(when: string | Date): Date {
  const at = when instanceof Date ? when : new Date(when)
  if (Number.isNaN(at.getTime())) {
    throw new Error(`freezeAt: not a valid date: ${String(when)}`)
  }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at)
  return at
}

/** Move the frozen clock forward. Returns the new "now". */
export function advance(ms: number): Date {
  const next = new Date(Date.now() + ms)
  vi.setSystemTime(next)
  return next
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Restore the real clock. Safe to call when no clock was frozen. */
export function restoreClock(): void {
  vi.useRealTimers()
}

/**
 * Day-of-week of an instant in a given zone, as 'Mon'…'Sun'. Mirrors how
 * `delivery-window.ts` reads the weekday, so assertions state the thing the
 * code actually branches on rather than a UTC offset the reader must compute.
 */
export function weekdayIn(date: Date, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date)
}

/** Local wall-clock 'YYYY-MM-DD HH:mm' of an instant in a given zone. */
export function localStamp(date: Date, timeZone = 'UTC'): string {
  const parts: Record<string, string> = {}
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value
  const hour = String(Number(parts.hour) % 24).padStart(2, '0')
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`
}
