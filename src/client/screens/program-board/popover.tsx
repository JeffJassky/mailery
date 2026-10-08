import React from 'react'

/**
 * Small fixed-position popover under (or above, near the bottom edge) an
 * anchor element. Closes on outside press and on Esc (which it swallows, so
 * an open drawer stays open).
 */
export function Popover({
  anchor,
  onClose,
  children,
  align = 'left',
  label,
}: {
  anchor: HTMLElement | null
  onClose: () => void
  children: React.ReactNode
  align?: 'left' | 'right'
  label: string
}) {
  const panel = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)

  React.useLayoutEffect(() => {
    if (!anchor || !panel.current) return
    const place = () => {
      const a = anchor.getBoundingClientRect()
      const p = panel.current!.getBoundingClientRect()
      const left = align === 'right' ? a.right - p.width : a.left
      const below = a.bottom + 6
      const top = below + p.height > window.innerHeight - 8 ? Math.max(8, a.top - p.height - 6) : below
      setPos({ left: Math.max(8, Math.min(left, window.innerWidth - p.width - 8)), top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, align])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
      anchor?.focus()
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [anchor, onClose])

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className="pb-pop"
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  )
}
