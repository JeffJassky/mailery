/* Broadcasts list */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { sample } from '../lib/mock'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'

export function Broadcasts({ setRoute }: any) {
  const { data: broadcasts } = useLive(() => api.broadcasts(), sample.broadcasts)

  return (
    <>
      <PageHead
        title="Broadcasts"
        desc="One-off campaigns. Confirmation gate kicks in above 1,000 recipients."
        actions={<button className="btn btn-primary" onClick={() => setRoute({ screen: 'broadcast-new' })}><Icons.Plus size={14} />New broadcast</button>}
      />

      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <div className="kpi">
          <div className="kpi-label">Total</div>
          <div className="kpi-value">{broadcasts.length}</div>
          <div className="kpi-meta">All-time</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Scheduled</div>
          <div className="kpi-value">{broadcasts.filter((b: any) => b.status === 'scheduled').length}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Drafts</div>
          <div className="kpi-value">{broadcasts.filter((b: any) => b.status === 'draft').length}</div>
        </div>
      </div>

      <div className="card card-pad-0">
        <div className="card-head">
          <span className="card-title">All broadcasts</span>
          <div className="card-actions">
            <div className="seg">
              <span className="seg-item active">All</span>
              <span className="seg-item">Sent</span>
              <span className="seg-item">Scheduled</span>
              <span className="seg-item">Drafts</span>
            </div>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Broadcast</th>
              <th>Status</th>
              <th>When</th>
              <th className="num">Recipients</th>
              <th className="num">Opens</th>
              <th className="num">Clicks</th>
              <th style={{ width: 32 }}></th>
            </tr>
          </thead>
          <tbody>
            {broadcasts.map((b: any) => {
              const recipients = b.recipients ?? b.recipientCount
              const opens = b.opens ?? (recipients ? (b.stats?.opened ?? 0) / recipients : null)
              const clicks = b.clicks ?? (recipients ? (b.stats?.clicked ?? 0) / recipients : null)
              return (
                <tr key={b.slug}>
                  <td>
                    <div className="f500">{b.name}</div>
                    <div className="text-xs subtle mono">broadcasts/{b.slug}</div>
                  </td>
                  <td><StatusPill status={b.status} /></td>
                  <td className="text-xs subtle">{b.scheduledAt ? (typeof b.scheduledAt === 'string' ? b.scheduledAt : new Date(b.scheduledAt).toLocaleString()) : '—'}</td>
                  <td className="num tabular">{recipients ? Number(recipients).toLocaleString() : '—'}</td>
                  <td className="num tabular">{opens != null ? (opens * 100).toFixed(1) + '%' : '—'}</td>
                  <td className="num tabular">{clicks != null ? (clicks * 100).toFixed(1) + '%' : '—'}</td>
                  <td><Icons.Dots size={14} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
