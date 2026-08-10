/**
 * The pending-unsubscribe journal — the on-disk half of INVARIANT 8.
 *
 * When `POST /m/unsub/:token` cannot reach Mongo, the opt-out is appended here
 * as one JSON object per line, and `runner/pending-unsubs.ts` replays it on a
 * later tick. Until v0.15 the write existed and the replay did not, so a
 * recipient who unsubscribed during a Mongo outage was told "you are
 * unsubscribed" and then kept receiving mail. That is a legal failure, not a
 * dropped metric.
 *
 * This module owns only the file: append, rotate, read, delete. It never
 * touches Mongo, so it can be unit tested against a tmpdir with no database.
 *
 * ## Why there is no default path
 *
 * The old default was `/tmp/mailery-pending-unsubs.jsonl`: world-writable
 * directory, cleared on reboot, and — since nothing drained it — write-only.
 * There is no replacement default, because a library mounted into an unknown
 * host cannot pick a directory that is simultaneously writable, durable and
 * private: `/var/lib/...` needs root to create, `$HOME` may not exist in a
 * container, and the working directory may be read-only or ephemeral. On top of
 * that the journal holds recipient email addresses in plaintext outside the
 * database, so choosing a location on the operator's behalf is a data-residency
 * decision the operator has to make.
 *
 * So the journal is opt-in: set `pendingUnsubsPath` in `MailerConfig`. With it
 * unset, a failed Mongo write makes the endpoint answer 503 instead of
 * silently dropping the opt-out (see INVARIANT 8).
 *
 * ## Layout
 *
 *   <path>                       the live journal — appended to by the route
 *   <path>.draining.<token>      a batch claimed by one drain pass
 *
 * Claiming is done with `rename`, which is atomic on POSIX within a directory:
 * exactly one process can move the live journal to its own `.draining.<token>`
 * name, and a second process racing it gets ENOENT and moves on. That is the
 * whole concurrency story — no lock files, no leases.
 *
 * A drain that crashes leaves its `.draining.<token>` file behind. A later pass
 * adopts any such file older than `ADOPT_AFTER_MS` (again by rename, so only
 * one adopter wins) and replays it. Replaying is idempotent, so adopting a file
 * another process is in fact still working on costs duplicate writes and
 * nothing else.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { unsubscribeInputSchema, type UnsubscribeInput } from '../shared/schemas.js'

/** One line of the journal. */
export interface PendingUnsubEntry {
  email: string
  scope: 'all' | 'marketing' | 'transactional'
  /** Epoch ms the unsubscribe was received. */
  at: number
  /**
   * How many drain passes have already failed to apply this entry. Absent on
   * entries written by the route; incremented each time the drain writes one
   * back. Purely diagnostic — an entry is never dropped for being old.
   */
  attempts?: number
}

/** Marker inserted between the journal path and a claim token. */
const DRAINING_INFIX = '.draining.'

/**
 * How long a `.draining.<token>` file must sit untouched before another pass
 * treats its owner as dead and adopts it. Matches the stranded-send and
 * stranded-webhook thresholds in `runner/tick.ts`.
 */
export const ADOPT_AFTER_MS = 5 * 60 * 1000

/** Beyond this the operator has a real outage and should be told. */
export const JOURNAL_WARN_BYTES = 8 * 1024 * 1024

/**
 * `O_NOFOLLOW` where the platform has it (POSIX), 0 elsewhere (Windows).
 * Stops the final path component being swapped for a symlink pointing at
 * something we should not be appending recipient addresses to.
 */
const O_NOFOLLOW = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

const APPEND_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append one entry to the live journal. Synchronous on purpose: this runs on
 * the failure path of an HTTP request that is holding a compliance obligation,
 * and an `await` there is one more place to lose it.
 *
 * Throws on any failure, including a path that is not a plain private file.
 * The caller (the unsubscribe route) turns a throw into a 503.
 *
 * Concurrency: the parent directory is created 0700 and the file 0600, and the
 * write is a single `O_APPEND` write of a short line, so concurrent appenders
 * from multiple processes interleave at line granularity rather than within a
 * line. A line that does get torn is dropped by the drain as malformed and
 * logged; it is not able to corrupt its neighbours.
 */
export function appendPendingUnsub(journalPath: string, entry: PendingUnsubEntry): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 })

  const fd = fs.openSync(journalPath, APPEND_FLAGS, 0o600)
  try {
    assertPrivateRegularFile(fd, journalPath)
    fs.writeSync(fd, serializeEntry(entry))
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Reject anything that is not a regular file we exclusively own.
 *
 * `O_NOFOLLOW` covers a symlink swapped in at the last component; it does not
 * cover a regular file pre-created by someone else in a shared directory, nor
 * a hard link pointing our appends at a file that matters. `nlink > 1` catches
 * the hard link; the `chmod` narrows a file that was created with looser
 * permissions before this version shipped.
 */
function assertPrivateRegularFile(fd: number, journalPath: string): void {
  const st = fs.fstatSync(fd)
  if (!st.isFile()) {
    throw new Error(`pending-unsubscribe journal is not a regular file: ${journalPath}`)
  }
  if (st.nlink > 1) {
    throw new Error(`pending-unsubscribe journal has ${st.nlink} hard links: ${journalPath}`)
  }
  if ((st.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600)
}

export function serializeEntry(entry: PendingUnsubEntry): string {
  return JSON.stringify(entry) + '\n'
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

function claimToken(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
}

/**
 * Move the live journal aside so this pass owns its contents and the route can
 * keep appending to a fresh file. Returns the claimed path, or null when there
 * was nothing to claim (no journal, or another process won the race).
 */
export function claimJournal(journalPath: string): string | null {
  const claimed = `${journalPath}${DRAINING_INFIX}${claimToken()}`
  try {
    fs.renameSync(journalPath, claimed)
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
  markClaimActive(claimed)
  return claimed
}

/**
 * Stamp a claim as owned *now*.
 *
 * `rename` preserves mtime, so a journal whose last append was during an
 * outage an hour ago would arrive already looking abandoned, and a second
 * process would adopt it out from under the pass that just claimed it. The
 * touch is what makes `mtime` mean "this batch has an owner that was alive
 * recently" rather than "this is when the last unsubscribe came in".
 */
function markClaimActive(claimPath: string): void {
  const now = new Date()
  try {
    fs.utimesSync(claimPath, now, now)
  } catch (err) {
    // Not fatal — worst case another pass adopts the batch and applies it
    // twice, which is a no-op.
    if (!isMissing(err)) throw err
  }
}

/**
 * Find `.draining.*` files left behind by a pass that died, and take ownership
 * of the ones that have been idle longer than `olderThanMs`.
 *
 * Adoption is a rename to a fresh token, so two processes scanning at the same
 * instant cannot both end up owning the same batch.
 */
export function adoptAbandonedClaims(
  journalPath: string,
  opts: { olderThanMs?: number; now?: number } = {},
): string[] {
  const olderThanMs = opts.olderThanMs ?? ADOPT_AFTER_MS
  const now = opts.now ?? Date.now()
  const dir = path.dirname(journalPath)
  const prefix = path.basename(journalPath) + DRAINING_INFIX

  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }

  const adopted: string[] = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const full = path.join(dir, name)
    let st: fs.Stats
    try {
      st = fs.statSync(full)
    } catch (err) {
      if (isMissing(err)) continue
      throw err
    }
    if (!st.isFile()) continue
    if (now - st.mtimeMs < olderThanMs) continue

    const mine = `${journalPath}${DRAINING_INFIX}${claimToken()}`
    try {
      fs.renameSync(full, mine)
      markClaimActive(mine)
      adopted.push(mine)
    } catch (err) {
      // Lost the race to another adopter — that is the mechanism working.
      if (!isMissing(err)) throw err
    }
  }
  return adopted
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ReadResult {
  entries: PendingUnsubEntry[]
  /** Lines that were not usable — torn by a crash mid-append, or hand-edited. */
  malformed: Array<{ lineNumber: number; preview: string }>
  bytes: number
}

/**
 * Read a claimed batch.
 *
 * Every failure mode of a file that is appended to by a process which may be
 * killed at any moment is tolerated here, because the alternative is a drain
 * that aborts and leaves valid opt-outs unapplied:
 *
 *   - absent file            → empty result
 *   - empty file             → empty result
 *   - truncated final line   → that line is malformed, every earlier line is
 *                              still returned
 *   - a malformed line       → skipped, reported, neighbours unaffected
 *   - a JSON line that is not a valid unsubscribe (bad email, bad scope)
 *                            → malformed; it can never be applied, so retrying
 *                              it forever would only pin the journal open
 */
export function readClaim(claimPath: string): ReadResult {
  let raw: string
  try {
    raw = fs.readFileSync(claimPath, 'utf8')
  } catch (err) {
    if (isMissing(err)) return { entries: [], malformed: [], bytes: 0 }
    throw err
  }

  const entries: PendingUnsubEntry[] = []
  const malformed: ReadResult['malformed'] = []

  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const parsed = parseEntry(line)
    if (parsed) entries.push(parsed)
    else malformed.push({ lineNumber: i + 1, preview: line.slice(0, 120) })
  }

  return { entries, malformed, bytes: Buffer.byteLength(raw) }
}

/**
 * Parse one journal line. Returns null for anything that could not be turned
 * into an applicable unsubscribe.
 */
export function parseEntry(line: string): PendingUnsubEntry | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>

  // Validated with the same schema the live route uses, so an entry that
  // survives here is one `applyUnsubscribe` can definitely accept.
  const check = unsubscribeInputSchema.safeParse({
    email: o.email,
    scope: o.scope,
    reason: 'user_request',
    source: 'one-click',
  })
  if (!check.success) return null

  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now()
  const attempts =
    typeof o.attempts === 'number' && Number.isFinite(o.attempts) && o.attempts > 0
      ? Math.floor(o.attempts)
      : undefined

  return {
    email: check.data.email,
    scope: check.data.scope,
    at,
    ...(attempts === undefined ? {} : { attempts }),
  }
}

/** The `UnsubscribeInput` a journal entry replays as. */
export function entryToInput(entry: PendingUnsubEntry): UnsubscribeInput {
  return unsubscribeInputSchema.parse({
    email: entry.email,
    scope: entry.scope,
    reason: 'user_request',
    // Distinguishable in `mailer_suppressions.source` from a live one-click,
    // but only on rows the drain actually created (the upsert is
    // `$setOnInsert`, so a row the live path already wrote keeps its own).
    source: 'one-click-drain',
  })
}

// ---------------------------------------------------------------------------
// Finishing a batch
// ---------------------------------------------------------------------------

/**
 * Hand entries this pass could not apply back to the live journal, then drop
 * the claim.
 *
 * Returning them to the live journal rather than leaving them in the claim
 * file is what makes the next tick pick them up immediately instead of waiting
 * out `ADOPT_AFTER_MS`. The order — append first, unlink second — is chosen so
 * a crash in between duplicates entries rather than losing them, and duplicates
 * are free because applying twice is a no-op.
 */
export function releaseClaim(
  journalPath: string,
  claimPath: string,
  remaining: PendingUnsubEntry[],
): void {
  if (remaining.length > 0) {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(journalPath, APPEND_FLAGS, 0o600)
    try {
      assertPrivateRegularFile(fd, journalPath)
      fs.writeSync(
        fd,
        remaining.map((e) => serializeEntry({ ...e, attempts: (e.attempts ?? 0) + 1 })).join(''),
      )
    } finally {
      fs.closeSync(fd)
    }
  }
  try {
    fs.unlinkSync(claimPath)
  } catch (err) {
    if (!isMissing(err)) throw err
  }
}

/** True when the journal (or any claim of it) has anything worth draining. */
export function journalExists(journalPath: string): boolean {
  try {
    return fs.statSync(journalPath).isFile()
  } catch (err) {
    if (isMissing(err)) return false
    throw err
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
