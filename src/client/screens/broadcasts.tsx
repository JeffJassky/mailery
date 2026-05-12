/* Broadcasts list */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { sample } from '../lib/mock'

export function Broadcasts({ setRoute }: any) {
  return (
    <>
      <PageHead
        title="Broadcasts"
        desc="One-off campaigns. Confirmation gate kicks in above 1,000 recipients."
        actions={<button className="btn btn-primary" onClick={() => setRoute({ screen: 'broadcast-new' })}><Icons.Plus size={14} />New broadcast</button>}
      />

      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <div className="kpi">
          <div className="kpi-label">Next scheduled</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>May 14 · 10:00 PT</div>
          <div className="kpi-meta"><span className="mono">feature-import-beta</span> · 4,231 recipients</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Last 30 days</div>
          <div className="kpi-value">22,528</div>
          <div className="kpi-meta">Across 3 broadcasts · 44.2% open</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Audience reach</div>
          <div className="kpi-value">68.4%</div>
          <div className="kpi-meta">Of subscribed audience touched · 30d</div>
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
            {sample.broadcasts.map((b) => (
              <tr key={b.slug}>
                <td>
                  <div className="f500">{b.name}</div>
                  <div className="text-xs subtle mono">broadcasts/{b.slug}</div>
                </td>
                <td><StatusPill status={b.status} /></td>
                <td className="text-xs subtle">{b.scheduledAt || '—'}</td>
                <td className="num tabular">{b.recipients ? b.recipients.toLocaleString() : '—'}</td>
                <td className="num tabular">{b.opens != null ? (b.opens * 100).toFixed(1) + '%' : '—'}</td>
                <td className="num tabular">{b.clicks != null ? (b.clicks * 100).toFixed(1) + '%' : '—'}</td>
                <td><Icons.Dots size={14} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
