/**
 * Program lint (board): publish-validation issues as errors, plus warnings
 * that do not block publish. plans/16-program-board.md §4.
 */

import type { ProgramLintIssue } from '../../shared/program-board.js'
import { programDefinitionSchema } from '../../shared/schemas.js'
import type { ProgramDefinition } from '../../shared/types.js'
import { SUNSET_ASK_ACTION_ID, validateProgramDefinition } from './validate.js'
import type { ProgramValidationContext } from './validate.js'

export interface ProgramLintContext extends Omit<ProgramValidationContext, 'templates'> {
  /** Every template the program references, by slug. `published`: has a published body. */
  templates: Map<string, { kind: 'marketing' | 'transactional'; category?: string | null; published: boolean }>
}

const ASK_PATH = 'policy.sunset.askTemplateSlug'
const PATH_RE = /^actions\.(\d+)(?:\.attempts\.(\d+))?/

/**
 * Lint a definition (any input; a structurally invalid one yields only
 * `invalid` errors). Order: errors first in validation order, then warnings
 * in definition order.
 */
export function lintProgram(input: unknown, ctx: ProgramLintContext): ProgramLintIssue[] {
  const result = validateProgramDefinition(input, ctx)
  const errors: ProgramLintIssue[] = result.ok
    ? []
    : result.issues.map((i) => ({
        severity: 'error' as const,
        code: 'invalid' as const,
        path: i.path,
        message: i.message,
        ...locate(i.path, input),
      }))
  // Warnings need a parsed definition; semantic errors (a missing template, an
  // unknown fact) still leave one, and the author wants both lists at once.
  const parsed = programDefinitionSchema.safeParse(input)
  const def = parsed.success ? (parsed.data as ProgramDefinition) : null
  if (!def) return errors
  const invalidPaths = new Set(errors.map((e) => e.path))
  return [...errors, ...warnings(def, ctx, invalidPaths)]
}

/** The action (and 1-based attempt) a validation path points into. */
function locate(path: string, raw: unknown): { actionId?: string; attempt?: number } {
  if (path === ASK_PATH) return { actionId: SUNSET_ASK_ACTION_ID }
  const m = PATH_RE.exec(path)
  if (!m) return {}
  const id = (raw as { actions?: Array<{ id?: unknown } | null> } | null)?.actions?.[Number(m[1])]?.id
  return {
    ...(typeof id === 'string' ? { actionId: id } : {}),
    ...(m[2] !== undefined ? { attempt: Number(m[2]) + 1 } : {}),
  }
}

function warnings(def: ProgramDefinition, ctx: ProgramLintContext, invalidPaths: Set<string>): ProgramLintIssue[] {
  const out: ProgramLintIssue[] = []
  const firstUse = new Map<string, string>()

  const checkTemplate = (slug: string, path: string, where: string, actionId: string, attempt?: number): void => {
    const at = { actionId, ...(attempt !== undefined ? { attempt } : {}) }
    if (!invalidPaths.has(path) && ctx.templates.get(slug)?.published === false) {
      out.push({ severity: 'warning', code: 'template-unpublished', path, message: `template "${slug}" has no published body`, ...at })
    }
    const first = firstUse.get(slug)
    if (first) {
      out.push({ severity: 'warning', code: 'template-reused', path, message: `template "${slug}" is already used by ${first}`, ...at })
    } else firstUse.set(slug, where)
  }

  const seenPriority = new Set<number>()
  def.actions.forEach((a, i) => {
    if (seenPriority.has(a.priority)) {
      out.push({
        severity: 'warning',
        code: 'priority-tie',
        path: `actions.${i}.priority`,
        message: `priority ${a.priority} is shared with an earlier action; the earlier one is evaluated first`,
        actionId: a.id,
      })
    }
    seenPriority.add(a.priority)
    if (!a.cta) {
      out.push({ severity: 'warning', code: 'no-cta', path: `actions.${i}.cta`, message: `"${a.title}" has no call to action`, actionId: a.id })
    }
    a.attempts.forEach((at, j) => {
      at.deliveries.forEach((d, k) => {
        checkTemplate(d.templateSlug, `actions.${i}.attempts.${j}.deliveries.${k}.templateSlug`, `${a.id} email ${j + 1}`, a.id, j + 1)
      })
    })
  })

  const sunset = def.policy.sunset
  if (sunset) {
    checkTemplate(sunset.askTemplateSlug, ASK_PATH, 'the sunset ask', SUNSET_ASK_ACTION_ID)
    const longest = Math.max(0, ...def.actions.map((a) => a.attempts.length))
    if (sunset.askAfter < longest) {
      out.push({
        severity: 'warning',
        code: 'sunset-early',
        path: 'policy.sunset.askAfter',
        message: `asks after ${sunset.askAfter} unanswered emails, before the longest ladder (${longest}) is done`,
      })
    }
  }
  return out
}
