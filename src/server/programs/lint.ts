/**
 * Program lint (board): publish-validation issues as errors, plus warnings
 * that do not block publish. plans/16-program-board.md §4.
 */

import type { ProgramLintIssue } from '../../shared/program-board.js'
import type { ProgramValidationContext } from './validate.js'

export interface ProgramLintContext extends Omit<ProgramValidationContext, 'templates'> {
  /** Every template the program references, by slug. `published`: has a published body. */
  templates: Map<string, { kind: 'marketing' | 'transactional'; category?: string | null; published: boolean }>
}

/**
 * Lint a definition (any input; a structurally invalid one yields only
 * `invalid` errors). Order: errors first in validation order, then warnings
 * in definition order.
 */
export function lintProgram(input: unknown, ctx: ProgramLintContext): ProgramLintIssue[] {
  void input
  void ctx
  throw new Error('lintProgram: not implemented (board WP-A)')
}
