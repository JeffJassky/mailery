/** Pure helpers for the `wait_until` flow step (summary text, fact listing). */

export type DeclaredFacts = Record<string, { type: string; values?: string[]; description?: string }>

/** `− 3d`, `+ 1.5d`, or '' for no offset. Uses a true minus sign for readability. */
export function formatOffsetDays(offsetDays: unknown): string {
  const n = typeof offsetDays === 'number' && Number.isFinite(offsetDays) ? offsetDays : 0
  if (n === 0) return ''
  return `${n < 0 ? '−' : '+'} ${Math.abs(n)}d`
}

/** `until trial_ends_at − 3d` / `until trial_ends_at` / `until trial_ends_at + 1.5d`. */
export function waitUntilLabel(step: { fact?: string; offsetDays?: number }): string {
  const offset = formatOffsetDays(step.offsetDays)
  return `until ${step.fact || '(no fact)'}${offset ? ' ' + offset : ''}`
}

/** Secondary line: where the subject id comes from and what happens when the date is missing. */
export function waitUntilMeta(step: { subjectFrom?: string; ifMissing?: string }): string {
  const via = step.subjectFrom ? `via ${step.subjectFrom}` : 'via (no subject)'
  return `${via} · if missing: ${step.ifMissing === 'continue' ? 'continue' : 'exit'}`
}

/** Names of declared facts whose type is `date`, sorted. */
export function dateFactNames(facts: DeclaredFacts | null | undefined): string[] {
  if (!facts) return []
  return Object.keys(facts).filter((k) => facts[k]?.type === 'date').sort()
}

/** Parse a free-typed offset. Returns undefined while the text is not (yet) a finite number. */
export function parseOffsetDays(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}
