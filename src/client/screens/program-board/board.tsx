/* Program board (plans/16): the QC view of a program. */
import React from 'react'
import './board.css'
import { Icons } from '../../components/icons'
import { Tip } from '../../components/tip'
import { api, type ProgramDetail, type ProgramSource, type ProgramTemplateInfo } from '../../lib/api'
import { useLive } from '../../lib/use-live'
import { diffProgramDefinitions, type ProgramLintIssue } from '../../../shared/program-board'
import type { ProgramDefinition } from '../../../shared/types'
import { SUNSET_ID, buildRows, cellKey, maxLadder, neighbour, orderedActions, type BoardRow, type CellRef, type Dir } from './model'
import { indexIssues, normalizeIssues, worst, issueTip, type RawIssue } from './issues'
import { policyChips } from './policy-format'
import { summarize, PROJECTION_NOTE } from './lens'
import { hasOverrides, type FactOverrides } from './facts-input'
import {
  addAttempt,
  canRemoveAttempt,
  clone,
  moveAction,
  removeAttempt,
  sameDef,
  setAttemptGap,
  setAttemptTemplate,
  setSunsetTemplate,
  templateChoices,
} from './edit'
import { useLens } from './use-lens'
import { PolicyChips } from './policy-chips'
import { LensInput, SourceSwitch } from './toolbar'
import { BoardRows, type RowsEdit } from './rows'
import { CellDrawer } from './cell-drawer'
import { FactsPanel } from './facts-panel'
import { RowMenu } from './row-menu'
import { AddAttemptPopover, DrawerEdit, EditFooter } from './edit-ui'

export function Board({
  slug,
  prog,
  setRoute,
  extraIssues,
  editing,
  onDirty,
  onSaved,
}: {
  slug: string
  prog: ProgramDetail
  setRoute: (r: any) => void
  /** Publish validation issues from the last failed attempt. */
  extraIssues: RawIssue[]
  editing: boolean
  onDirty: (dirty: boolean) => void
  /** Called after a successful draft save (refetch the program). */
  onSaved: () => void
}) {
  const hasDraft = !!prog.draft
  const hasPublished = !!prog.published
  const [pick, setPick] = React.useState<ProgramSource>('draft')
  const baseDef: ProgramDefinition | null = prog.draft?.definition ?? prog.published
  const version = `${prog.version}:${prog.draft?.lastModifiedAt ?? ''}`

  // Which saved definition the server-side views (lens, lint, preview) read.
  const source: ProgramSource = editing
    ? hasDraft
      ? 'draft'
      : 'published'
    : hasDraft && (pick === 'draft' || !hasPublished)
      ? 'draft'
      : 'published'

  // ---- edit mode: a local copy of the draft -------------------------------
  const [local, setLocal] = React.useState<ProgramDefinition | null>(null)
  const dirty = editing && !!local && !!baseDef && !sameDef(local, baseDef)
  const dirtyRef = React.useRef(false)
  dirtyRef.current = dirty
  React.useEffect(() => {
    if (!editing) setLocal(null)
    else if (!dirtyRef.current && baseDef) setLocal(clone(baseDef))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, version])
  React.useEffect(() => onDirty(dirty), [dirty, onDirty])

  const [saving, setSaving] = React.useState(false)
  const [saveMsg, setSaveMsg] = React.useState<string | null>(null)
  const [saveIssues, setSaveIssues] = React.useState<RawIssue[]>([])

  const def: ProgramDefinition | null = editing && local ? local : source === 'draft' ? prog.draft?.definition ?? null : prog.published
  const edit = React.useCallback((next: ProgramDefinition) => setLocal(next), [])
  const editFn = React.useCallback((fn: (d: ProgramDefinition) => ProgramDefinition) => setLocal((cur) => (cur ? fn(cur) : cur)), [])

  async function save() {
    if (!local) return
    setSaving(true)
    setSaveMsg(null)
    setSaveIssues([])
    try {
      await api.saveProgramDraft(slug, local)
      onSaved()
    } catch (e: any) {
      setSaveMsg(String(e?.message ?? e))
      if (Array.isArray(e?.body?.issues)) setSaveIssues(e.body.issues)
    } finally {
      setSaving(false)
    }
  }
  function discard() {
    if (baseDef) setLocal(clone(baseDef))
    setSaveMsg(null)
    setSaveIssues([])
  }

  // templates for the picker (edit mode only)
  const [allTemplates, setAllTemplates] = React.useState<any[] | null>(null)
  React.useEffect(() => {
    if (editing && !allTemplates) api.templates().then(setAllTemplates).catch(() => setAllTemplates([]))
  }, [editing, allTemplates])
  const choices = React.useMemo(() => (def ? templateChoices(allTemplates ?? [], def.category) : []), [allTemplates, def?.category])

  // ---- lens + facts ---------------------------------------------------------
  const [subjectInput, setSubjectInput] = React.useState('')
  const [subjectId, setSubjectId] = React.useState('')
  const [factsOpen, setFactsOpen] = React.useState(false)
  const [overrides, setOverrides] = React.useState<FactOverrides>({})
  const lensActive = !!subjectId || factsOpen || hasOverrides(overrides)
  const lens = useLens(slug, source, subjectId, overrides, lensActive, version)
  const sim = lens.sim

  // ---- lint + server issues -------------------------------------------------
  const lint = useLive(() => api.lintProgram(slug, source), [slug, source, version])
  const issues: ProgramLintIssue[] = React.useMemo(
    () => normalizeIssues([...(lint.data?.issues ?? []), ...extraIssues, ...saveIssues], def),
    [lint.data, extraIssues, saveIssues, def],
  )
  const issueIdx = React.useMemo(() => indexIssues(issues), [issues])

  // ---- rows -------------------------------------------------------------------
  const diff = React.useMemo(
    () => ((source === 'draft' || editing) && def && prog.published ? diffProgramDefinitions(prog.published, def) : null),
    [source, editing, def, prog.published],
  )
  const rows = React.useMemo(() => (def ? buildRows(def, diff, prog.published) : []), [def, diff, prog.published])
  const columns = maxLadder(rows) + (editing ? 1 : 0)
  const templates = React.useMemo(() => {
    const m = new Map<string, ProgramTemplateInfo>(prog.templates.map((t) => [t.slug, t]))
    for (const c of choices) {
      if (!m.has(c.slug)) m.set(c.slug, { slug: c.slug, name: c.name, subject: c.subject, kind: 'marketing', category: def?.category ?? null, published: c.published })
    }
    return m
  }, [prog.templates, choices, def?.category])
  const titles = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const a of def?.actions ?? []) m.set(a.id, a.title)
    m.set(SUNSET_ID, 'Sunset ask')
    return m
  }, [def])

  // ---- drawer ---------------------------------------------------------------
  const [sel, setSel] = React.useState<CellRef | null>(null)
  const selRow = sel ? rows.find((r) => r.id === sel.actionId && !r.ghost) : undefined
  const selCell = selRow?.cells[(sel?.attempt ?? 1) - 1]
  const drawerOpen = !!(sel && selRow && selCell)

  const focusCell = (ref: CellRef) =>
    window.setTimeout(() => document.querySelector<HTMLElement>(`[data-cell="${cellKey(ref.actionId, ref.attempt)}"]`)?.focus(), 0)

  const closeDrawer = React.useCallback(() => {
    const prev = sel
    setSel(null)
    if (prev) focusCell(prev)
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
        focusCell(n)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, factsOpen, sel, rows, closeDrawer])

  // ---- reorder (edit mode) -------------------------------------------------
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [overId, setOverId] = React.useState<string | null>(null)
  const order = React.useMemo(() => (def ? orderedActions(def).map((a) => a.id) : []), [def])

  function move(id: string, newIndex: number) {
    editFn((d) => moveAction(d, id, newIndex).def)
  }
  const rowsEdit: RowsEdit | undefined = editing
    ? {
        on: true,
        renderMenu: (row: BoardRow) => (row.action ? <RowMenu action={row.action} edit={editFn} /> : null),
        gripProps: (row) => ({
          draggable: true,
          'data-grip': row.id,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData('text/plain', row.id)
            e.dataTransfer.effectAllowed = 'move'
            setDragId(row.id)
          },
          onDragEnd: () => {
            setDragId(null)
            setOverId(null)
          },
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            e.preventDefault()
            const i = order.indexOf(row.id)
            const to = e.key === 'ArrowUp' ? i - 1 : i + 1
            if (to < 0 || to >= order.length) return
            move(row.id, to)
            window.setTimeout(() => document.querySelector<HTMLElement>(`[data-grip="${row.id}"]`)?.focus(), 0)
          },
        }),
        rowProps: (row) => {
          const from = dragId ? order.indexOf(dragId) : -1
          const to = order.indexOf(row.id)
          return {
            className: dragId === row.id ? 'dragging' : dragId && overId === row.id ? (from < to ? 'drop-after' : 'drop-before') : '',
            onDragOver: (e: React.DragEvent) => {
              if (!dragId) return
              e.preventDefault()
              setOverId(row.id)
            },
            onDrop: (e: React.DragEvent) => {
              e.preventDefault()
              if (dragId && dragId !== row.id) move(dragId, to)
              setDragId(null)
              setOverId(null)
            },
          }
        },
        onAddAttempt: (row, el) => setAdding({ id: row.id, el }),
      }
    : undefined

  const [adding, setAdding] = React.useState<{ id: string; el: HTMLElement } | null>(null)

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
  const selAction = selRow?.action ?? null

  return (
    <>
      <div className="pb-toolbar">
        <PolicyChips chips={chips} def={editing ? def : undefined} onEdit={editing ? edit : undefined} />
        {progSev && (
          <Tip label={issueTip(programIssues)} focusable>
            <span className="pb-lens-flag" style={{ color: progSev === 'error' ? 'var(--red-fg)' : 'var(--amber-fg)' }}>
              <Icons.AlertTriangle />
            </span>
          </Tip>
        )}
        <div className="pb-right">
          {hasDraft && !editing && <SourceSwitch value={source} onChange={setPick} publishedAvailable={hasPublished} />}
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
              <span className={'pb-status ' + (summary.state === 'next' ? 'next' : 'pending')} style={{ padding: 0 }}>
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
            edit={rowsEdit}
            onSelect={(ref) => {
              setFactsOpen(false)
              setSel(ref)
            }}
          />
        )}
      </div>

      {adding && (
        <AddAttemptPopover
          anchor={adding.el}
          choices={choices}
          onClose={() => setAdding(null)}
          onPick={(s) => {
            editFn((d) => addAttempt(d, adding.id, s))
            setAdding(null)
          }}
        />
      )}

      {drawerOpen && selRow && selCell && sel && (
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
        >
          {editing && (
            <DrawerEdit
              key={cellKey(selRow.id, selCell.attempt)}
              templateSlug={selCell.templateSlug}
              gapDays={selCell.gapDays}
              programGapDays={def.policy.minGapDays}
              choices={choices}
              isSunset={selRow.kind === 'sunset'}
              removable={!!selAction && canRemoveAttempt(selAction)}
              onTemplate={(s) =>
                editFn((d) => (selRow.kind === 'sunset' ? setSunsetTemplate(d, s) : setAttemptTemplate(d, selRow.id, selCell.attempt - 1, s)))
              }
              onGap={(raw) => editFn((d) => setAttemptGap(d, selRow.id, selCell.attempt - 1, raw))}
              onRemove={() => {
                editFn((d) => removeAttempt(d, selRow.id, selCell.attempt - 1))
                setSel({ actionId: selRow.id, attempt: Math.max(1, selCell.attempt - 1) })
              }}
            />
          )}
        </CellDrawer>
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

      {dirty && <EditFooter saving={saving} message={saveMsg} onDiscard={discard} onSave={save} />}
    </>
  )
}
