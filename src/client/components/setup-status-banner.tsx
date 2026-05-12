/**
 * Setup-status banner — surfaces config/runtime issues on the dashboard.
 * Renders nothing if all checks pass. Polls every 60s.
 */
import React from 'react'
import { Icons } from './icons'
import { api, type CheckSeverity, type SetupCheck, type SetupStatus } from '../lib/api'

export function SetupStatusBanner() {
  const [status, setStatus] = React.useState<SetupStatus | null>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const s = await api.setupStatus()
        if (!cancelled) {
          setStatus(s)
          setError(null)
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'failed to load setup status')
      }
    }
    load()
    const id = window.setInterval(load, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  if (error) {
    return (
      <div className="card" style={bannerStyle('error')}>
        <BannerHead severity="error" label="Setup checks failed to load" detail={error} />
      </div>
    )
  }

  if (!status) return null

  const problems = status.checks.filter((c) => c.severity !== 'ok')
  if (problems.length === 0) return null

  const errorCount = problems.filter((c) => c.severity === 'error').length
  const warnCount = problems.filter((c) => c.severity === 'warn').length

  const severity: CheckSeverity = errorCount > 0 ? 'error' : 'warn'
  const label =
    errorCount > 0 && warnCount > 0
      ? `${errorCount} error${errorCount === 1 ? '' : 's'}, ${warnCount} warning${warnCount === 1 ? '' : 's'}`
      : errorCount > 0
      ? `${errorCount} setup error${errorCount === 1 ? '' : 's'}`
      : `${warnCount} setup warning${warnCount === 1 ? '' : 's'}`

  return (
    <div className="card" style={bannerStyle(severity)}>
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: 12,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: 'inherit',
          font: 'inherit',
        }}
      >
        <BannerHead severity={severity} label={label} />
        <span className="grow" />
        <span className="text-xs subtle">{expanded ? 'Hide' : 'Show'} details</span>
        <Icons.Chevron size={14} style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }} />
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px' }}>
          {problems.map((c) => <CheckRow key={c.name} c={c} />)}
        </div>
      )}
    </div>
  )
}

function CheckRow({ c }: { c: SetupCheck }) {
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px dashed var(--border)' }}>
      <div className="hstack" style={{ gap: 8 }}>
        <SeverityDot severity={c.severity} />
        <span className="text-sm" style={{ fontWeight: 600 }}>{c.label}</span>
        <span className="text-sm subtle">·</span>
        <span className="text-sm">{c.message}</span>
      </div>
      {c.hint && (
        <div className="text-xs subtle" style={{ marginLeft: 18, marginTop: 4 }}>
          {c.hint}
        </div>
      )}
    </div>
  )
}

function BannerHead({ severity, label, detail }: { severity: CheckSeverity; label: string; detail?: string }) {
  return (
    <>
      <SeverityDot severity={severity} />
      <span style={{ fontWeight: 600 }}>{label}</span>
      {detail && <span className="text-xs subtle" style={{ marginLeft: 8 }}>{detail}</span>}
    </>
  )
}

function SeverityDot({ severity }: { severity: CheckSeverity }) {
  const color =
    severity === 'error' ? 'var(--red-fg)' : severity === 'warn' ? 'var(--amber-fg)' : 'var(--green-fg)'
  return <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' }} />
}

function bannerStyle(severity: CheckSeverity): React.CSSProperties {
  const border =
    severity === 'error' ? 'var(--red-fg)' : severity === 'warn' ? 'var(--amber-fg)' : 'var(--border)'
  const bg =
    severity === 'error' ? 'var(--red-bg, rgba(239,68,68,0.06))' :
    severity === 'warn' ? 'var(--amber-bg, rgba(245,158,11,0.06))' :
    'transparent'
  return {
    marginBottom: 16,
    borderLeft: `3px solid ${border}`,
    background: bg,
    overflow: 'hidden',
  }
}
