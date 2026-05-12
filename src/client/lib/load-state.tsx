/**
 * Rendering helpers for the (loading | error | empty | data) state machine.
 * Replaces the mock-fallback that screens used to lean on, so we never show
 * fabricated rows or numbers while data is pending or unreachable.
 */

import React from 'react'

export function LoadState({
  loading,
  error,
  empty,
  emptyLabel = 'No data yet.',
  retry,
  children,
}: {
  loading: boolean
  error: Error | null
  empty: boolean
  emptyLabel?: string
  retry?: () => void
  children: React.ReactNode
}) {
  if (loading) {
    return <div className="text-xs subtle" style={{ padding: 16 }}>Loading…</div>
  }
  if (error) {
    return (
      <div className="text-xs" style={{ padding: 16, color: 'var(--red-fg)' }}>
        Failed to load: {error.message}
        {retry && (
          <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={retry}>
            Retry
          </button>
        )}
      </div>
    )
  }
  if (empty) {
    return <div className="text-xs subtle" style={{ padding: 16 }}>{emptyLabel}</div>
  }
  return <>{children}</>
}

export function EmptyRow({ colSpan, label = 'No data yet.' }: { colSpan: number; label?: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="subtle text-xs" style={{ padding: 16, textAlign: 'center' }}>
        {label}
      </td>
    </tr>
  )
}
