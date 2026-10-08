/**
 * `mailery doctor` — read-only health report for a 0.21 upgrade.
 *
 * The checks take a `Db` so they run in tests against mongodb-memory-server.
 * The CLI wrapper connects with the same env vars as `Mailer.fromEnv`
 * (`MAILER_MONGODB_URI`, `MAILER_MONGODB_DB`) and needs nothing else.
 *
 * What it cannot see: `MailerConfig` lives in host code, so declared categories
 * are only compared when `--categories a,b` is passed, and `factsAdapter` /
 * `contactPolicy` are not inspected at all (publish validation and
 * `setProgramEnabled` check the adapter at the point it matters).
 *
 * Exit code is non-zero when any check is `fail` — a problem that would make a
 * Program tick fail or misbehave. `warn` is worth reading; `info` is context.
 */

import type { Db } from 'mongodb'

import { categoryScopeSchema, programDefinitionSchema } from '../shared/schemas.js'
import { getCollections } from '../server/models/index.js'
import { findRequiresCycle, referencedTemplateSlugs } from '../server/programs/validate.js'
import type { ProgramDefinition } from '../shared/types.js'

export type DoctorStatus = 'ok' | 'info' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  status: DoctorStatus
  title: string
  /** Specifics: slugs, ids, counts. */
  detail: string[]
}

export interface DoctorReport {
  version: string
  ok: boolean
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  version: string
  /** Declared category ids (host config cannot be read from here). */
  categories?: string[]
  /** Collection prefix. Default `mailer_`. */
  prefix?: string
  now?: Date
  /** A lease expired more than this long ago is reported. Default 10 minutes. */
  staleLeaseMs?: number
}

const STATIC_SCOPES = new Set(['all', 'marketing', 'transactional'])

/** Index key patterns the 0.21 collections need (see models/index.ts `ensureIndexes`). */
const EXPECTED_INDEXES: Array<{ coll: string; keys: Record<string, 1 | -1>; why: string }> = [
  { coll: 'programs', keys: { slug: 1 }, why: 'unique slug' },
  { coll: 'program_versions', keys: { programId: 1, version: 1 }, why: 'unique version per program' },
  { coll: 'program_runs', keys: { programSlug: 1, subjectId: 1 }, why: 'one run per subject (unique)' },
  { coll: 'program_runs', keys: { programSlug: 1, enteredAt: -1 }, why: 'runs list, newest first' },
  { coll: 'program_runs', keys: { status: 1, nextTickAt: 1 }, why: 'scheduler scan' },
  { coll: 'program_decisions', keys: { runId: 1, at: -1 }, why: 'run timeline' },
  { coll: 'contact_locks', keys: { expiresAt: 1 }, why: 'TTL for the contact-policy lock' },
]

const same = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a) === JSON.stringify(b)

export async function runDoctor(db: Db, opts: DoctorOptions): Promise<DoctorReport> {
  const prefix = opts.prefix ?? 'mailer_'
  const c = getCollections(db, prefix)
  const now = opts.now ?? new Date()
  const checks: DoctorCheck[] = []
  const add = (id: string, status: DoctorStatus, title: string, detail: string[] = []) =>
    checks.push({ id, status, title, detail })

  add('version', 'info', `mailery ${opts.version}`)

  // Templates and categories ------------------------------------------------------
  const marketing = await c.templates
    .find({ kind: 'marketing' }, { projection: { slug: 1, category: 1 } })
    .toArray()
  const uncategorised = marketing.filter((t) => !t.category).map((t) => t.slug)
  if (uncategorised.length === 0) {
    add('templates-uncategorised', 'ok', 'Every marketing template has a category')
  } else {
    add(
      'templates-uncategorised',
      'warn',
      `${uncategorised.length} marketing template(s) have no category (their unsubscribe link stays "all marketing")`,
      uncategorised.sort(),
    )
  }

  const used = [...new Set(marketing.map((t) => t.category).filter((x): x is string => !!x))].sort()
  const declaredList = opts.categories ?? []
  if (opts.categories && declaredList.length === 0) {
    add(
      'categories-flag-empty',
      'warn',
      '--categories was given without a value: comparison skipped (pass --categories a,b, or omit the flag)',
    )
  }
  if (declaredList.length > 0) {
    const declared = new Set(opts.categories)
    const undeclared = used.filter((u) => !declared.has(u))
    const unused = declaredList.filter((d) => !used.includes(d))
    if (undeclared.length > 0) {
      add('categories-undeclared', 'warn', 'Templates use categories that are not declared', undeclared)
    } else {
      add('categories-undeclared', 'ok', 'Every category used by a template is declared')
    }
    add('categories-unused', unused.length > 0 ? 'info' : 'ok', 'Declared categories no template uses', unused)
  } else {
    add(
      'categories-used',
      'info',
      'Categories used by templates (pass --categories a,b to compare with the declared set)',
      used,
    )
  }

  // Programs --------------------------------------------------------------------
  const programs = await c.programs.find().toArray()
  const enabled = programs.filter((p) => p.enabled)
  add(
    'programs',
    'info',
    programs.length === 0
      ? 'No Programs configured'
      : `${programs.length} Program(s), ${enabled.length} enabled`,
    programs.map((p) => `${p.slug} v${p.version} ${p.enabled ? 'enabled' : 'disabled'}`),
  )

  // Indexes ---------------------------------------------------------------------
  const programsInUse = programs.length > 0
  const missing: string[] = []
  const indexCache = new Map<string, Array<{ key: Record<string, unknown> }>>()
  for (const e of EXPECTED_INDEXES) {
    if (!indexCache.has(e.coll)) {
      try {
        indexCache.set(e.coll, (await db.collection(`${prefix}${e.coll}`).indexes()) as any)
      } catch {
        indexCache.set(e.coll, [])
      }
    }
    if (!indexCache.get(e.coll)!.some((ix) => same(ix.key, e.keys))) {
      missing.push(`${prefix}${e.coll} ${JSON.stringify(e.keys)} (${e.why})`)
    }
  }
  if (missing.length === 0) {
    add('indexes', 'ok', 'Program and contact-lock indexes are present')
  } else {
    add(
      'indexes',
      programsInUse ? 'fail' : 'warn',
      'Missing indexes: start the app once with 0.21 (Mailer.init syncs indexes) before enabling Programs',
      missing,
    )
  }

  // Suppression scopes -----------------------------------------------------------
  const scopes = await c.suppressions.distinct('scope')
  const unknown = (scopes as string[]).filter(
    (s) => !STATIC_SCOPES.has(s) && !categoryScopeSchema.safeParse(s).success,
  )
  if (unknown.length === 0) {
    add('suppression-scopes', 'ok', 'Every suppression scope is recognised')
  } else {
    const counts: string[] = []
    for (const s of unknown) counts.push(`${s} (${await c.suppressions.countDocuments({ scope: s as any })} row(s))`)
    add('suppression-scopes', 'warn', 'Suppression rows with an unrecognised scope (they suppress nothing)', counts)
  }

  // Stale leases -----------------------------------------------------------------
  const staleBefore = new Date(now.getTime() - (opts.staleLeaseMs ?? 10 * 60_000))
  const stale = await c.programRuns
    .find({ 'lease.until': { $lt: staleBefore } }, { projection: { programSlug: 1, subjectId: 1, lease: 1 } })
    .limit(50)
    .toArray()
  if (stale.length === 0) {
    add('stale-leases', 'ok', 'No Program run holds a lease that expired more than 10 minutes ago')
  } else {
    add(
      'stale-leases',
      'warn',
      'Program runs with a lease expired > 10 minutes ago (is the scheduler running? an expired lease is reclaimed on the next sweep)',
      stale.map((r) => `${r.programSlug}/${r.subjectId} lease expired ${r.lease!.until.toISOString()}`),
    )
  }

  // Enabled programs: definition integrity ------------------------------------------
  const problems: string[] = []
  for (const p of enabled) {
    if (!p.definition) {
      problems.push(`${p.slug}: enabled but has no published definition`)
      continue
    }
    const parsed = programDefinitionSchema.safeParse(p.definition)
    if (!parsed.success) {
      for (const i of parsed.error.issues) problems.push(`${p.slug}: ${i.path.join('.') || '(root)'} ${i.message}`)
      continue
    }
    const def = parsed.data as ProgramDefinition
    const cycle = findRequiresCycle(def)
    if (cycle) problems.push(`${p.slug}: requires cycle ${cycle.join(' -> ')}`)
    const slugs = referencedTemplateSlugs(def)
    const rows = await c.templates
      .find({ slug: { $in: slugs } }, { projection: { slug: 1, kind: 1, category: 1 } })
      .toArray()
    const bySlug = new Map(rows.map((t) => [t.slug, t]))
    for (const s of slugs) {
      const t = bySlug.get(s)
      if (!t) problems.push(`${p.slug}: template "${s}" does not exist`)
      else if (t.kind !== 'marketing') problems.push(`${p.slug}: template "${s}" is not marketing`)
      else if ((t.category ?? null) !== def.category) {
        problems.push(`${p.slug}: template "${s}" has category ${t.category ?? '(none)'}, program is ${def.category}`)
      }
    }
    if (declaredList.length > 0 && !declaredList.includes(def.category)) {
      problems.push(`${p.slug}: category "${def.category}" is not in --categories`)
    }
  }
  if (enabled.length === 0) {
    add('programs-valid', 'ok', 'No enabled Programs to validate')
  } else if (problems.length === 0) {
    add('programs-valid', 'ok', `${enabled.length} enabled Program(s) have valid structure and existing templates`)
  } else {
    add('programs-valid', 'fail', 'Enabled Programs that would fail to tick', problems)
  }

  return { version: opts.version, ok: !checks.some((k) => k.status === 'fail'), checks }
}

export function formatDoctor(report: DoctorReport): string {
  const tag: Record<DoctorStatus, string> = { ok: '[ ok ]', info: '[info]', warn: '[warn]', fail: '[FAIL]' }
  const lines: string[] = []
  for (const k of report.checks) {
    lines.push(`${tag[k.status]} ${k.title}`)
    for (const d of k.detail) lines.push(`         ${d}`)
  }
  lines.push('')
  lines.push(report.ok ? 'doctor: no blocking problems' : 'doctor: blocking problems found (see [FAIL])')
  return lines.join('\n')
}
