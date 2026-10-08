import React from 'react'
import { Icons } from '../../components/icons'
import { IconButton, Tip } from '../../components/tip'
import type { ProgramSource } from '../../lib/api'

export function SourceSwitch({
  value,
  onChange,
  publishedAvailable,
}: {
  value: ProgramSource
  onChange: (s: ProgramSource) => void
  publishedAvailable: boolean
}) {
  return (
    <div className="seg" role="group" aria-label="Source">
      {(['published', 'draft'] as const).map((s) => (
        <button
          key={s}
          type="button"
          className={'seg-item' + (value === s ? ' active' : '')}
          aria-pressed={value === s}
          disabled={s === 'published' && !publishedAvailable}
          onClick={() => onChange(s)}
        >
          {s === 'published' ? 'Published' : 'Draft'}
        </button>
      ))}
    </div>
  )
}

export function LensInput({
  value,
  onChange,
  onCommit,
  onClear,
  error,
  factsOpen,
  factsAvailable,
  onToggleFacts,
  noRun,
}: {
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  onClear: () => void
  error: string | null
  factsOpen: boolean
  factsAvailable: boolean
  onToggleFacts: () => void
  noRun: boolean
}) {
  return (
    <div className="hstack" style={{ gap: 4 }}>
      <div className="pb-lens">
        <Icons.User />
        <input
          className="input"
          placeholder="Account id"
          aria-label="Account id"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit()
            if (e.key === 'Escape') onClear()
          }}
          onBlur={onCommit}
        />
        {value && (
          <span className="pb-lens-x">
            <IconButton small icon={<Icons.X />} label="Clear" onClick={onClear} />
          </span>
        )}
      </div>
      {noRun && (
        <Tip label="No run yet" focusable>
          <span className="pb-noun">
            <Icons.User />
          </span>
        </Tip>
      )}
      {error && (
        <Tip label={error} focusable>
          <span className="pb-lens-flag">
            <Icons.AlertTriangle />
          </span>
        </Tip>
      )}
      <IconButton
        icon={<Icons.Beaker />}
        label={factsAvailable ? 'Simulate facts' : 'No facts declared'}
        active={factsOpen}
        disabled={!factsAvailable}
        onClick={onToggleFacts}
      />
    </div>
  )
}
