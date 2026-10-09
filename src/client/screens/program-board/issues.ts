/**
 * Lint / validation issues → rows and cells. Lint issues arrive already
 * mapped (`actionId`, `attempt`); publish and draft-save 400/422 issues only
 * carry `{ path, message }` and are mapped here from the path.
 */
import type { ProgramDefinition } from '../../../shared/types'
import type { ProgramLintIssue } from '../../../shared/program-board'
import { SUNSET_ID, cellKey } from './model'

export interface RawIssue {
  severity?: 'error' | 'warning'
  code?: ProgramLintIssue['code']
  path?: string
  message: string
  actionId?: string
  attempt?: number
}

/** Fill severity/code/actionId/attempt for issues that only have a path. */
export function normalizeIssues(raw: RawIssue[], def: ProgramDefinition | null): ProgramLintIssue[] {
  return raw.map((r) => {
    const path = r.path ?? ''
    let actionId = r.actionId
    let attempt = r.attempt
    if (!actionId) {
      const a = /^actions\.(\d+)(?:\.|$)/.exec(path)
      if (a) {
        actionId = def?.actions[Number(a[1])]?.id
        const t = /\.attempts\.(\d+)(?:\.|$)/.exec(path)
        if (actionId && t) attempt = Number(t[1]) + 1
      } else if (path === 'policy.sunset' || path.startsWith('policy.sunset.')) {
        actionId = SUNSET_ID
        if (path.startsWith('policy.sunset.askTemplateSlug')) attempt = 1
      }
    }
    const out: ProgramLintIssue = { severity: r.severity ?? 'error', code: r.code ?? 'invalid', path, message: r.message }
    if (actionId) out.actionId = actionId
    if (attempt) out.attempt = attempt
    return out
  })
}

export interface IssueIndex {
  /** Keyed by `cellKey(actionId, attempt)`. */
  cells: Map<string, ProgramLintIssue[]>
  /** Issues on an action but not on one of its attempts. */
  rows: Map<string, ProgramLintIssue[]>
  /** Issues that point at no action. */
  program: ProgramLintIssue[]
}

export function indexIssues(issues: ProgramLintIssue[]): IssueIndex {
  const idx: IssueIndex = { cells: new Map(), rows: new Map(), program: [] }
  const push = (m: Map<string, ProgramLintIssue[]>, k: string, i: ProgramLintIssue) => {
    const l = m.get(k)
    if (l) l.push(i)
    else m.set(k, [i])
  }
  for (const i of issues) {
    if (!i.actionId) idx.program.push(i)
    else if (i.attempt) push(idx.cells, cellKey(i.actionId, i.attempt), i)
    else push(idx.rows, i.actionId, i)
  }
  return idx
}

export function worst(issues: ProgramLintIssue[] | undefined): 'error' | 'warning' | null {
  if (!issues || issues.length === 0) return null
  return issues.some((i) => i.severity === 'error') ? 'error' : 'warning'
}

/** Tooltip text: one line per issue. */
export function issueTip(issues: ProgramLintIssue[] | undefined): string {
  return (issues ?? []).map((i) => i.message).join('\n')
}
