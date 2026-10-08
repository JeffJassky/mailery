import React from 'react'
import { Icons } from '../../components/icons'
import { IconButton, Tip } from '../../components/tip'
import { api, type ProgramSimulation, type ProgramSource, type ProgramTemplateInfo } from '../../lib/api'
import type { ProgramLintIssue } from '../../../shared/program-board'
import type { BoardCell, BoardRow } from './model'

type Preview = { subject: string; html: string }

export function CellDrawer({
  slug,
  row,
  cell,
  template,
  source,
  sim,
  subjectId,
  issues,
  setRoute,
  onClose,
  children,
}: {
  slug: string
  row: BoardRow
  cell: BoardCell
  template: ProgramTemplateInfo | undefined
  source: ProgramSource
  sim: ProgramSimulation<string> | null
  subjectId: string
  issues: ProgramLintIssue[]
  setRoute: (r: any) => void
  onClose: () => void
  /** Edit controls (WP-C). */
  children?: React.ReactNode
}) {
  const [preview, setPreview] = React.useState<Preview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const factsKey = sim ? JSON.stringify(sim.facts) : ''

  React.useEffect(() => {
    closeRef.current?.focus()
  }, [])

  React.useEffect(() => {
    let alive = true
    setError(null)
    if (!cell.templateSlug) {
      setPreview(null)
      return
    }
    api
      .previewProgramEmail(cell.templateSlug, {
        slug,
        source,
        actionId: row.id,
        attempt: cell.attempt,
        ...(sim ? { facts: sim.facts as Record<string, unknown> } : {}),
        ...(subjectId ? { subjectId } : {}),
      })
      .then((p) => alive && setPreview({ subject: p.subject, html: p.html }))
      .catch((e: any) => {
        if (!alive) return
        setPreview(null)
        setError(String(e?.message ?? e))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, source, row.id, cell.attempt, cell.templateSlug, factsKey, subjectId])

  async function copy() {
    try {
      await navigator.clipboard.writeText(cell.templateSlug)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }

  const total = row.cells.length
  const tplState: { icon: React.ReactNode; tip: string } = !template
    ? { icon: <span style={{ color: 'var(--red-fg)', display: 'inline-flex' }}><Icons.AlertTriangle /></span>, tip: 'Template missing' }
    : template.published
      ? { icon: <span style={{ color: 'var(--green-fg)', display: 'inline-flex' }}><Icons.CheckCircle /></span>, tip: 'Template published' }
      : { icon: <span style={{ color: 'var(--amber-fg)', display: 'inline-flex' }}><Icons.AlertTriangle /></span>, tip: 'Template not published' }

  return (
    <aside className="pb-drawer" aria-label={`${row.title}, email ${cell.attempt}`}>
      <div className="pb-drawer-head">
        <span className="ttl">{row.title}</span>
        <IconButton
          icon={<Icons.ExternalLink />}
          label="Open template"
          disabled={!cell.templateSlug}
          onClick={() => setRoute({ screen: 'template-editor', slug: cell.templateSlug })}
        />
        <Tip label="Close (Esc)">
          <button ref={closeRef} type="button" className="icon-btn2" aria-label="Close" onClick={onClose}>
            <Icons.X />
          </button>
        </Tip>
      </div>
      <div className="pb-drawer-body">
        <div className="pb-subject">{preview?.subject ?? template?.subject ?? ' '}</div>
        <div className="pb-meta">
          <Tip label={copied ? 'Copied' : 'Copy template slug'}>
            <button type="button" className="pb-chip" onClick={copy} aria-label={`Copy template slug ${cell.templateSlug}`}>
              {copied ? <Icons.Check /> : <Icons.Copy />}
              <span className="mono">{cell.templateSlug || '—'}</span>
            </button>
          </Tip>
          <Tip label="Email in this action" focusable>
            <span className="pb-chip">
              <Icons.Mail />
              <span>{row.kind === 'sunset' ? '1 / 1' : `${cell.attempt} / ${total}`}</span>
            </span>
          </Tip>
          {cell.gapDays != null && (
            <Tip label={`Gap before this email: ${cell.gapDays} ${cell.gapDays === 1 ? 'day' : 'days'}`} focusable>
              <span className="pb-chip">
                <Icons.Clock />
                <span>{cell.gapDays}d</span>
              </span>
            </Tip>
          )}
          <Tip label={tplState.tip} focusable>
            <span className="pb-chip">{tplState.icon}</span>
          </Tip>
        </div>

        {issues.length > 0 && (
          <ul className="pb-issues">
            {issues.map((i, n) => (
              <li key={n}>
                <span className={i.severity === 'error' ? 'err' : 'warn'} style={{ display: 'inline-flex' }}>
                  <Icons.AlertTriangle />
                </span>
                <span>{i.message}</span>
              </li>
            ))}
          </ul>
        )}

        {children}

        {error ? (
          <div className="hstack" style={{ gap: 6, color: 'var(--red-fg)', fontSize: 12 }}>
            <Icons.AlertTriangle />
            <span>{error}</span>
          </div>
        ) : (
          <iframe
            className="pb-iframe"
            title="Email preview"
            sandbox=""
            srcDoc={preview?.html ?? ''}
          />
        )}
      </div>
    </aside>
  )
}
