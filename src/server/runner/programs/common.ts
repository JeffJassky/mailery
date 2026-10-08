/**
 * Constants and persisted-semantics helpers shared by the Programs modules.
 * Re-exported from `index.ts`, which is the public surface. They live here so
 * the implementation modules never import `index.ts` (that would be a cycle).
 */

import crypto from 'node:crypto'

import type { Facts } from '../../../shared/types.js'
import type { ProgramArm } from '../../../shared/enums.js'

/** Event name hosts fire (externalId = subjectId) when facts change. Registered `every-time` when a factsAdapter is set. */
export const FACTS_CHANGED_EVENT = 'Facts Changed'

/** Facts inline on the decision row when their stable JSON is under this many bytes. */
export const INLINE_FACTS_MAX_BYTES = 4096

/** How long a silent `in-flight` tick waits before checking again. */
export const IN_FLIGHT_RECHECK_MS = 60 * 60 * 1000

/**
 * Deterministic arm: first 8 hex chars of sha256(`${slug}:${subjectId}`) as
 * an integer, mod 100, compared to `pct`. Stable across processes and
 * releases; changing it would move live subjects between arms.
 */
export function holdoutArm(slug: string, subjectId: string, pct: number | undefined): ProgramArm {
  if (!pct || pct <= 0) return 'treatment'
  if (pct >= 100) return 'holdout'
  const n = parseInt(crypto.createHash('sha256').update(`${slug}:${subjectId}`).digest('hex').slice(0, 8), 16) % 100
  return n < pct ? 'holdout' : 'treatment'
}

/** JSON with object keys sorted at every depth; Dates as ISO strings; undefined dropped. */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = normalize(x)
    }
    return out
  }
  return v
}

export function factsHash(facts: Facts): string {
  return crypto.createHash('sha256').update(stableJson(facts)).digest('hex')
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000
export const HOUR_MS = 60 * 60 * 1000

/** Scheduler scans re-read this much history; unique indexes make the re-read harmless. */
export const SCAN_OVERLAP_MS = 30_000

/** After a tick throws inside the scheduler, the run is retried no sooner than this. */
export const ERROR_BACKOFF_MS = 15 * 60 * 1000

/** A tick must always move `nextTickAt` past `now`; this is the floor. */
export const MIN_ADVANCE_MS = 60 * 1000

/**
 * Has this send of a Program decision still got a chance to reach a provider?
 * queued/sending/deferred/held are in flight. A `failed` send is too while the
 * queue's retries are pending, which we bound by `queuedAt` (after
 * IN_FLIGHT_RECHECK_MS it is treated as dead). A missing row is terminal.
 */
export function sendIsInFlight(send: { status: string; queuedAt: Date } | null | undefined, now: Date): boolean {
  if (!send) return false
  if (send.status === 'queued' || send.status === 'sending' || send.status === 'deferred' || send.status === 'held') return true
  if (send.status === 'failed') return now.getTime() - send.queuedAt.getTime() < IN_FLIGHT_RECHECK_MS
  return false
}

/** `timezone` fact as a valid IANA zone, else null. */
export function timezoneFact(facts: Record<string, unknown>): string | null {
  const tz = facts.timezone
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}
