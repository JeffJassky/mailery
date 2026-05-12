/* Broadcasts list */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Broadcasts({ setRoute }: any) {
  const { data: broadcasts, loading, error, refetch } = useLive(() => api.broadcasts())
  const { data: me } = useLive(() => api.me())
  const threshold = me?.broadcastConfirmationThreshold
  const rows = broadcasts ?? []

  return (
    <>
      <PageHead
        title="Broadcasts"
        desc={threshold != null
          ? `One-off campaigns. Confirmation gate kicks in above ${threshold.toLocaleString()} recipients.`
          : 'One-off campaigns.'}
        actions={<button className="btn btn-primary" onClick={() => setRoute({ screen: 'broadcast-new' })}><Icons.Plus size={14} />New broadcast</button>}
      />

      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <div className="kpi">
          <div className="kpi-label">Total</div>
          <div className="kpi-value">{broadcasts ? rows.length : '—'}</div>
          <div className="kpi-meta">All-time</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Scheduled</div>
          <div className="kpi-value">{broadcasts ? rows.filter((b: any) => b.status === 'scheduled').length : '—'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Drafts</div>
          <div className="kpi-value">{broadcasts ? rows.filter((b: any) => b.status === 'draft').length : '—'}</div>
        </div>
      </div>

      <div className="card card-pad-0">
        <div className="card-head">
          <span className="card-title">All broadcasts</span>
        </div>
        <LoadState loading={loading && !broadcasts} error={error} empty={!!broadcasts && rows.length === 0} emptyLabel="No broadcasts yet." retry={refetch}>
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
              {rows.length === 0 ? (
                <EmptyRow colSpan={7} label="No broadcasts yet." />
              ) : (
                rows.map((b: any) => {
                  const recipients = b.recipientCount ?? b.recipients
                  const delivered = b.stats?.delivered ?? 0
                  const opens = delivered ? (b.stats?.opened ?? 0) / delivered : null
                  const clicks = delivered ? (b.stats?.clicked ?? 0) / delivered : null
                  return (
                    <tr key={b.slug} onClick={() => setRoute({ screen: 'broadcast-new', slug: b.slug })}>
                      <td>
                        <div className="f500">{b.name}</div>
                        <div className="text-xs subtle mono">broadcasts/{b.slug}</div>
                      </td>
                      <td><StatusPill status={b.status} /></td>
                      <td className="text-xs subtle">{b.scheduledAt ? new Date(b.scheduledAt).toLocaleString() : '—'}</td>
                      <td className="num tabular">{recipients ? Number(recipients).toLocaleString() : '—'}</td>
                      <td className="num tabular">{opens != null ? (opens * 100).toFixed(1) + '%' : '—'}</td>
                      <td className="num tabular">{clicks != null ? (clicks * 100).toFixed(1) + '%' : '—'}</td>
                      <td><Icons.Dots size={14} /></td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </LoadState>
      </div>
    </>
  )
}
