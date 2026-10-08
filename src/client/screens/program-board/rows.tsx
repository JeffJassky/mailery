import React from 'react'
import { Icons } from '../../components/icons'
import { Tip } from '../../components/tip'
import type { ProgramSimulation } from '../../lib/api'
import type { ProgramTemplateInfo } from '../../lib/api'
import { describePredicate } from '../../../shared/program-board'
import { cellKey, changeTip, type BoardCell, type BoardRow, type CellRef } from './model'
import { issueTip, worst, type IssueIndex } from './issues'
import { cellLens, fmtDay, fmtWhen, rowStatus, type CellLens, type RowState } from './lens'
import type { ProgramLintIssue } from '../../../shared/program-board'

type Sim = ProgramSimulation<string>

export interface RowsEdit {
  /** Grip + overflow menu + add-attempt cells are shown. */
  on: boolean
  renderMenu: (row: BoardRow) => React.ReactNode
  gripProps: (row: BoardRow) => Record<string, any>
  rowProps: (row: BoardRow) => Record<string, any>
  onAddAttempt: (row: BoardRow, el: HTMLElement) => void
}

const STATUS_ICON: Record<RowState, keyof typeof Icons> = {
  satisfied: 'Check',
  next: 'ArrowRight',
  pending: 'Circle',
  exhausted: 'Ban',
  cooldown: 'Refresh',
  blocked: 'Lock',
  ineligible: 'FilterOff',
  held: 'Pause',
}

export function BoardRows({
  rows,
  columns,
  templates,
  issues,
  sim,
  dates,
  titles,
  selected,
  onSelect,
  edit,
}: {
  rows: BoardRow[]
  columns: number
  templates: ReadonlyMap<string, ProgramTemplateInfo>
  issues: IssueIndex
  sim: Sim | null
  dates: ReadonlyMap<string, string>
  titles: ReadonlyMap<string, string>
  selected: CellRef | null
  onSelect: (ref: CellRef) => void
  edit?: RowsEdit
}) {
  const lead = (edit?.on ? 28 : 0) + (sim ? 28 : 0)
  const cols = [edit?.on ? '24px' : null, sim ? '20px' : null, 'minmax(190px, 250px)', `repeat(${columns}, minmax(150px, 1fr))`]
    .filter(Boolean)
    .join(' ')
  const minWidth = lead + 200 + columns * 158 + 24

  return (
    <div className="pb-scroll">
      <div className="pb-grid" style={{ minWidth }}>
        {rows.map((row) => {
          const extra: Record<string, any> = edit?.on && !row.ghost && row.kind === 'action' ? edit.rowProps(row) : {}
          const { className: extraClass, ...extraRest } = extra
          return (
            <div
              key={row.id + (row.ghost ? ':ghost' : '')}
              className={'pb-row' + (row.ghost ? ' ghost' : '') + (row.kind === 'sunset' ? ' sunset' : '') + (extraClass ? ' ' + extraClass : '')}
              style={{ gridTemplateColumns: cols }}
              {...extraRest}
            >
              {edit?.on && (
                <div className="pb-grip">
                  {row.kind === 'action' && !row.ghost && (
                    <Tip label="Drag to reorder (↑/↓ on the handle)">
                      <button type="button" className="icon-btn2 sm" aria-label={`Reorder ${row.title}`} {...edit.gripProps(row)}>
                        <Icons.Grip />
                      </button>
                    </Tip>
                  )}
                </div>
              )}
              {sim && <StatusCell row={row} sim={sim} titles={titles} />}
              <TitleCell row={row} issues={issues} titles={titles} edit={edit} />
              <div className="pb-cells">
                {row.cells.map((cell) => (
                  <div className="pb-cell-wrap" key={cell.attempt}>
                    <Cell
                      row={row}
                      cell={cell}
                      template={templates.get(cell.templateSlug)}
                      issues={issues.cells.get(cellKey(row.id, cell.attempt))}
                      lens={sim && !row.ghost ? cellLens(sim, dates, row.id, cell.attempt) : null}
                      selected={selected?.actionId === row.id && selected.attempt === cell.attempt}
                      onSelect={onSelect}
                    />
                  </div>
                ))}
                {edit?.on && row.kind === 'action' && !row.ghost && (
                  <div className="pb-cell-wrap">
                    <Tip label="Add an email" className="block">
                      <button type="button" className="pb-cell-add" aria-label={`Add an email to ${row.title}`} onClick={(e) => edit.onAddAttempt(row, e.currentTarget)}>
                        <Icons.Plus />
                      </button>
                    </Tip>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatusCell({ row, sim, titles }: { row: BoardRow; sim: Sim; titles: ReadonlyMap<string, string> }) {
  if (row.ghost) return <div />
  const st = rowStatus(sim, row.id, titles)
  const Icon = Icons[STATUS_ICON[st.state]]
  return (
    <div className={'pb-status ' + st.state}>
      <Tip label={st.label} focusable>
        <Icon />
      </Tip>
    </div>
  )
}

function TitleCell({
  row,
  issues,
  titles,
  edit,
}: {
  row: BoardRow
  issues: IssueIndex
  titles: ReadonlyMap<string, string>
  edit?: RowsEdit
}) {
  const a = row.action
  const rowIssues: ProgramLintIssue[] | undefined = issues.rows.get(row.id)
  const sev = worst(rowIssues)
  return (
    <div className="pb-title">
      <div className="pb-title-line">
        {row.kind === 'sunset' ? (
          <Tip label="Sunset ask" focusable>
            <Icons.Sunset size={14} />
          </Tip>
        ) : (
          <span className="pb-prio">{row.priority}</span>
        )}
        <span className="pb-title-text" title={row.title}>{row.title}</span>
        {row.changedFields.length > 0 && (
          <Tip label={changeTip(row)} focusable>
            <span className="pb-dot" />
          </Tip>
        )}
        {edit?.on && !row.ghost && row.kind === 'action' && <span className="pb-dots-btn">{edit.renderMenu(row)}</span>}
      </div>
      {(a || sev) && (
        <div className="pb-strip">
          {a?.eligible && (
            <Tip label={`Only if: ${describePredicate(a.eligible)}`} focusable>
              <Icons.Filter />
            </Tip>
          )}
          {a?.satisfied && (
            <Tip label={`Done when: ${describePredicate(a.satisfied)}`} focusable>
              <Icons.CheckCircle />
            </Tip>
          )}
          {a?.requires && a.requires.length > 0 && (
            <Tip label={`After: ${a.requires.map((r) => titles.get(r) ?? r).join(', ')}`} focusable>
              <Icons.Link />
            </Tip>
          )}
          {a?.cooldownDays ? (
            <Tip label={`Retries after ${a.cooldownDays} days`} focusable>
              <Icons.Refresh />
            </Tip>
          ) : null}
          {a?.onExhaust === 'hold' && (
            <Tip label="Blocks lower actions until done" focusable>
              <Icons.Pause />
            </Tip>
          )}
          {a?.cta && (
            <Tip label={`${a.cta.label} → ${a.cta.url}`} focusable>
              <Icons.ExternalLink />
            </Tip>
          )}
          {sev && (
            <Tip label={issueTip(rowIssues)} focusable>
              <span className={sev === 'error' ? 'err' : 'warn'} style={{ display: 'inline-flex' }}>
                <Icons.AlertTriangle />
              </span>
            </Tip>
          )}
        </div>
      )}
    </div>
  )
}

export function cellTip(row: BoardRow, cell: BoardCell, lens: CellLens | null): string {
  const lines: string[] = []
  if (lens?.kind === 'sent') lines.push(lens.at ? `Sent ${fmtDay(lens.at)}` : 'Sent')
  else if (lens?.kind === 'next') lines.push([lens.text, fmtWhen(lens.at)].filter(Boolean).join(' · '))
  else if (lens?.kind === 'projected') lines.push(`#${lens.position} · ${fmtWhen(lens.at)}`)
  lines.push(cell.templateSlug)
  if (cell.gapDays != null) lines.push(`Gap: ${cell.gapDays} ${cell.gapDays === 1 ? 'day' : 'days'}`)
  if (cell.changed) lines.push('Changed in draft')
  return lines.join('\n')
}

function Cell({
  row,
  cell,
  template,
  issues,
  lens,
  selected,
  onSelect,
}: {
  row: BoardRow
  cell: BoardCell
  template: ProgramTemplateInfo | undefined
  issues: ProgramLintIssue[] | undefined
  lens: CellLens | null
  selected: boolean
  onSelect: (ref: CellRef) => void
}) {
  const sev = worst(issues)
  const cls =
    'pb-cell' +
    (sev === 'error' ? ' err' : '') +
    (lens?.kind === 'sent' ? ' sent' : '') +
    (lens?.kind === 'next' ? ' next' : '') +
    (lens?.kind === 'muted' ? ' muted' : '') +
    (selected ? ' selected' : '')
  const subject = template?.subject
  const label = `${row.title}, email ${cell.attempt}: ${subject ?? cell.templateSlug}`
  return (
    <Tip label={cellTip(row, cell, lens)} className="block">
      <button
        type="button"
        className={cls}
        aria-label={label}
        data-cell={cellKey(row.id, cell.attempt)}
        onClick={() => onSelect({ actionId: row.id, attempt: cell.attempt })}
      >
        <span className={'subj' + (subject ? '' : ' missing')}>{subject ?? (cell.templateSlug || '—')}</span>
        <span className="ind">
          {cell.changed && <span className="pb-dot" />}
          {sev && (
            <span className={sev === 'error' ? 'err' : 'warn'} style={{ display: 'inline-flex' }}>
              <Icons.AlertTriangle />
            </span>
          )}
          {lens?.kind === 'sent' && <span className="ok" style={{ display: 'inline-flex' }}><Icons.Check /></span>}
          {lens?.kind === 'next' && <span className="nx" style={{ display: 'inline-flex' }}><Icons.Clock /></span>}
          {lens?.kind === 'projected' && <span className="pb-num">{lens.position}</span>}
        </span>
      </button>
    </Tip>
  )
}

