/**
 * Parse an optional `category` field from an admin/agent request body.
 *
 *   absent            → { provided: false }
 *   null or ''        → { provided: true, value: null }   (clears the category)
 *   a string          → { provided: true, value: <string> }
 *   anything else     → { error }
 *
 * Whether the value is acceptable for the template's kind is
 * `templateCategoryIssue`'s job; this only normalises the wire shape.
 */

export type CategoryInput =
  | { provided: false }
  | { provided: true; value: string | null }
  | { error: string }

export function parseCategoryInput(raw: unknown): CategoryInput {
  if (raw === undefined) return { provided: false }
  if (raw === null || raw === '') return { provided: true, value: null }
  if (typeof raw !== 'string') return { error: 'category must be a string or null' }
  return { provided: true, value: raw }
}
