/**
 * Text input with `{{variable}}` autocomplete. When the caret sits after an
 * unclosed `{{`, a dropdown lists matching var paths from the host's vars
 * schema (plus mailery built-ins). Enter/Tab inserts, Esc dismisses.
 */
import React from 'react'

import type { VarPathEntry } from '../lib/vars-schema'

interface VarInputProps {
  value: string
  onChange: (value: string) => void
  paths: VarPathEntry[]
  className?: string
  placeholder?: string
}

interface OpenState {
  /** Index of the `{{` that opened the completion. */
  anchor: number
  query: string
  selected: number
}

export function VarInput({ value, onChange, paths, className, placeholder }: VarInputProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = React.useState<OpenState | null>(null)

  const matches = React.useMemo(() => {
    if (!open) return []
    const q = open.query.toLowerCase()
    return paths.filter((p) => p.path.toLowerCase().includes(q)).slice(0, 8)
  }, [open, paths])

  function refresh(next: string, caret: number | null) {
    onChange(next)
    if (caret == null) {
      setOpen(null)
      return
    }
    // Find an unclosed `{{` before the caret; text after it (up to caret) is the query.
    const upToCaret = next.slice(0, caret)
    const anchor = upToCaret.lastIndexOf('{{')
    if (anchor === -1 || upToCaret.slice(anchor).includes('}}')) {
      setOpen(null)
      return
    }
    const query = upToCaret.slice(anchor + 2).trimStart()
    if (/[{}]/.test(query)) {
      setOpen(null)
      return
    }
    setOpen({ anchor, query, selected: 0 })
  }

  function accept(entry: VarPathEntry) {
    if (!open) return
    const input = inputRef.current
    const caret = input?.selectionStart ?? value.length
    const before = value.slice(0, open.anchor)
    const after = value.slice(caret)
    const insertion = `{{${entry.path}}}`
    const next = `${before}${insertion}${after}`
    onChange(next)
    setOpen(null)
    requestAnimationFrame(() => {
      const pos = before.length + insertion.length
      input?.setSelectionRange(pos, pos)
      input?.focus()
    })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || matches.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen({ ...open, selected: (open.selected + 1) % matches.length })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen({ ...open, selected: (open.selected - 1 + matches.length) % matches.length })
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      accept(matches[Math.min(open.selected, matches.length - 1)]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(null)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        className={className ?? 'input'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => refresh(e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(null), 150)}
        onClick={(e) => refresh(value, (e.target as HTMLInputElement).selectionStart)}
      />
      {open && matches.length > 0 && (
        <div
          className="card"
          role="listbox"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 40,
            marginTop: 4, maxHeight: 240, overflow: 'auto', padding: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          }}
        >
          {matches.map((entry, i) => (
            <div
              key={entry.path}
              role="option"
              aria-selected={i === open.selected}
              onMouseDown={(e) => { e.preventDefault(); accept(entry) }}
              onMouseEnter={() => setOpen({ ...open, selected: i })}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 12,
                padding: '6px 8px', borderRadius: 4, cursor: 'pointer',
                background: i === open.selected ? 'var(--bg-sunken)' : 'transparent',
              }}
            >
              <span className="mono text-xs">{`{{${entry.path}}}`}</span>
              <span className="text-xs subtle">{entry.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
