import React from 'react'
import { Icons } from '../../components/icons'
import { IconButton } from '../../components/tip'
import { describePredicate } from '../../../shared/program-board'
import type { ProgramAction, ProgramDefinition } from '../../../shared/types'
import { Popover } from './popover'
import { parsePredicateText, predicateText, setCooldown, setCta, setHold, setPredicate, setTitle } from './edit'

type Tool = 'cooldown' | 'title' | 'cta' | 'eligible' | 'satisfied'
type Edit = (fn: (d: ProgramDefinition) => ProgramDefinition) => void

/** Row overflow menu (edit mode): an icon toolbar, one small editor at a time. */
export function RowMenu({ action, edit }: { action: ProgramAction; edit: Edit }) {
  const [open, setOpen] = React.useState(false)
  const [tool, setTool] = React.useState<Tool | null>(null)
  const btn = React.useRef<HTMLButtonElement>(null)
  const close = React.useCallback(() => {
    setOpen(false)
    setTool(null)
  }, [])
  const pick = (t: Tool) => setTool((cur) => (cur === t ? null : t))
  return (
    <>
      <IconButton
        small
        ref={btn}
        icon={<Icons.Dots />}
        label="Edit"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      />
      {open && (
        <Popover anchor={btn.current} onClose={close} align="right" label={`Edit ${action.title}`}>
          <div className="pb-pop-row">
            <IconButton small icon={<Icons.Pause />} label="Hold: blocks lower actions until done" active={action.onExhaust === 'hold'} onClick={() => edit((d) => setHold(d, action.id, action.onExhaust !== 'hold'))} />
            <IconButton small icon={<Icons.Refresh />} label="Retry after (days)" active={tool === 'cooldown' || !!action.cooldownDays} onClick={() => pick('cooldown')} />
            <IconButton small icon={<Icons.Pencil />} label="Title" active={tool === 'title'} onClick={() => pick('title')} />
            <IconButton small icon={<Icons.ExternalLink />} label="Button label and link" active={tool === 'cta' || !!action.cta} onClick={() => pick('cta')} />
            <IconButton small icon={<Icons.Filter />} label="Only if" active={tool === 'eligible' || !!action.eligible} onClick={() => pick('eligible')} />
            <IconButton small icon={<Icons.CheckCircle />} label="Done when" active={tool === 'satisfied'} onClick={() => pick('satisfied')} />
          </div>
          {tool === 'cooldown' && (
            <input
              className="input"
              type="number"
              min={0}
              autoFocus
              aria-label="Retry after (days)"
              placeholder="days"
              defaultValue={action.cooldownDays ?? ''}
              onChange={(e) => edit((d) => setCooldown(d, action.id, e.target.value))}
            />
          )}
          {tool === 'title' && (
            <input className="input" autoFocus aria-label="Title" defaultValue={action.title} onChange={(e) => edit((d) => setTitle(d, action.id, e.target.value))} />
          )}
          {tool === 'cta' && <CtaEditor action={action} edit={edit} />}
          {(tool === 'eligible' || tool === 'satisfied') && <PredicateEditor key={tool} which={tool} action={action} edit={edit} />}
        </Popover>
      )}
    </>
  )
}

function CtaEditor({ action, edit }: { action: ProgramAction; edit: Edit }) {
  const [label, setLabel] = React.useState(action.cta?.label ?? '')
  const [url, setUrl] = React.useState(action.cta?.url ?? '')
  const apply = (l: string, u: string) => edit((d) => setCta(d, action.id, l, u))
  return (
    <>
      <input className="input" autoFocus aria-label="Button label" placeholder="Label" value={label} onChange={(e) => (setLabel(e.target.value), apply(e.target.value, url))} />
      <input className="input" aria-label="Button link" placeholder="/path or https://" value={url} onChange={(e) => (setUrl(e.target.value), apply(label, e.target.value))} />
    </>
  )
}

function preview(p: unknown): string {
  try {
    return describePredicate(p as any)
  } catch {
    return 'Not a valid condition'
  }
}

function PredicateEditor({ which, action, edit }: { which: 'eligible' | 'satisfied'; action: ProgramAction; edit: Edit }) {
  const [text, setText] = React.useState(predicateText(action[which]))
  const parsed = parsePredicateText(text, which === 'satisfied')
  return (
    <>
      <textarea
        className="textarea"
        style={{ width: 320 }}
        autoFocus
        spellCheck={false}
        aria-label={which === 'eligible' ? 'Only if (JSON)' : 'Done when (JSON)'}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const r = parsePredicateText(e.target.value, which === 'satisfied')
          if (r.ok) edit((d) => setPredicate(d, action.id, which, r.value))
        }}
      />
      {parsed.ok ? (
        parsed.value && <div className="pb-pred-preview">{preview(parsed.value)}</div>
      ) : (
        <div className="pb-pred-err">{parsed.error}</div>
      )}
    </>
  )
}
