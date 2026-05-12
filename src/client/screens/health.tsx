/* Health */
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Health(_: any) {
  const { data: health, loading, error, refetch } = useLive(() => api.health())
  const { data: trips } = useLive(() => api.healthTrips())
  const { data: me } = useLive(() => api.me())

  const rates = (health as any)?.rates ?? {}
  const fmt = (n: number | undefined) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`)
  const status = (health as any)?.status

  return (
    <>
      <PageHead
        title="Health"
        desc="Circuit breaker · rolling window · provider status."
        actions={
          <>
            <span className={'pill ' + statusClass(status)}><span className="dot" />{status ?? '…'}</span>
            <button className="btn"><Icons.Pause size={14} />Pause all sends</button>
          </>
        }
      />

      <LoadState loading={loading && !health} error={error} empty={false} retry={refetch}>
        <div className="kpis">
          <div className="kpi"><div className="kpi-label">Hard bounce / 1h</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>{fmt(rates.hardBounceRate)}</div><div className="kpi-meta subtle">Trip @ 2.00%</div></div>
          <div className="kpi"><div className="kpi-label">Complaint / 1h</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>{fmt(rates.complaintRate)}</div><div className="kpi-meta subtle">Trip @ 0.30%</div></div>
          <div className="kpi"><div className="kpi-label">Combined bounce</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>{fmt(rates.combinedBounceRate ?? rates.bounceRate)}</div><div className="kpi-meta subtle">Trip @ 5.00%</div></div>
          <div className="kpi"><div className="kpi-label">Failed-to-send</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>{fmt(rates.failureRate)}</div><div className="kpi-meta subtle">Degrade @ 10.00%</div></div>
        </div>

        <div className="split split-asym" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="card-head"><span className="card-title">Recent trips</span><span className="card-sub">From audit log</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="table">
                <thead><tr><th>When</th><th>Action</th><th>Detail</th><th>Actor</th></tr></thead>
                <tbody>
                  {!trips ? (
                    <EmptyRow colSpan={4} label="Loading…" />
                  ) : trips.length === 0 ? (
                    <EmptyRow colSpan={4} label="No trips or resumes recorded." />
                  ) : (
                    trips.map((t: any, i: number) => (
                      <tr key={String(t._id ?? i)}>
                        <td className="text-xs">{t.occurredAt ? new Date(t.occurredAt).toLocaleString() : '—'}</td>
                        <td>
                          <span className={'pill ' + (t.action === 'health.trip' ? 'red' : 'green')}>
                            <span className="dot" />{t.action === 'health.trip' ? 'Tripped' : 'Resumed'}
                          </span>
                        </td>
                        <td className="text-xs mono">{t.diffSummary ?? '—'}</td>
                        <td className="text-xs mono">{t.actor ?? '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Providers</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 10 }}>
              {!me ? (
                <div className="text-xs subtle">Loading…</div>
              ) : me.providers.names.length === 0 ? (
                <div className="text-xs subtle">No providers configured.</div>
              ) : (
                me.providers.names.map((name) => (
                  <div key={name} className="hstack" style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
                    <div style={{ width: 30, height: 30, borderRadius: 7, background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center' }}>
                      <Icons.Mail size={14} />
                    </div>
                    <div>
                      <div className="f500 text-sm">{name}</div>
                      <div className="text-xs subtle">{name === me.providers.default ? 'default' : 'configured'}</div>
                    </div>
                    <span className="grow" />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </LoadState>
    </>
  )
}

function statusClass(s: string | undefined): string {
  if (s === 'tripped') return 'red'
  if (s === 'degraded') return 'amber'
  return 'green'
}
