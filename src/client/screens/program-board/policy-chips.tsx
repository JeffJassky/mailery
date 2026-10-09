import React from 'react'
import { Icons } from '../../components/icons'
import { Tip } from '../../components/tip'
import type { ProgramDefinition } from '../../../shared/types'
import type { ChipKey, PolicyChip } from './policy-format'
import { EDITABLE_CHIPS, applyChipEdit, chipFields, type ChipField } from './edit'
import { Popover } from './popover'

/**
 * Policy chips. Read-only by default; with `def` + `onEdit` (edit mode) the
 * policy chips become buttons that open a tiny popover with their inputs.
 */
export function PolicyChips({
  chips,
  def,
  onEdit,
}: {
  chips: PolicyChip[]
  def?: ProgramDefinition
  onEdit?: (next: ProgramDefinition) => void
}) {
  const [open, setOpen] = React.useState<ChipKey | null>(null)
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null)
  const close = React.useCallback(() => setOpen(null), [])
  return (
    <div className="pb-chips">
      {chips.map((c) => {
        const Icon = Icons[c.icon]
        const inner = (
          <>
            <Icon />
            <span>{c.value}</span>
          </>
        )
        if (def && onEdit && EDITABLE_CHIPS.has(c.key)) {
          return (
            <React.Fragment key={c.key}>
              <Tip label={c.tip}>
                <button
                  type="button"
                  className="pb-chip editable"
                  aria-label={c.tip}
                  aria-expanded={open === c.key}
                  onClick={(e) => {
                    setAnchor(e.currentTarget)
                    setOpen(open === c.key ? null : c.key)
                  }}
                >
                  {inner}
                </button>
              </Tip>
              {open === c.key && (
                <Popover anchor={anchor} onClose={close} label={c.tip}>
                  <ChipForm chipKey={c.key} def={def} onEdit={onEdit} />
                </Popover>
              )}
            </React.Fragment>
          )
        }
        return (
          <Tip key={c.key} label={c.tip} focusable>
            <span className="pb-chip">{inner}</span>
          </Tip>
        )
      })}
    </div>
  )
}

function ChipForm({ chipKey, def, onEdit }: { chipKey: ChipKey; def: ProgramDefinition; onEdit: (d: ProgramDefinition) => void }) {
  const fields = chipFields(chipKey, def)
  const [vals, setVals] = React.useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.value])))
  function set(name: string, value: string) {
    const next = { ...vals, [name]: value }
    setVals(next)
    const edited = applyChipEdit(def, chipKey, next)
    if (edited !== def) onEdit(edited)
  }
  return (
    <div className="pb-pop-row">
      {fields.map((f, i) => (
        <FieldInput key={f.name} first={i === 0} f={f} value={vals[f.name] ?? ''} onChange={(v) => set(f.name, v)} />
      ))}
    </div>
  )
}

function FieldInput({ f, value, onChange, first }: { f: ChipField; value: string; onChange: (v: string) => void; first: boolean }) {
  if (f.kind === 'bool') {
    return (
      <Tip label={f.label}>
        <label className="pb-chip" style={{ cursor: 'pointer' }}>
          <input type="checkbox" aria-label={f.label} checked={!!value} onChange={(e) => onChange(e.target.checked ? '1' : '')} />
          <Icons.Calendar />
        </label>
      </Tip>
    )
  }
  return (
    <Tip label={f.label}>
      <input
        className="input"
        style={{ width: f.kind === 'time' ? 84 : 64 }}
        aria-label={f.label}
        autoFocus={first}
        type={f.kind === 'number' ? 'number' : 'text'}
        placeholder={f.kind === 'time' ? 'HH:MM' : ''}
        value={value}
        min={f.kind === 'number' ? 0 : undefined}
        step="any"
        onChange={(e) => onChange(e.target.value)}
      />
    </Tip>
  )
}
