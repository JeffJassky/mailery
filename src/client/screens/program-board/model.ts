/**
 * Pure board model: a definition (+ optional diff against the published one)
 * becomes ordered rows of cells. No DOM, no React.
 */
import type { ProgramAction, ProgramDefinition } from '../../../shared/types'
import type { ProgramDiff } from '../../../shared/program-board'

export const SUNSET_ID = '$sunset-ask'

export interface BoardCell {
  /** 1-based. */
  attempt: number
  templateSlug: string
  gapDays?: number
  /** Differs from the published definition. */
  changed: boolean
}

export interface BoardRow {
  id: string
  kind: 'action' | 'sunset'
  title: string
  priority: number | null
  action: ProgramAction | null
  cells: BoardCell[]
  /** Removed in the draft: shown struck through at its old position. */
  ghost: boolean
  /** Changed fields other than attempts (draft view only). Added rows carry `['added']`. */
  changedFields: string[]
}

export interface CellRef {
  actionId: string
  attempt: number
}

export const cellKey = (actionId: string, attempt: number): string => `${actionId}#${attempt}`

/** Evaluation order: priority desc, ties by definition order. */
export function orderedActions(def: ProgramDefinition): ProgramAction[] {
  return def.actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => y.a.priority - x.a.priority || x.i - y.i)
    .map((x) => x.a)
}

function actionCells(a: ProgramAction, changedIdx: Set<number>): BoardCell[] {
  return a.attempts.map((at, i) => ({
    attempt: i + 1,
    templateSlug: at.deliveries[0]?.templateSlug ?? '',
    gapDays: at.minGapDays,
    changed: changedIdx.has(i),
  }))
}

function changedAttemptIdx(fields: string[]): Set<number> {
  const s = new Set<number>()
  for (const f of fields) {
    const m = /^attempts\.(\d+)$/.exec(f)
    if (m) s.add(Number(m[1]))
  }
  return s
}

function actionRow(a: ProgramAction, diff: ProgramDiff | null | undefined, ghost = false): BoardRow {
  const d = diff?.actions[a.id]
  const fields = d?.kind === 'changed' ? d.fields : []
  const added = d?.kind === 'added'
  return {
    id: a.id,
    kind: 'action',
    title: a.title,
    priority: a.priority,
    action: a,
    cells: actionCells(a, added ? new Set(a.attempts.map((_, i) => i)) : changedAttemptIdx(fields)),
    ghost,
    changedFields: added ? ['added'] : fields.filter((f) => !f.startsWith('attempts.')),
  }
}

/**
 * Rows in evaluation order, the sunset ask last. With `diff` + `base`
 * (draft view), changed rows/cells are flagged and removed actions come back
 * as ghost rows after the nearest preceding surviving neighbour of the base.
 */
export function buildRows(def: ProgramDefinition, diff?: ProgramDiff | null, base?: ProgramDefinition | null): BoardRow[] {
  const rows: BoardRow[] = orderedActions(def).map((a) => actionRow(a, diff))

  if (diff && base) {
    const removed = new Set(Object.keys(diff.actions).filter((id) => diff.actions[id]!.kind === 'removed'))
    const baseOrder = orderedActions(base)
    for (const g of baseOrder) {
      if (!removed.has(g.id)) continue
      const pos = baseOrder.findIndex((x) => x.id === g.id)
      let at = 0
      for (let k = pos - 1; k >= 0; k--) {
        const idx = rows.findIndex((r) => r.id === baseOrder[k]!.id)
        if (idx >= 0) {
          at = idx + 1
          break
        }
      }
      rows.splice(at, 0, { ...actionRow(g, null, true), changedFields: ['removed'], cells: actionCells(g, new Set()) })
    }
  }

  const s = def.policy.sunset
  if (s) {
    const changed = !!diff?.fields.some((f) => f === 'policy.sunset' || f.startsWith('policy.sunset.'))
    rows.push({
      id: SUNSET_ID,
      kind: 'sunset',
      title: 'Sunset',
      priority: null,
      action: null,
      cells: [{ attempt: 1, templateSlug: s.askTemplateSlug, changed }],
      ghost: false,
      changedFields: changed ? ['policy.sunset'] : [],
    })
  }
  return rows
}

/** Columns the grid needs: the longest ladder. */
export function maxLadder(rows: BoardRow[]): number {
  return rows.reduce((m, r) => Math.max(m, r.cells.length), 1)
}

export type Dir = 'left' | 'right' | 'up' | 'down'

/** Neighbouring cell for arrow-key navigation (ghost rows are skipped). */
export function neighbour(rows: BoardRow[], cur: CellRef, dir: Dir): CellRef | null {
  const live = rows.filter((r) => !r.ghost)
  const ri = live.findIndex((r) => r.id === cur.actionId)
  if (ri < 0) return null
  const row = live[ri]!
  if (dir === 'left') return cur.attempt > 1 ? { actionId: row.id, attempt: cur.attempt - 1 } : null
  if (dir === 'right') return cur.attempt < row.cells.length ? { actionId: row.id, attempt: cur.attempt + 1 } : null
  const step = dir === 'up' ? -1 : 1
  const next = live[ri + step]
  if (!next) return null
  return { actionId: next.id, attempt: Math.min(cur.attempt, next.cells.length) }
}

/** Human list for the amber "changed" dot tooltip. */
export function changeTip(row: BoardRow): string {
  if (row.changedFields.includes('added')) return 'Added in draft'
  if (row.changedFields.includes('removed')) return 'Removed in draft'
  return 'Changed: ' + row.changedFields.join(', ')
}
