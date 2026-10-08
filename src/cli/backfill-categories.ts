/**
 * `mailery backfill-categories --map slug=category[,slug=category] [--dry-run]`
 *
 * Sets `category` on marketing templates. Refuses transactional templates
 * (outside preferences), validates the id with `categoryIdSchema`, never
 * overwrites a different existing category unless `overwrite` is set, writes
 * one audit row per change, and is idempotent: a template that already has the
 * category is reported `unchanged` and not touched.
 *
 * It cannot read `MailerConfig.categories` (that lives in host code), so
 * declared-ness is not checked here; `Mailer.publishProgram` and the template
 * routes check it. Run `mailery doctor --categories a,b` after to compare.
 */

import type { Db } from 'mongodb'

import { categoryIdSchema } from '../shared/schemas.js'
import { getCollections } from '../server/models/index.js'

export type BackfillOutcome =
  | { slug: string; category: string; status: 'changed' | 'would-change'; previous: string | null }
  | { slug: string; category: string; status: 'unchanged' }
  | { slug: string; category: string; status: 'error'; message: string }

export interface BackfillOptions {
  dryRun?: boolean
  /** Replace a different category that is already set. Default false. */
  overwrite?: boolean
  actor?: string
  /** Collection prefix. Default `mailer_`. */
  prefix?: string
}

/** Parse `a=x,b=y` (or repeated flags joined by the caller). Throws on malformed pairs. */
export function parseCategoryMap(input: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const part of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq <= 0 || eq === part.length - 1) throw new Error(`bad pair "${part}": expected slug=category`)
    out.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()])
  }
  if (out.length === 0) throw new Error('--map is empty: expected slug=category[,slug=category]')
  return out
}

export async function backfillCategories(
  db: Db,
  map: Array<[string, string]>,
  opts: BackfillOptions = {},
): Promise<BackfillOutcome[]> {
  const c = getCollections(db, opts.prefix ?? 'mailer_')
  const actor = opts.actor ?? 'cli:backfill-categories'
  const results: BackfillOutcome[] = []

  for (const [slug, category] of map) {
    const idCheck = categoryIdSchema.safeParse(category)
    if (!idCheck.success) {
      results.push({ slug, category, status: 'error', message: `invalid category id: ${idCheck.error.issues[0]?.message}` })
      continue
    }
    const tpl = await c.templates.findOne({ slug }, { projection: { _id: 1, kind: 1, category: 1 } })
    if (!tpl) {
      results.push({ slug, category, status: 'error', message: 'template not found' })
      continue
    }
    if (tpl.kind !== 'marketing') {
      results.push({ slug, category, status: 'error', message: 'transactional templates cannot have a category' })
      continue
    }
    const previous = tpl.category ?? null
    if (previous === category) {
      results.push({ slug, category, status: 'unchanged' })
      continue
    }
    if (previous && !opts.overwrite) {
      results.push({ slug, category, status: 'error', message: `already has category "${previous}" (pass --overwrite to replace it)` })
      continue
    }
    if (opts.dryRun) {
      results.push({ slug, category, status: 'would-change', previous })
      continue
    }
    const now = new Date()
    await c.templates.updateOne({ _id: tpl._id }, { $set: { category, updatedAt: now } })
    await c.auditLog.insertOne({
      actor,
      action: 'template.backfill_category',
      resource: { collection: `${opts.prefix ?? 'mailer_'}templates`, id: tpl._id, slug },
      before: { category: previous },
      after: { category },
      diffSummary: `category ${previous ?? '(none)'} -> ${category}`,
      ip: null,
      userAgent: null,
      requestId: null,
      occurredAt: now,
    })
    results.push({ slug, category, status: 'changed', previous })
  }
  return results
}

export function formatBackfill(results: BackfillOutcome[], dryRun: boolean): string {
  const lines = results.map((r) => {
    switch (r.status) {
      case 'changed': return `  set        ${r.slug} -> ${r.category}`
      case 'would-change': return `  would set  ${r.slug} -> ${r.category}`
      case 'unchanged': return `  unchanged  ${r.slug} (already ${r.category})`
      case 'error': return `  ERROR      ${r.slug}: ${r.message}`
    }
  })
  const errors = results.filter((r) => r.status === 'error').length
  lines.push(`${dryRun ? '(dry run) ' : ''}${results.length} template(s), ${errors} error(s)`)
  return lines.join('\n')
}
