/* Tip — tiny accessible tooltip. Hover or keyboard focus, ~250 ms delay,
   above the target (flips below near the top edge). A fixed-position element,
   so scroll containers never clip it. */
import React from 'react'
import { placeTip } from '../lib/place-tip'

const DELAY_MS = 250

let nextId = 0

export function Tip({
  label,
  children,
  focusable = false,
  className,
}: {
  /** Plain text; "\n" starts a new line. Empty label renders the child untouched. */
  label: string | null | undefined
  children: React.ReactNode
  /** Make a non-interactive child reachable by keyboard so the tip can be read. */
  focusable?: boolean
  className?: string
}) {
  const id = React.useRef(`tip-${++nextId}`).current
  const wrap = React.useRef<HTMLSpanElement>(null)
  const bubble = React.useRef<HTMLSpanElement>(null)
  const timer = React.useRef<number | undefined>(undefined)
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)

  const hide = React.useCallback(() => {
    window.clearTimeout(timer.current)
    setOpen(false)
    setPos(null)
  }, [])
  const show = React.useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), DELAY_MS)
  }, [])

  React.useEffect(() => () => window.clearTimeout(timer.current), [])

  React.useLayoutEffect(() => {
    if (!open || !wrap.current || !bubble.current) return
    const r = wrap.current.getBoundingClientRect()
    const b = bubble.current.getBoundingClientRect()
    const p = placeTip(r, { w: b.width, h: b.height }, { w: window.innerWidth })
    setPos({ left: p.left, top: p.top })
  }, [open, label])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    window.addEventListener('scroll', hide, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, hide])

  if (!label) return <>{children}</>
  return (
    <span
      ref={wrap}
      className={'tip-wrap' + (className ? ' ' + className : '')}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={hide}
      tabIndex={focusable ? 0 : undefined}
      role={focusable ? 'img' : undefined}
      aria-label={focusable ? label.replace(/\n/g, ' ') : undefined}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          ref={bubble}
          id={id}
          role="tooltip"
          className="tip-bubble"
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
        >
          {label}
        </span>
      )}
    </span>
  )
}

/** Icon-only button. `label` is both the tooltip and the accessible name. */
export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  active,
  tone,
  small,
  className,
  type = 'button',
  ...rest
}: {
  icon: React.ReactNode
  label: string
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  active?: boolean
  tone?: 'danger'
  small?: boolean
  className?: string
  type?: 'button' | 'submit'
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type' | 'children'>) {
  return (
    <Tip label={label}>
      <button
        type={type}
        className={
          'icon-btn2' + (active ? ' active' : '') + (tone === 'danger' ? ' danger' : '') + (small ? ' sm' : '') + (className ? ' ' + className : '')
        }
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        disabled={disabled}
        onClick={onClick}
        {...rest}
      >
        {icon}
      </button>
    </Tip>
  )
}
