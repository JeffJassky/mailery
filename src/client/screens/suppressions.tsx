/* Suppressions list */
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Suppressions(_: any) {
  const { data: suppressions, loading, error, refetch } = useLive(() => api.suppressions())
  const rows = suppressions ?? []
  const reasonCount = (reason: string) => rows.filter((s: any) => s.reason === reason).length

  return (
    <>
      <PageHead
        title="Suppressions"
        desc="Do-not-send list scoped by kind. Auto-added on hard bounce, complaint, or unsubscribe."
        actions={
          <>
            <button className="btn"><Icons.Download size={14} />Export CSV</button>
            <button className="btn btn-primary"><Icons.Plus size={14} />Add suppression</button>
          </>
        }
      />

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Total suppressed</div><div className="kpi-value">{suppressions ? rows.length : '—'}</div><div className="kpi-meta subtle">All scopes</div></div>
        <div className="kpi"><div className="kpi-label">Hard bounce</div><div className="kpi-value">{suppressions ? reasonCount('hard_bounce') : '—'}</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Complaints</div><div className="kpi-value">{suppressions ? reasonCount('complaint') : '—'}</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Unsubscribed</div><div className="kpi-value">{suppressions ? reasonCount('unsubscribed') : '—'}</div></div>
      </div>

      <div className="card card-pad-0">
        <LoadState loading={loading && !suppressions} error={error} empty={!!suppressions && rows.length === 0} emptyLabel="No suppressions yet." retry={refetch}>
          <table className="table">
            <thead>
              <tr><th>Email</th><th>Scope</th><th>Reason</th><th>Source</th><th>Added</th><th style={{ width: 32 }}></th></tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={6} label="No suppressions yet." />
              ) : (
                rows.map((s: any, i: number) => (
                  <tr key={String(s._id ?? (s.email ?? '') + s.scope + i)}>
                    <td className="mono text-xs">{s.email ?? <span className="subtle">(hash only)</span>}</td>
                    <td><span className={'pill ' + (s.scope === 'all' ? 'red' : 'amber')}>{s.scope}</span></td>
                    <td><span className="tag">{s.reason}</span></td>
                    <td className="text-xs subtle mono">{s.source ?? '—'}</td>
                    <td className="text-xs subtle">{s.addedAt ? new Date(s.addedAt).toLocaleString() : '—'}</td>
                    <td><Icons.Dots size={14} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </LoadState>
      </div>
    </>
  )
}
