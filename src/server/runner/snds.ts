/**
 * Microsoft SNDS (Smart Network Data Services) puller.
 *
 *   https://sendersupport.olc.protection.outlook.com/snds/
 *
 * SNDS reports IP-level Outlook/Hotmail/Live reputation: filter verdict
 * (GREEN/YELLOW/RED), complaint rate, spam-trap hits, and sample HELO /
 * MAIL FROM strings for each activity window. Only meaningful when the
 * operator sends from a dedicated IP — shared-IP senders see nothing
 * meaningful here.
 *
 * Auth is a per-account access key (no OAuth). The data endpoint returns
 * CSV. Snapshots are stored per (ip, activityStart) so historical windows
 * accumulate.
 */

import type { SndsConfig } from '../config.js'
import type { SndsFilterResult, SndsSnapshotDoc } from '../models/index.js'
import type { RunnerContext } from './index.js'

const SNDS_DATA_URL = 'https://postmaster.live.com/snds/data.aspx'
const FETCH_TIMEOUT_MS = 30_000

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface RunSndsOptions {
  fetcher?: Fetcher
  force?: boolean
}

export interface RunSndsResult {
  ran: boolean
  reason?: string
  rowsParsed?: number
  rowsPersisted?: number
}

export async function runSndsPull(
  ctx: RunnerContext,
  opts: RunSndsOptions = {},
): Promise<RunSndsResult> {
  const cfg = ctx.config.snds
  if (!cfg?.accessKey) return { ran: false, reason: 'not_configured' }

  const intervalHours = cfg.intervalHours ?? 24
  if (!opts.force && intervalHours <= 0) return { ran: false, reason: 'disabled' }

  if (!opts.force) {
    const latest = await ctx.collections.sndsSnapshots
      .find({})
      .sort({ fetchedAt: -1 })
      .limit(1)
      .toArray()
    if (latest[0]) {
      const ageMs = Date.now() - new Date(latest[0].fetchedAt).getTime()
      if (ageMs < intervalHours * 60 * 60 * 1000) {
        return { ran: false, reason: 'not_due' }
      }
    }
  }

  const fetcher = opts.fetcher ?? globalThis.fetch
  const url = `${SNDS_DATA_URL}?key=${encodeURIComponent(cfg.accessKey)}`
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetcher(url, { method: 'GET', signal: ctl.signal })
  } catch (err: any) {
    // Scrub the access key from any error message before it reaches a log.
    throw new Error(`SNDS data fetch failed: ${redactKey(String(err?.message ?? err), cfg.accessKey)}`)
  } finally {
    clearTimeout(t)
  }
  if (!res.ok) {
    throw new Error(`SNDS data fetch failed: ${res.status} ${redactKey(await safeText(res), cfg.accessKey)}`)
  }
  const csv = await res.text()
  const rows = parseSndsCsv(csv)

  const ipFilter = cfg.ips?.length ? new Set(cfg.ips) : null
  const now = new Date()
  const ops = rows
    .filter((row) => !ipFilter || ipFilter.has(row.ip))
    .map((row) => ({
      updateOne: {
        filter: { ip: row.ip, activityStart: row.activityStart },
        update: { $set: { ...row, fetchedAt: now } },
        upsert: true,
      },
    }))
  let persisted = 0
  if (ops.length > 0) {
    const r = await ctx.collections.sndsSnapshots.bulkWrite(ops, { ordered: false })
    persisted = (r.modifiedCount ?? 0) + (r.upsertedCount ?? 0)
  }

  return { ran: true, rowsParsed: rows.length, rowsPersisted: persisted }
}

function redactKey(s: string, key: string): string {
  if (!key) return s
  return s.split(key).join('<redacted>').split(encodeURIComponent(key)).join('<redacted>')
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text() } catch { return '<no body>' }
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

export interface ParsedSndsRow {
  ip: string
  activityStart: Date
  activityEnd: Date
  rcptCommands: number
  dataCommands: number
  messageRecipients: number
  filterResult: SndsFilterResult
  complaintRate: number | null
  trapMessageCount: number
  sampleHelo: string | null
  sampleMailFrom: string | null
}

/**
 * SNDS returns CSV with columns:
 *   IP, ActivityStart, ActivityEnd, RCPTCommands, DATACommands,
 *   MessageRecipients, FilterResult, ComplaintRate, TrapMessageCount,
 *   SampleHELO, SampleMailFrom
 *
 * No header row. Fields may contain commas inside quoted strings (sample
 * HELO / MAIL FROM) — we handle simple double-quote escaping.
 */
export function parseSndsCsv(csv: string): ParsedSndsRow[] {
  const out: ParsedSndsRow[] = []
  for (const raw of csv.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const fields = splitCsvRow(raw)
    if (fields.length < 7) continue // malformed row
    const parsed = parseRow(fields)
    if (parsed) out.push(parsed)
  }
  return out
}

function splitCsvRow(row: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((f) => f.trim())
}

function parseRow(fields: string[]): ParsedSndsRow | null {
  const [
    ip,
    activityStart,
    activityEnd,
    rcptCommands,
    dataCommands,
    messageRecipients,
    filterResult,
    complaintRate,
    trapMessageCount,
    sampleHelo,
    sampleMailFrom,
  ] = fields

  const start = parseSndsDate(activityStart ?? '')
  const end = parseSndsDate(activityEnd ?? '')
  if (!ip || !start || !end) return null

  return {
    ip,
    activityStart: start,
    activityEnd: end,
    rcptCommands: toInt(rcptCommands),
    dataCommands: toInt(dataCommands),
    messageRecipients: toInt(messageRecipients),
    filterResult: normalizeFilter(filterResult ?? ''),
    complaintRate: parseComplaintRate(complaintRate ?? ''),
    trapMessageCount: toInt(trapMessageCount),
    sampleHelo: sampleHelo ? sampleHelo : null,
    sampleMailFrom: sampleMailFrom ? sampleMailFrom : null,
  }
}

function toInt(s: string | undefined): number {
  if (!s) return 0
  const n = Number(s.replace(/[^\d-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function normalizeFilter(s: string): SndsFilterResult {
  const u = s.toUpperCase().trim()
  if (u === 'GREEN' || u === 'YELLOW' || u === 'RED') return u
  return 'UNKNOWN'
}

/**
 * SNDS reports complaint rate in the formats: `<0.1%`, `0.1-0.3%`, `0.3-0.5%`,
 * `0.5-1%`, `1-2%`, `2-4%`, `>4%`. We persist the upper bound as a 0-1 fraction.
 */
export function parseComplaintRate(s: string): number | null {
  const trimmed = s.trim()
  if (!trimmed || trimmed === '-' || /n\/?a/i.test(trimmed)) return null

  const cleaned = trimmed.replace(/%/g, '')
  // `<X` → X
  let m = /^<\s*(\d+(?:\.\d+)?)$/.exec(cleaned)
  if (m) return Number(m[1]) / 100
  // `>X` → X (lower bound; treat as the floor of what they're reporting)
  m = /^>\s*(\d+(?:\.\d+)?)$/.exec(cleaned)
  if (m) return Number(m[1]) / 100
  // `A-B` → B
  m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(cleaned)
  if (m) return Number(m[2]) / 100
  // Plain number
  m = /^(\d+(?:\.\d+)?)$/.exec(cleaned)
  if (m) return Number(m[1]) / 100
  return null
}

/**
 * SNDS reports dates as `M/D/YYYY h:mm AM/PM` in Microsoft's Pacific time
 * (PST/PDT) — Microsoft's own docs are silent but community testing
 * consistently shows Pacific. Convert to UTC by applying the offset that
 * was in effect at that local timestamp.
 *
 * Daylight saving in the US runs second-Sunday-of-March → first-Sunday-of-
 * November. We compute the offset based on the parsed local-Pacific
 * timestamp; a fixed -8/-7 offset would be wrong around the boundaries.
 */
export function parseSndsDate(s: string): Date | null {
  const trimmed = s.trim()
  if (!trimmed) return null
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(trimmed)
  if (m) {
    const month = Number(m[1]) - 1
    const day = Number(m[2])
    const year = Number(m[3])
    let hour = Number(m[4])
    const minute = Number(m[5])
    const second = Number(m[6] ?? 0)
    const meridiem = m[7]?.toUpperCase()
    if (meridiem === 'PM' && hour < 12) hour += 12
    if (meridiem === 'AM' && hour === 12) hour = 0
    // First place the wall-clock instant in UTC, then add the Pacific
    // offset to convert back to a real UTC moment.
    const wallMs = Date.UTC(year, month, day, hour, minute, second)
    if (!Number.isFinite(wallMs)) return null
    const offsetHours = isUsPacificDst(year, month, day) ? 7 : 8
    return new Date(wallMs + offsetHours * 60 * 60 * 1000)
  }
  // Fallback: ISO-ish strings get parsed as expected by Date.
  const d = new Date(trimmed)
  if (!isNaN(d.getTime())) return d
  return null
}

/**
 * US daylight saving runs from the second Sunday of March through the
 * first Sunday of November. Pure date math against the wall-clock day —
 * close enough for SNDS export granularity (full-day activity windows).
 */
function isUsPacificDst(year: number, month0: number, day: number): boolean {
  if (month0 > 2 && month0 < 10) return true
  if (month0 < 2 || month0 > 10) return false
  // March: starts on second Sunday.
  if (month0 === 2) {
    const dst = nthSundayOfMonth(year, 2, 2)
    return day >= dst
  }
  // November: ends on first Sunday.
  const dst = nthSundayOfMonth(year, 10, 1)
  return day < dst
}

function nthSundayOfMonth(year: number, month0: number, n: number): number {
  const first = new Date(Date.UTC(year, month0, 1))
  const dayOfWeek = first.getUTCDay()
  const firstSunday = 1 + ((7 - dayOfWeek) % 7)
  return firstSunday + (n - 1) * 7
}
