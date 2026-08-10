/**
 * Unit tests for the pending-unsubscribe journal file (INVARIANT 8).
 *
 * These cover the file semantics alone — no Mongo. The replay-into-Mongo half
 * is in test/integration/pending-unsubs.test.ts.
 *
 * The failure modes here are not hypothetical: this file is appended to
 * synchronously from an HTTP handler in a process that may be SIGKILLed
 * mid-write, by more than one process at a time, on a box where /tmp used to
 * be the default location.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  adoptAbandonedClaims,
  appendPendingUnsub,
  claimJournal,
  parseEntry,
  readClaim,
  releaseClaim,
  serializeEntry,
} from '../../src/server/unsub-journal.js'

let dir: string
let journal: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailery-journal-'))
  journal = path.join(dir, 'nested', 'pending-unsubs.jsonl')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('appendPendingUnsub', () => {
  it('creates the parent directory and the file with private permissions', () => {
    appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 })

    expect(fs.existsSync(journal)).toBe(true)
    // 0600 file inside a 0700 directory. The old /tmp default gave neither.
    expect(fs.statSync(journal).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(journal)).mode & 0o777).toBe(0o700)
  })

  it('appends rather than truncates', () => {
    appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 })
    appendPendingUnsub(journal, { email: 'b@example.com', scope: 'marketing', at: 2 })

    const lines = fs.readFileSync(journal, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).email).toBe('b@example.com')
  })

  it('narrows the permissions of a pre-existing loose file', () => {
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(journal, '', { mode: 0o666 })
    fs.chmodSync(journal, 0o666)

    appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 })
    expect(fs.statSync(journal).mode & 0o777).toBe(0o600)
  })

  it('refuses to write through a symlink', () => {
    const target = path.join(dir, 'target.txt')
    fs.writeFileSync(target, 'untouched')
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.symlinkSync(target, journal)

    expect(() =>
      appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 }),
    ).toThrow()
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched')
  })

  it('refuses to write through a hard link', () => {
    const other = path.join(dir, 'other.txt')
    fs.writeFileSync(other, '')
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.linkSync(other, journal)

    expect(() =>
      appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 }),
    ).toThrow(/hard link/)
  })
})

describe('parseEntry', () => {
  it('accepts a well-formed line', () => {
    const e = parseEntry(serializeEntry({ email: 'A@Example.com', scope: 'all', at: 7 }))
    expect(e).toEqual({ email: 'a@example.com', scope: 'all', at: 7 })
  })

  it('rejects lines that cannot become an unsubscribe', () => {
    // A line torn in half by a SIGKILL mid-append.
    expect(parseEntry('{"email":"a@example.com","sc')).toBeNull()
    expect(parseEntry('not json at all')).toBeNull()
    expect(parseEntry('[]')).toBeNull()
    expect(parseEntry('"a string"')).toBeNull()
    expect(parseEntry('{"email":"not-an-email","scope":"all","at":1}')).toBeNull()
    expect(parseEntry('{"email":"a@example.com","scope":"nonsense","at":1}')).toBeNull()
    expect(parseEntry('{"scope":"all","at":1}')).toBeNull()
  })

  it('carries the attempt counter through', () => {
    const e = parseEntry('{"email":"a@example.com","scope":"all","at":1,"attempts":3}')
    expect(e?.attempts).toBe(3)
  })
})

describe('readClaim', () => {
  it('returns nothing for an absent file', () => {
    expect(readClaim(path.join(dir, 'nope.jsonl'))).toEqual({
      entries: [],
      malformed: [],
      bytes: 0,
    })
  })

  it('returns nothing for an empty file', () => {
    fs.writeFileSync(journal.replace(/nested\//, ''), '')
    const r = readClaim(journal.replace(/nested\//, ''))
    expect(r.entries).toEqual([])
    expect(r.malformed).toEqual([])
  })

  it('keeps every valid entry around a truncated final line', () => {
    const f = path.join(dir, 'j.jsonl')
    fs.writeFileSync(
      f,
      serializeEntry({ email: 'a@example.com', scope: 'all', at: 1 }) +
        serializeEntry({ email: 'b@example.com', scope: 'all', at: 2 }) +
        '{"email":"c@example.com","sco', // killed mid-write
    )

    const r = readClaim(f)
    expect(r.entries.map((e) => e.email)).toEqual(['a@example.com', 'b@example.com'])
    expect(r.malformed).toHaveLength(1)
    expect(r.malformed[0]!.lineNumber).toBe(3)
  })

  it('skips a malformed line in the middle without losing its neighbours', () => {
    const f = path.join(dir, 'j.jsonl')
    fs.writeFileSync(
      f,
      serializeEntry({ email: 'a@example.com', scope: 'all', at: 1 }) +
        'garbage\n' +
        '\n' + // blank lines are not malformed, just skipped
        serializeEntry({ email: 'b@example.com', scope: 'marketing', at: 2 }),
    )

    const r = readClaim(f)
    expect(r.entries.map((e) => e.email)).toEqual(['a@example.com', 'b@example.com'])
    expect(r.malformed).toHaveLength(1)
  })
})

describe('claimJournal / adoptAbandonedClaims / releaseClaim', () => {
  it('moves the journal aside so the route can keep appending', () => {
    appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 })
    const claim = claimJournal(journal)

    expect(claim).toBeTruthy()
    expect(fs.existsSync(journal)).toBe(false)
    expect(readClaim(claim!).entries).toHaveLength(1)

    // A concurrent request appends while the batch is being drained; it lands
    // in a fresh journal and is not swallowed by this pass.
    appendPendingUnsub(journal, { email: 'b@example.com', scope: 'all', at: 2 })
    expect(readClaim(journal).entries.map((e) => e.email)).toEqual(['b@example.com'])
  })

  it('returns null when there is nothing to claim', () => {
    expect(claimJournal(journal)).toBeNull()
  })

  it('lets only one of two concurrent claimers win', () => {
    appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 })
    const first = claimJournal(journal)
    const second = claimJournal(journal)

    expect(first).toBeTruthy()
    expect(second).toBeNull()
  })

  it('adopts a claim abandoned by a dead pass, but leaves a live one alone', () => {
    appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 })
    const claim = claimJournal(journal)!

    // A claim held by a live pass is not adoptable.
    expect(adoptAbandonedClaims(journal, { olderThanMs: 60_000 })).toEqual([])

    // Now the owner dies and the file goes cold.
    const old = new Date(Date.now() - 10 * 60_000)
    fs.utimesSync(claim, old, old)

    const adopted = adoptAbandonedClaims(journal, { olderThanMs: 60_000 })
    expect(adopted).toHaveLength(1)
    expect(adopted[0]).not.toBe(claim)
    expect(readClaim(adopted[0]!).entries).toHaveLength(1)

    // Adoption is a rename *and* a touch, so a second adopter racing us finds
    // nothing to take and does not steal a batch we are still working on.
    expect(adoptAbandonedClaims(journal, { olderThanMs: 60_000 })).toEqual([])
  })

  it('refreshes mtime on claim, so an old journal is not instantly adoptable', () => {
    appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 })
    // The journal itself has been sitting there since the outage started.
    const old = new Date(Date.now() - 60 * 60_000)
    fs.utimesSync(journal, old, old)

    claimJournal(journal)
    expect(adoptAbandonedClaims(journal, { olderThanMs: 60_000 })).toEqual([])
  })

  it('ignores unrelated files in the same directory', () => {
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(journal), 'unrelated.log'), 'x')
    expect(adoptAbandonedClaims(journal, { olderThanMs: 0 })).toEqual([])
  })

  it('tolerates the directory not existing yet', () => {
    expect(adoptAbandonedClaims(journal, { olderThanMs: 0 })).toEqual([])
  })

  it('hands undrained entries back to the live journal and drops the claim', () => {
    appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 })
    const claim = claimJournal(journal)!
    const { entries } = readClaim(claim)

    releaseClaim(journal, claim, entries)

    expect(fs.existsSync(claim)).toBe(false)
    const back = readClaim(journal)
    expect(back.entries.map((e) => e.email)).toEqual(['a@example.com'])
    // Attempts are counted so a permanently stuck entry becomes visible.
    expect(back.entries[0]!.attempts).toBe(1)

    const secondClaim = claimJournal(journal)!
    releaseClaim(journal, secondClaim, readClaim(secondClaim).entries)
    expect(readClaim(journal).entries[0]!.attempts).toBe(2)
  })

  it('just removes the claim when nothing was left over', () => {
    appendPendingUnsub(journal, { email: 'a@example.com', scope: 'all', at: 1 })
    const claim = claimJournal(journal)!

    releaseClaim(journal, claim, [])

    expect(fs.existsSync(claim)).toBe(false)
    expect(fs.existsSync(journal)).toBe(false)
  })
})
