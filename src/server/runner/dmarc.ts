/**
 * DMARC RUA aggregate report ingestion.
 *
 *   - extractDmarcXml(buffer, filename) — decompresses .zip / .gz / .xml
 *   - parseDmarcReport(xml) — pure RFC 7489 XML → normalized doc + failures
 *   - ingestDmarcAttachment(ctx, buffer, filename) — full ingest path:
 *       extract → parse → upsert into mailer_dmarc_reports + _dmarc_failures
 *
 * Designed so the same `ingestDmarcAttachment` is used by:
 *   - the admin file-upload endpoint
 *   - the (future) SendGrid Inbound Parse webhook
 *   - the (future) IMAP poller
 *   - the `mailery ingest-dmarc` CLI
 */

// Heavy parsers are loaded lazily inside the functions that need them so
// the testing bundle doesn't drag adm-zip + fast-xml-parser through.
import type AdmZipType from 'adm-zip'
import type { XMLParser as XMLParserType } from 'fast-xml-parser'

import type {
  DmarcAuthResult,
  DmarcFailureDoc,
  DmarcPolicy,
  DmarcReportDoc,
} from '../models/index.js'
import type { RunnerContext } from './index.js'

/**
 * Hard cap on decompressed bytes. A real RUA aggregate report is well under
 * 1 MB; anything above this is either malformed or an attempted zip bomb.
 */
const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024

/**
 * Reject zip entry names that would escape the extraction directory if we
 * were writing them to disk, plus null-byte injection. We only ever read
 * the buffer in memory, but defense-in-depth keeps us safe if the storage
 * model changes.
 */
export function assertSafeZipEntryName(rawName: string): void {
  if (typeof rawName !== 'string' || rawName.length === 0) {
    throw new Error(`zip entry has unsafe path: <empty>`)
  }
  if (rawName.includes('\0')) {
    throw new Error(`zip entry has unsafe path: contains null byte`)
  }
  // POSIX absolute (`/etc/passwd`) or Windows-drive (`C:\…`) paths.
  if (rawName.startsWith('/') || rawName.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(rawName)) {
    throw new Error(`zip entry has unsafe path: ${rawName}`)
  }
  const parts = rawName.split(/[/\\]/)
  if (parts.some((p) => p === '..')) {
    throw new Error(`zip entry has unsafe path: ${rawName}`)
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Pull DMARC XML payload(s) out of an attachment. Receivers send `.zip` or
 * `.gz` (or rarely a bare `.xml`). A multi-file zip returns each entry as a
 * separate string — concatenating them with `\n` produces invalid XML with
 * two `<feedback>` roots.
 *
 * Defends against:
 *   - decompression bombs — caps inflated bytes at MAX_DECOMPRESSED_BYTES
 *   - zip-slip path traversal — rejects entries with absolute or `..` paths
 *   - empty / malformed archives — throws with a useful message
 */
export async function extractDmarcXmls(buffer: Buffer, filename: string): Promise<string[]> {
  const lower = (filename ?? '').toLowerCase()
  const zlib = await import('node:zlib')

  if (lower.endsWith('.gz')) {
    const xml = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      let bytes = 0
      const stream = zlib.createGunzip()
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_DECOMPRESSED_BYTES) {
          stream.destroy()
          reject(new Error(`DMARC gzip exceeds ${MAX_DECOMPRESSED_BYTES} bytes (decompression bomb?)`))
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
      stream.end(buffer)
    })
    return [xml]
  }

  if (lower.endsWith('.zip')) {
    const { default: AdmZip } = await import('adm-zip')
    const zip = new (AdmZip as unknown as typeof AdmZipType)(buffer)
    const entries = zip.getEntries().filter((e) => !e.isDirectory)
    if (entries.length === 0) throw new Error('zip contains no files')

    let total = 0
    const pieces: string[] = []
    for (const entry of entries) {
      // Zip-slip defense — adm-zip has had CVE history (CVE-2018-1002204).
      assertSafeZipEntryName(entry.entryName)

      // Declared size is the fast-path bail — reject before decompressing
      // when a (truthful) header already exceeds the cap. Reject entries
      // with no declared size at all (DMARC receivers always populate it).
      const declaredSize = (entry.header as any)?.size
      if (typeof declaredSize !== 'number' || declaredSize <= 0) {
        throw new Error(`zip entry ${entry.entryName} has no declared size (refusing to decompress)`)
      }
      if (declaredSize > MAX_DECOMPRESSED_BYTES || total + declaredSize > MAX_DECOMPRESSED_BYTES) {
        throw new Error(`DMARC zip exceeds ${MAX_DECOMPRESSED_BYTES} bytes (decompression bomb?)`)
      }

      // Actual decompressed payload — defends against a forged header that
      // claims a tiny size but inflates huge. We pay the inflation cost for
      // this entry, but cap on cumulative real bytes before the next entry.
      const data = entry.getData()
      total += data.length
      if (total > MAX_DECOMPRESSED_BYTES) {
        throw new Error(`DMARC zip decompressed payload exceeds ${MAX_DECOMPRESSED_BYTES} bytes (forged header?)`)
      }
      // Compression-ratio sanity check only kicks in on larger entries —
      // legitimate tiny XML inflates ~64x routinely. The cumulative cap
      // above already covers the real bomb scenarios for small entries.
      if (declaredSize > 10 * 1024 && data.length > declaredSize * 64 + 1024) {
        throw new Error(`DMARC zip entry ${entry.entryName} decompressed size (${data.length}) far exceeds declared (${declaredSize})`)
      }
      pieces.push(data.toString('utf8'))
    }
    return pieces
  }

  // Treat as raw XML — still cap by raw buffer size.
  if (buffer.length > MAX_DECOMPRESSED_BYTES) {
    throw new Error(`DMARC payload exceeds ${MAX_DECOMPRESSED_BYTES} bytes`)
  }
  return [buffer.toString('utf8')]
}

/**
 * Convenience wrapper for callers that handle a single report.
 * @deprecated prefer `extractDmarcXmls` so multi-file zips can be parsed
 * independently. Kept temporarily; remove once all callers migrate.
 */
export async function extractDmarcXml(buffer: Buffer, filename: string): Promise<string> {
  const xmls = await extractDmarcXmls(buffer, filename)
  return xmls.join('\n')
}

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

export interface ParsedDmarcReport {
  report: Omit<DmarcReportDoc, 'receivedAt'>
  failures: Array<Omit<DmarcFailureDoc, 'receivedAt'>>
}

/**
 * Parse RFC 7489 aggregate report XML. Tolerant — receivers vary slightly in
 * casing and field order. Throws if the XML can't be parsed at all or if
 * required identifiers (report_id, domain, date_range) are missing.
 */
export function parseDmarcReport(xml: string): ParsedDmarcReport {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { XMLParser } = require('fast-xml-parser') as { XMLParser: typeof XMLParserType }
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    // RFC 7489 specifies lowercase snake_case tag names, but some
    // less-careful receivers emit CamelCase. Normalize before lookup.
    transformTagName: (t: string) => t.toLowerCase(),
  })
  const root: any = parser.parse(xml)
  const fb = root?.feedback
  if (!fb) throw new Error('DMARC XML missing <feedback> root')

  const meta = fb.report_metadata ?? {}
  const policy = fb.policy_published ?? {}

  const reportId = String(meta.report_id ?? '').trim()
  const orgName = String(meta.org_name ?? '').trim()
  const email = String(meta.email ?? '').trim()
  const domain = String(policy.domain ?? '').trim().toLowerCase()
  const policyP = (policy.p ?? 'none') as DmarcPolicy
  const rawPct = Number(policy.pct ?? 100)
  // Use isFinite so pct=0 (legit "monitor only" config) survives.
  const policyPct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 100

  if (!reportId) throw new Error('DMARC XML missing report_id')
  if (!domain) throw new Error('DMARC XML missing policy_published.domain')

  const range = meta.date_range ?? {}
  const begin = secondsToDate(range.begin)
  const end = secondsToDate(range.end)
  if (!begin || !end) throw new Error('DMARC XML missing date_range')

  const records = toArray<any>(fb.record)
  const failures: ParsedDmarcReport['failures'] = []
  let totalMessages = 0
  let passCount = 0
  let failCount = 0

  // Day bucket = mid-point of the report window.
  const midMs = Math.floor((begin.getTime() + end.getTime()) / 2)
  const day = new Date(midMs).toISOString().slice(0, 10)

  for (const rec of records) {
    const row = rec?.row ?? {}
    const count = Number(row.count ?? 0) || 0
    totalMessages += count

    const evald = row.policy_evaluated ?? {}
    const dkim = (evald.dkim ?? 'none') as DmarcAuthResult
    const spf = (evald.spf ?? 'none') as DmarcAuthResult
    const aligned = dkim === 'pass' || spf === 'pass'

    if (aligned) {
      passCount += count
      continue
    }
    failCount += count

    const sourceIp = String(row.source_ip ?? '').trim()
    if (!sourceIp) continue
    const headerFrom = String(rec?.identifiers?.header_from ?? '').toLowerCase()
    const dispositionApplied = String(evald.disposition ?? 'none')

    failures.push({
      reportId,
      domain,
      sourceIp,
      count,
      headerFrom,
      dkimResult: dkim,
      spfResult: spf,
      dispositionApplied,
      day,
    })
  }

  return {
    report: {
      reportId,
      orgName,
      email,
      domain,
      policyP,
      policyPct,
      rangeStart: begin,
      rangeEnd: end,
      totalMessages,
      passCount,
      failCount,
    },
    failures,
  }
}

function secondsToDate(v: unknown): Date | null {
  if (v === undefined || v === null) return null
  const n = typeof v === 'number' ? v : Number(String(v))
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000)
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface IngestResult {
  ok: true
  reportId: string
  domain: string
  rangeStart: Date
  rangeEnd: Date
  totalMessages: number
  passCount: number
  failCount: number
  duplicate: boolean
}

/**
 * Full ingest path: extract attachment → parse each XML payload → upsert
 * into mailer_dmarc_reports + mailer_dmarc_failures. Idempotent on
 * (reportId, orgName) — re-uploading the same report is a no-op. When the
 * attachment is a multi-file zip, each entry is parsed independently and
 * the first ingest result is returned (with `additionalReports` count).
 */
export async function ingestDmarcAttachment(
  ctx: RunnerContext,
  buffer: Buffer,
  filename: string,
): Promise<IngestResult & { additionalReports?: number }> {
  const xmls = await extractDmarcXmls(buffer, filename)
  if (xmls.length === 0) throw new Error('attachment contained no XML payload')
  const results: IngestResult[] = []
  let firstError: unknown = null
  for (const xml of xmls) {
    try {
      const parsed = parseDmarcReport(xml)
      results.push(await ingestParsedDmarcReport(ctx, parsed))
    } catch (err) {
      if (!firstError) firstError = err
      // Continue ingesting siblings — one malformed report in a multi-file
      // archive shouldn't reject all valid siblings.
    }
  }
  if (results.length === 0) {
    throw firstError ?? new Error('no parseable DMARC reports in attachment')
  }
  return { ...results[0]!, additionalReports: results.length - 1 }
}

export async function ingestParsedDmarcReport(
  ctx: RunnerContext,
  parsed: ParsedDmarcReport,
): Promise<IngestResult> {
  const now = new Date()
  const { report, failures } = parsed

  // Race-safe duplicate detection — let the unique index on
  // (reportId, orgName) decide. The prior findOne→insertOne split admitted
  // a window where two concurrent uploads of the same report could both
  // succeed.
  let duplicate = false
  try {
    await ctx.collections.dmarcReports.insertOne({ ...report, receivedAt: now })
  } catch (err: any) {
    if (err?.code === 11000) {
      duplicate = true
    } else {
      throw err
    }
  }

  if (!duplicate && failures.length > 0) {
    // Idempotent: unique index on (reportId, sourceIp) — duplicates skipped.
    // BulkWriteError mixes real + duplicate-key errors; inspect each write
    // error and rethrow if any aren't 11000.
    try {
      await ctx.collections.dmarcFailures.insertMany(
        failures.map((f) => ({ ...f, receivedAt: now })),
        { ordered: false },
      )
    } catch (err: any) {
      const writeErrors: Array<{ code?: number }> | undefined = err?.writeErrors
      if (Array.isArray(writeErrors)) {
        const nonDup = writeErrors.find((w) => w?.code !== 11000)
        if (nonDup) throw err
      } else if (err?.code !== 11000) {
        throw err
      }
    }
  }

  return {
    ok: true,
    reportId: report.reportId,
    domain: report.domain,
    rangeStart: report.rangeStart,
    rangeEnd: report.rangeEnd,
    totalMessages: report.totalMessages,
    passCount: report.passCount,
    failCount: report.failCount,
    duplicate,
  }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// Throttle DMARC prune so it doesn't fire on every tick (60s default). Once
// per hour is plenty — failure rows live for retentionDays (default 90).
let _lastPruneAt = 0
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

export async function pruneDmarcFailures(ctx: RunnerContext, opts: { force?: boolean } = {}): Promise<number> {
  const cfg = ctx.config.dmarc
  const days = cfg?.retentionDays ?? 90
  if (days <= 0) return 0
  if (!opts.force && Date.now() - _lastPruneAt < PRUNE_INTERVAL_MS) return 0
  _lastPruneAt = Date.now()
  const cutoff = new Date(Date.now() - days * 86_400_000)
  const r = await ctx.collections.dmarcFailures.deleteMany({ receivedAt: { $lt: cutoff } })
  return r.deletedCount ?? 0
}

// ---------------------------------------------------------------------------
// Source tags — merge config-defined + db-defined
// ---------------------------------------------------------------------------

export interface ResolvedSourceTag {
  ip: string
  label: string
  ignored: boolean
  /** 'config' = read-only (set in MailerConfig), 'db' = mutable from UI. */
  source: 'config' | 'db'
}

export async function resolveSourceTags(ctx: RunnerContext): Promise<Map<string, ResolvedSourceTag>> {
  const out = new Map<string, ResolvedSourceTag>()
  for (const t of ctx.config.dmarc?.knownSources ?? []) {
    out.set(t.ip, { ip: t.ip, label: t.label, ignored: !!t.ignored, source: 'config' })
  }
  // DB tags override config tags so the operator can re-label without redeploy.
  const dbTags = await ctx.collections.dmarcSourceTags.find({}).toArray()
  for (const t of dbTags) {
    out.set(t.ip, { ip: t.ip, label: t.label, ignored: t.ignored, source: 'db' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Policy progression suggestion
// ---------------------------------------------------------------------------

export interface DomainProgression {
  domain: string
  currentPolicy: 'none' | 'quarantine' | 'reject' | null
  currentPct: number | null
  /** null when no suggestion (already at strictest, or insufficient data). */
  suggested: { policy: 'none' | 'quarantine' | 'reject'; pct: number; reason: string } | null
}

/**
 * Heuristic: walk through the DMARC ramp progression.
 *   p=none      → suggest p=quarantine pct=10  when last 30d alignment ≥99%
 *                 from non-ignored sources AND ≥30 reports AND ≥1k messages
 *   p=quarantine pct<100 → ramp pct (10→25→50→100) when alignment stays high
 *   p=quarantine pct=100 → suggest p=reject when alignment ≥99.9% for 14+ days
 *   p=reject    → no suggestion (already at strictest)
 *
 * Pure function so it's easy to unit-test.
 */
export interface ProgressionInput {
  reports: Array<{ rangeEnd: Date; passCount: number; failCount: number }>
  failures: Array<{ sourceIp: string; count: number; receivedAt: Date }>
  knownSourceIps: Set<string>
  ignoredSourceIps: Set<string>
  currentPolicy: 'none' | 'quarantine' | 'reject' | null
  currentPct: number | null
}

export function suggestPolicyProgression(input: ProgressionInput): DomainProgression['suggested'] {
  const { reports, failures, knownSourceIps, ignoredSourceIps, currentPolicy, currentPct } = input

  if (currentPolicy === 'reject') return null

  const since30 = Date.now() - 30 * 86_400_000
  const recentReports = reports.filter((r) => r.rangeEnd.getTime() >= since30)
  const totalMsgs = recentReports.reduce((acc, r) => acc + r.passCount + r.failCount, 0)
  const totalPass = recentReports.reduce((acc, r) => acc + r.passCount, 0)

  if (recentReports.length < 30) return null
  if (totalMsgs < 1000) return null

  // Failures from untagged (and non-ignored) sources mean we don't yet know
  // who they are — never tighten policy until they're identified.
  const untaggedFailures = failures.filter(
    (f) => f.receivedAt.getTime() >= since30 && !knownSourceIps.has(f.sourceIp) && !ignoredSourceIps.has(f.sourceIp),
  )
  if (untaggedFailures.length > 0) return null

  const alignmentRate = totalMsgs === 0 ? 0 : totalPass / totalMsgs

  if (currentPolicy === null || currentPolicy === 'none') {
    if (alignmentRate >= 0.99) {
      return {
        policy: 'quarantine',
        pct: 10,
        reason: `${(alignmentRate * 100).toFixed(2)}% alignment over ${recentReports.length} reports / ${totalMsgs.toLocaleString()} messages, all known sources tagged.`,
      }
    }
    return null
  }

  if (currentPolicy === 'quarantine') {
    const pct = currentPct ?? 100
    if (alignmentRate < 0.995) return null
    if (pct < 25) return { policy: 'quarantine', pct: 25, reason: `Alignment held at ${(alignmentRate * 100).toFixed(2)}% — safe to ramp pct from ${pct} to 25.` }
    if (pct < 50) return { policy: 'quarantine', pct: 50, reason: `Alignment held at ${(alignmentRate * 100).toFixed(2)}% — safe to ramp pct from ${pct} to 50.` }
    if (pct < 100) return { policy: 'quarantine', pct: 100, reason: `Alignment held at ${(alignmentRate * 100).toFixed(2)}% — safe to ramp pct from ${pct} to 100.` }

    // pct=100 + alignment ≥99.9% for 14+ days → suggest reject
    if (alignmentRate >= 0.999) {
      return { policy: 'reject', pct: 100, reason: `Alignment at ${(alignmentRate * 100).toFixed(3)}% with policy=quarantine pct=100 — safe to move to p=reject.` }
    }
  }

  return null
}
