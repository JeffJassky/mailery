/* DMARC Monitoring — Alerts card */
import React from 'react'
import { api, type DmarcAlertStateView, type DmarcMonitoringPayload } from '../../lib/api'

type Props = { data: DmarcMonitoringPayload; onChanged: () => void }

const SEVERITY_TONE: Record<DmarcAlertStateView['severity'], string> = {
  info: 'green',
  warning: 'amber',
  critical: 'red',
}

function deliveryLabel(d: DmarcAlertStateView['lastDelivery']): string {
  if (!d) return '—'
  if (d.outcome === 'delivered') return 'Delivered'
  if (d.outcome === 'no_handler') return 'No handler'
  return `Failed: ${d.error}`
}

function AlertRow({ alert, showStatus }: { alert: DmarcAlertStateView; showStatus?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const cols = showStatus ? 7 : 6
  return (
    <>
      <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <td>
          <span className={'pill ' + SEVERITY_TONE[alert.severity]}><span className="dot" />{alert.severity}</span>
        </td>
        <td className="text-sm">{alert.title}</td>
        <td className="mono text-xs">{alert.domain}</td>
        <td className="text-xs">{new Date(alert.firstDetectedAt).toLocaleString()}</td>
        <td className="text-xs">{deliveryLabel(alert.lastDelivery)}</td>
        {showStatus && (
          <td className="text-xs">{alert.resolvedAt ? `Resolved ${new Date(alert.resolvedAt).toLocaleString()}` : alert.status}</td>
        )}
        <td className="text-xs subtle">{open ? 'Hide' : 'Details'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={cols + (showStatus ? 0 : 1)} style={{ background: 'var(--bg-sunken)' }}>
            <pre className="mono text-xs" style={{ margin: 0, padding: '8px 12px', whiteSpace: 'pre-wrap' }}>
              {alert.lastAlert.text}
            </pre>
          </td>
        </tr>
      )}
    </>
  )
}

export function AlertsCard({ data, onChanged }: Props) {
  const [running, setRunning] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [showHistory, setShowHistory] = React.useState(false)

  async function run() {
    setRunning(true)
    setError(null)
    try {
      await api.evaluateDmarcAlerts()
      onChanged()
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setRunning(false)
    }
  }

  const { open, recent } = data.alerts

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <span className="card-title">Alerts</span>
        <span className="card-sub">Problems found in your DMARC reports and DNS.</span>
        <div className="card-actions">
          <button className="btn btn-xs" disabled={running} onClick={run}>
            {running ? 'Running…' : 'Run checks now'}
          </button>
          {error && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{error}</span>}
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {open.length === 0 ? (
          <div className="text-xs subtle" style={{ padding: 16 }}>No open alerts.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Alert</th>
                <th>Domain</th>
                <th>First detected</th>
                <th>Last delivery</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {open.map((a) => <AlertRow key={a.id} alert={a} />)}
            </tbody>
          </table>
        )}
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-xs" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide history' : 'History'}
          </button>
        </div>
        {showHistory && (
          recent.length === 0 ? (
            <div className="text-xs subtle" style={{ padding: '0 16px 16px' }}>No past alerts.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Alert</th>
                  <th>Domain</th>
                  <th>First detected</th>
                  <th>Last delivery</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.map((a) => <AlertRow key={a.id} alert={a} showStatus />)}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  )
}
