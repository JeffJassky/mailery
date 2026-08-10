/**
 * The pending-unsubscribe drain — the second half of INVARIANT 8.
 *
 * `POST /m/unsub/:token` journals an opt-out to disk when Mongo is unreachable
 * (`src/server/unsub-journal.ts`). This replays those entries. It runs from
 * `runTick`, so it needs no scheduling of its own and inherits the tick's
 * cadence (`tickIntervalSeconds`, default 60) and its per-runner error
 * isolation. It is also exported so a host can run it from a script or a
 * one-shot process.
 *
 * ## Where the drain runs, and why only here
 *
 * The tick, not a CLI command. `src/cli/` is a DNS/provider setup tool: it has
 * no Mongo connection, no contact adapter and no config loader, so a
 * `mailery drain-unsubs` command would have to invent a whole configuration
 * story to reach the database. Every deployment that can journal an opt-out is
 * by definition already running the library, and most run the tick;
 * `drainPendingUnsubscribes` is exported for the ones that don't.
 *
 * ## Guarantees
 *
 * - **Idempotent.** Replay goes through `applyUnsubscribe`, whose suppression
 *   write is a `$setOnInsert` upsert and whose subscription write is a `$set`
 *   to a terminal state. Draining the same entry twice is indistinguishable
 *   from draining it once.
 * - **Nothing is lost to a crash.** A pass claims a batch by renaming the
 *   journal aside; if it dies, the claim file stays on disk and a later pass
 *   adopts it. Entries it could not apply are appended back to the live
 *   journal *before* the claim is unlinked, so the failure window duplicates
 *   rather than drops.
 * - **Concurrency-safe.** Claiming and adopting are `rename`, which is atomic
 *   within a directory. Two processes draining the same journal cannot both
 *   own the same batch.
 * - **Fails soft.** A Mongo write failure aborts the pass immediately — the
 *   database being down is exactly why these entries exist, and hammering it
 *   with the rest of the batch achieves nothing.
 */

import {
  adoptAbandonedClaims,
  claimJournal,
  entryToInput,
  journalExists,
  readClaim,
  releaseClaim,
  JOURNAL_WARN_BYTES,
  type PendingUnsubEntry,
} from '../unsub-journal.js'
import { applyUnsubscribe } from '../unsubscribe.js'
import type { RunnerContext } from './index.js'

/**
 * Entries applied per pass. A long outage can leave a journal with far more
 * than this; the remainder is written back and picked up by the next tick,
 * which keeps a single tick's latency bounded.
 */
const MAX_ENTRIES_PER_PASS = 1000

/**
 * Attempts after which an entry is loud rather than routine. It is never
 * dropped — a stuck opt-out is a compliance problem an operator has to see,
 * not one the library gets to discard.
 */
const NOISY_AFTER_ATTEMPTS = 10

export interface DrainPendingUnsubsResult {
  /** False when no `pendingUnsubsPath` is configured — the journal is opt-in. */
  enabled: boolean
  applied: number
  /** Entries handed back to the journal for a later pass. */
  deferred: number
  /** Lines that could never be applied (torn by a crash, or hand-edited). */
  malformed: number
  /** Claim files processed, including ones adopted from a dead pass. */
  batches: number
}

export interface DrainPendingUnsubsOptions {
  /** Overrides `config.pendingUnsubsPath`. Mostly for tests. */
  path?: string
  maxEntries?: number
  /** Structured sink for diagnostics. Defaults to `console`. */
  log?: {
    warn?: (fields: Record<string, unknown>, msg?: string) => void
    error?: (fields: Record<string, unknown>, msg?: string) => void
  }
}

const consoleLog = {
  warn: (fields: Record<string, unknown>, msg?: string) => console.warn(msg ?? 'mailery', fields),
  error: (fields: Record<string, unknown>, msg?: string) => console.error(msg ?? 'mailery', fields),
}

export async function drainPendingUnsubscribes(
  ctx: RunnerContext,
  opts: DrainPendingUnsubsOptions = {},
): Promise<DrainPendingUnsubsResult> {
  const journalPath = opts.path ?? ctx.config.pendingUnsubsPath
  const result: DrainPendingUnsubsResult = {
    enabled: Boolean(journalPath),
    applied: 0,
    deferred: 0,
    malformed: 0,
    batches: 0,
  }
  if (!journalPath) return result

  const log = opts.log ?? consoleLog
  const budget = opts.maxEntries ?? MAX_ENTRIES_PER_PASS

  // Claims left behind by a pass that died mid-drain come first: they are
  // strictly older than anything in the live journal.
  const claims: string[] = []
  try {
    claims.push(...adoptAbandonedClaims(journalPath))
  } catch (err) {
    log.error?.({ err, path: journalPath }, 'mailery: pending-unsub claim adoption failed')
  }

  if (journalExists(journalPath)) {
    const claimed = claimJournal(journalPath)
    if (claimed) claims.push(claimed)
  }
  if (claims.length === 0) return result

  let remainingBudget = budget

  for (const claimPath of claims) {
    result.batches++
    const batch = readClaim(claimPath)

    if (batch.bytes > JOURNAL_WARN_BYTES) {
      log.warn?.(
        { path: claimPath, bytes: batch.bytes, entries: batch.entries.length },
        'mailery: pending-unsubscribe journal is large — Mongo has been unreachable for a while',
      )
    }
    for (const bad of batch.malformed) {
      result.malformed++
      log.warn?.(
        { path: claimPath, lineNumber: bad.lineNumber, preview: bad.preview },
        'mailery: pending-unsubscribe journal line unusable — skipped',
      )
    }

    const deferred: PendingUnsubEntry[] = []
    let stop = false

    for (let i = 0; i < batch.entries.length; i++) {
      const entry = batch.entries[i]!
      if (stop || remainingBudget <= 0) {
        deferred.push(entry)
        continue
      }
      try {
        await applyUnsubscribe(ctx.collections, entryToInput(entry))
        result.applied++
        remainingBudget--
      } catch (err) {
        // The database is the reason this file exists. Stop the pass rather
        // than replay the rest of the batch into the same failure.
        stop = true
        deferred.push(entry)
        const attempts = (entry.attempts ?? 0) + 1
        const fields = { err, path: claimPath, attempts, pending: batch.entries.length - i }
        if (attempts >= NOISY_AFTER_ATTEMPTS) {
          log.error?.(
            fields,
            'mailery: pending unsubscribe still not applied after repeated attempts — investigate',
          )
        } else {
          log.warn?.(fields, 'mailery: pending-unsubscribe replay failed — deferred to next tick')
        }
      }
    }

    result.deferred += deferred.length
    // Always release, even after an abort: the entries are back in the live
    // journal, and holding the claim would only make the next pass wait out
    // the adoption threshold before retrying them.
    releaseClaim(journalPath, claimPath, deferred)
  }

  return result
}
