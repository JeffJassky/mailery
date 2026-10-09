import React from 'react'
import { Icons } from '../../components/icons'
import { IconButton, Tip } from '../../components/tip'
import type { FactDecl } from '../../../shared/types'
import { controlValue, hasOverrides, setOverride, type FactOverrides } from './facts-input'

export function FactsPanel({
  decls,
  overrides,
  resolved,
  onChange,
  onReset,
  onClose,
  subjectId,
}: {
  decls: Record<string, FactDecl>
  overrides: FactOverrides
  /** `sim.facts` — the lens account's resolved facts (+ overrides). */
  resolved: Record<string, unknown> | null
  onChange: (next: FactOverrides) => void
  onReset: () => void
  onClose: () => void
  subjectId: string
}) {
  const closeRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    closeRef.current?.focus()
  }, [])
  const names = Object.keys(decls)
  return (
    <aside className="pb-drawer" aria-label="Simulate facts">
      <div className="pb-drawer-head">
        <Icons.Beaker />
        <span className="ttl">{subjectId ? <span className="mono">{subjectId}</span> : 'Facts'}</span>
        <IconButton icon={<Icons.Reset />} label="Reset" disabled={!hasOverrides(overrides)} onClick={onReset} />
        <Tip label="Close (Esc)">
          <button ref={closeRef} type="button" className="icon-btn2" aria-label="Close" onClick={onClose}>
            <Icons.X />
          </button>
        </Tip>
      </div>
      <div className="pb-drawer-body">
        <div className="pb-facts">
          {names.map((name) => (
            <FactRow
              key={name}
              name={name}
              decl={decls[name]!}
              overridden={name in overrides}
              value={controlValue(decls[name]!, overrides[name], resolved?.[name])}
              onSet={(raw) => onChange(setOverride(overrides, name, decls[name]!, raw))}
            />
          ))}
        </div>
      </div>
    </aside>
  )
}

function FactRow({
  name,
  decl,
  value,
  overridden,
  onSet,
}: {
  name: string
  decl: FactDecl
  value: string
  overridden: boolean
  onSet: (raw: string) => void
}) {
  const tip = decl.description ? `${name}\n${decl.description}` : name
  let control: React.ReactNode
  if (decl.type === 'boolean') {
    control = (
      <div className="seg pb-tri" role="group" aria-label={name}>
        {([['', '—'], ['yes', 'yes'], ['no', 'no']] as const).map(([v, label]) => (
          <button key={v} type="button" className={'seg-item' + (value === v ? ' active' : '')} aria-pressed={value === v} onClick={() => onSet(v)}>
            {label}
          </button>
        ))}
      </div>
    )
  } else if (decl.type === 'enum') {
    control = (
      <select className="select" aria-label={name} value={value} onChange={(e) => onSet(e.target.value)}>
        <option value="" />
        {(decl.values ?? []).map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    )
  } else if (decl.type === 'number') {
    control = <input className="input" type="number" aria-label={name} value={value} onChange={(e) => onSet(e.target.value)} />
  } else if (decl.type === 'date') {
    control = <input className="input" type="datetime-local" aria-label={name} value={value} onChange={(e) => onSet(e.target.value)} />
  } else {
    control = <input className="input" type="text" aria-label={name} value={value} onChange={(e) => onSet(e.target.value)} />
  }
  return (
    <div className="pb-fact">
      <Tip label={tip} className="block">
        <span className="name">
          {overridden && <span className="pb-dot" style={{ background: 'var(--accent)' }} />}
          {name}
        </span>
      </Tip>
      {control}
    </div>
  )
}
