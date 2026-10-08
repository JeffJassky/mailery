/**
 * A template a published Program sends must stay marketing and stay in that
 * program's category (INVARIANTS 3, 4, 8). Every template write path asks this
 * before it changes `kind` or `category`.
 */

import type { Collections } from '../models/index.js'
import { referencedTemplateSlugs } from './validate.js'

export async function programTemplateConflict(
  c: Collections,
  slug: string,
  next: { kind: 'marketing' | 'transactional'; category: string | null | undefined },
): Promise<string | null> {
  const programs = await c.programs.find({ definition: { $ne: null } }, { projection: { slug: 1, definition: 1 } }).toArray()
  const problems: string[] = []
  for (const p of programs) {
    const def = p.definition
    if (!def || !referencedTemplateSlugs(def).includes(slug)) continue
    if (next.kind !== 'marketing') problems.push(`program "${p.slug}" sends it, so it must stay marketing`)
    else if ((next.category ?? null) !== def.category) problems.push(`program "${p.slug}" sends it, so it must stay in category "${def.category}"`)
  }
  return problems.length ? `template "${slug}" is used by a program: ${problems.join('; ')}` : null
}
