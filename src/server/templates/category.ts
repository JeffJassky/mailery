/**
 * Template category rule (0.21), shared by every path that publishes or
 * edits a template (admin publish, admin PATCH, agent publish) so they
 * cannot disagree. Pure; returns the problem or null.
 *
 *   transactional + any category        → rejected (transactional is outside preferences)
 *   marketing + undeclared category     → rejected
 *   marketing + declared or no category → ok
 */

import type { CategoryDef } from '../../shared/types.js'
import type { TemplateKind } from '../../shared/enums.js'

export function templateCategoryIssue(
  kind: TemplateKind,
  category: string | null | undefined,
  categories: CategoryDef[] | undefined,
): string | null {
  if (category === null || category === undefined || category === '') return null
  if (kind === 'transactional') return 'transactional templates cannot have a category'
  if (!(categories ?? []).some((c) => c.id === category)) {
    return `category "${category}" is not declared in MailerConfig.categories`
  }
  return null
}
