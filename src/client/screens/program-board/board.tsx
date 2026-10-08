/* Program board (plans/16): the QC view of a program. */
import React from 'react'
import './board.css'
import { Icons } from '../../components/icons'
import { Tip } from '../../components/tip'
import { api, type ProgramDetail, type ProgramSource } from '../../lib/api'
import { useLive } from '../../lib/use-live'
import { diffProgramDefinitions, type ProgramLintIssue } from '../../../shared/program-board'
import type { ProgramDefinition } from '../../../shared/types'
import { SUNSET_ID, buildRows, cellKey, maxLadder, neighbour, type CellRef, type Dir } from './model'
import { indexIssues, normalizeIssues, worst, issueTip, type RawIssue } from './issues'
import { policyChips } from './policy-format'
import { summarize, PROJECTION_NOTE, type RowState } from './lens'
import { hasOverrides, type FactOverrides } from './facts-input'
import { useLens } from './use-lens'
import { PolicyChips } from './policy-chips'
import { LensInput, SourceSwitch } from './toolbar'
import { BoardRows } from './rows'
import { CellDrawer } from './cell-drawer'
import { FactsPanel } from './facts-panel'

export function Board({
  slug,
  prog,
  setRoute,
  extraIssues,
}: {
  slug: string
  prog: ProgramDetail
  setRoute: (r: any) => void
  /** Publish / draft-save validation issues from the last failed attempt. */
  extraIssues: RawIssue[]
}) {
  const hasDraft = !!prog.draft
  const hasPublished = !!prog.published
  const [pick, setPick] = React.useState<ProgramSource>('draft')
  const source: ProgramSource = hasDraft && (pick === 'draft' || !hasPublished) ? 'draft' : 'published'
  const def: ProgramDefinition | null = source === 'draft' ? prog.draft?.definition ?? null : prog.published
  const version = `${prog.version}:${prog.draft?.lastModifiedAt ?? ''}`

  // lens + facts
  const [subjectInput, setSubjectInput] = React.useState('')
  const [subjectId, setSubjectId] = React.useState('')
  const [factsOpen, setFactsOpen] = React.useState(false)
  const [overrides, setOverrides] = React.useState<FactOverrides>({})
  const lensActive = !!subjectId || factsOpen || hasOverrides(overrides)
  const lens = useLens(slug, source, subjectId, overrides, lensActive, version)
  const sim = lens.sim

  // lint
  const lint = useLive(() => api.lintProgram(slug, source), [slug, source, version])
  const issues: ProgramLintIssue[] = React.useMemo(
    () => normalizeIssues([...(lint.data?.issues ?? []), ...extraIssues], def),
    [lint.data, extraIssues, def],
  )
  const issueIdx = React.useMemo(() => indexIssues(issues), [issues])

  // rows
  const diff = React.useMemo(
    () => (source === 'draft' && def && prog.published ? diffProgramDefinitions(prog.published, def) : null),
    [source, def, prog.published],
  )
  const rows = React.useMemo(() => (def ? buildRows(def, diff, prog.published) : []), [def, diff, prog.published])
  const columns = maxLadder(rows)
  const templates = React.useMemo(() => new Map(prog.templates.map((t) => [t.slug, t])), [prog.templates])
  const titles = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const a of def?.actions ?? []) m.set(a.id, a.title)
    m.set(SUNSET_ID, 'Sunset ask')
    return m
  }, [def])

  // drawer
  const [sel, setSel] = React.useState<CellRef | null>(null)
  const selRow = sel ? rows.find((r) => r.id === sel.actionId && !r.ghost) : undefined
  const selCell = selRow?.cells[(sel?.attempt ?? 1) - 1]
  const drawerOpen = !!(sel && selRow && selCell)

  const closeDrawer = React.useCallback(() => {
    const prev = sel
    setSel(null)
    if (prev) window.setTimeout(() => document.querySelector<HTMLElement>(`[data-cell="${cellKey(prev.actionId, prev.attempt)}"]`)?.focus(), 0)
  }, [sel])

  React.useEffect(() => {
    if (!drawerOpen && !factsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (drawerOpen) closeDrawer()
        else setFactsOpen(false)
        return
      }
      if (!drawerOpen || !sel) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const dir: Dir | null = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : null
      if (!dir) return
      const n = neighbour(rows, sel, dir)
      e.preventDefault()
      if (n) {
        setSel(n)
        window.setTimeout(() => document.querySelector<HTMLElement>(`[data-cell="${cellKey(n.actionId, n.attempt)}"]`)?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, factsOpen, sel, rows, closeDrawer])

  function commitSubject() {
    setSubjectId(subjectInput.trim())
  }
  function clearSubject() {
    setSubjectInput('')
    setSubjectId('')
  }

  if (!def) {
    return <div className="card pb-empty">Nothing here yet</div>
  }

  const chips = policyChips(def)
  const summary = sim ? summarize(sim, titles) : null
  const programIssues = issueIdx.program
  const progSev = worst(programIssues)

  return (
    <>
      <div className="pb-toolbar">
        <PolicyChips chips={chips} />
        {progSev && (
          <Tip label={issueTip(programIssues)} focusable>
            <span className="pb-lens-flag" style={{ color: progSev === 'error' ? 'var(--red-fg)' : 'var(--amber-fg)' }}>
              <Icons.AlertTriangle />
            </span>
          </Tip>
        )}
        <div className="pb-right">
          {hasDraft && <SourceSwitch value={source} onChange={setPick} publishedAvailable={hasPublished} />}
          <LensInput
            value={subjectInput}
            onChange={setSubjectInput}
            onCommit={commitSubject}
            onClear={clearSubject}
            error={lens.error}
            factsOpen={factsOpen}
            factsAvailable={!!prog.facts}
            onToggleFacts={() => {
              setSel(null)
              setFactsOpen((o) => !o)
            }}
            noRun={!!subjectId && lens.hasRun === false}
          />
        </div>
      </div>

      {summary && (
        <div className="pb-summary" aria-live="polite">
          {summary.kind === 'next' ? (
            <>
              <span className={'pb-status ' + (summary.state as RowState)} style={{ padding: 0 }}>
                {summary.state === 'next' ? <Icons.ArrowRight /> : <Icons.Clock />}
              </span>
              <span>
                Next: <span className="f500">{summary.title}</span> · email {summary.attempt} · {summary.atText}
              </span>
              {summary.state !== 'next' && <span className="words">{summary.words}</span>}
            </>
          ) : (
            <>
              <span className="pb-status pending" style={{ padding: 0 }}>
                <Icons.Circle />
              </span>
              <span className="words">{summary.words}</span>
            </>
          )}
          <Tip label={PROJECTION_NOTE} focusable>
            <span className="pb-noun">
              <Icons.Info />
            </span>
          </Tip>
        </div>
      )}

      <div className="card pb-card">
        {rows.length === 0 ? (
          <div className="pb-empty">No actions</div>
        ) : (
          <BoardRows
            rows={rows}
            columns={columns}
            templates={templates}
            issues={issueIdx}
            sim={sim}
            dates={lens.dates}
            titles={titles}
            selected={sel}
            onSelect={(ref) => {
              setFactsOpen(false)
              setSel(ref)
            }}
          />
        )}
      </div>

      {drawerOpen && selRow && selCell && (
        <CellDrawer
          slug={slug}
          row={selRow}
          cell={selCell}
          template={templates.get(selCell.templateSlug)}
          source={source}
          sim={sim}
          subjectId={subjectId}
          issues={issueIdx.cells.get(cellKey(selRow.id, selCell.attempt)) ?? []}
          setRoute={setRoute}
          onClose={closeDrawer}
        />
      )}

      {factsOpen && prog.facts && (
        <FactsPanel
          decls={prog.facts}
          overrides={overrides}
          resolved={sim?.facts ?? null}
          onChange={setOverrides}
          onReset={() => setOverrides({})}
          onClose={() => setFactsOpen(false)}
          subjectId={subjectId}
        />
      )}
    </>
  )
}
