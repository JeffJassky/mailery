import React from 'react'
import { Icons } from '../../components/icons'
import { IconButton, Tip } from '../../components/tip'
import { Popover } from './popover'
import type { TemplateChoice } from './edit'

export function TemplateSelect({
  value,
  choices,
  onChange,
  label = 'Template',
  autoFocus,
}: {
  value: string
  choices: TemplateChoice[]
  onChange: (slug: string) => void
  label?: string
  autoFocus?: boolean
}) {
  const known = choices.some((c) => c.slug === value)
  return (
    <select className="select" aria-label={label} value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="" />}
      {!known && value && <option value={value}>{value}</option>}
      {choices.map((c) => (
        <option key={c.slug} value={c.slug}>
          {c.subject || c.name} ({c.slug}){c.published ? '' : ' · draft'}
        </option>
      ))}
    </select>
  )
}

/** Edit controls inside the cell drawer: template, per-attempt gap, remove. */
export function DrawerEdit({
  templateSlug,
  gapDays,
  programGapDays,
  choices,
  onTemplate,
  onGap,
  onRemove,
  removable,
  isSunset,
}: {
  templateSlug: string
  gapDays: number | undefined
  programGapDays: number
  choices: TemplateChoice[]
  onTemplate: (slug: string) => void
  onGap: (raw: string) => void
  onRemove: () => void
  removable: boolean
  isSunset: boolean
}) {
  const [gap, setGap] = React.useState(gapDays == null ? '' : String(gapDays))
  return (
    <div className="pb-pop-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <TemplateSelect value={templateSlug} choices={choices} onChange={onTemplate} />
      </div>
      {!isSunset && (
        <>
          <Tip label="Gap override (days)">
            <span className="pb-noun">
              <Icons.Clock />
            </span>
          </Tip>
          <input
            className="input"
            style={{ width: 64 }}
            type="number"
            min={0}
            step="any"
            aria-label="Gap override (days)"
            placeholder={String(programGapDays)}
            value={gap}
            onChange={(e) => {
              setGap(e.target.value)
              onGap(e.target.value)
            }}
          />
          <IconButton
            icon={<Icons.Trash />}
            label={removable ? 'Remove this email' : 'The only email in this action'}
            tone="danger"
            disabled={!removable}
            onClick={onRemove}
          />
        </>
      )}
    </div>
  )
}

/** Popover opened by the `+` cell: pick the template for the new email. */
export function AddAttemptPopover({
  anchor,
  choices,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null
  choices: TemplateChoice[]
  onPick: (slug: string) => void
  onClose: () => void
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} label="Add an email">
      <TemplateSelect
        value=""
        choices={choices}
        autoFocus
        label="Template for the new email"
        onChange={(slug) => {
          if (slug) onPick(slug)
        }}
      />
    </Popover>
  )
}

export function EditFooter({
  saving,
  message,
  onDiscard,
  onSave,
}: {
  saving: boolean
  message: string | null
  onDiscard: () => void
  onSave: () => void
}) {
  return (
    <div className="pb-footer" role="region" aria-label="Unsaved changes">
      {message && <span className="msg">{message}</span>}
      <button type="button" className="btn btn-ghost" disabled={saving} onClick={onDiscard}>
        Discard
      </button>
      <button type="button" className="btn btn-primary" disabled={saving} onClick={onSave}>
        Save draft
      </button>
    </div>
  )
}
