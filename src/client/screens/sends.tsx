/* Sends log */
import { PageHead, StatusPill } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Sends({ setRoute }: any) {
  const { data: sends, loading, error, refetch } = useLive(() => api.sends())
  const rows = sends ?? []

  return (
    <>
      <PageHead
        title="Sends"
        desc="Every send. Live status from provider webhooks."
      />

      <div className="filter-bar">
        <span className="grow" />
        <span className="text-xs subtle tabular">{sends ? `${rows.length} shown` : 'Loading…'}</span>
      </div>

      <div className="card card-pad-0">
        <LoadState loading={loading && !sends} error={error} empty={!!sends && rows.length === 0} emptyLabel="No sends yet." retry={refetch}>
          <table className="table">
            <thead>
              <tr>
                <th>id</th><th>Template</th><th>To</th><th>Status</th><th>Flow</th>
                <th className="num">Opens</th><th className="num">Clicks</th><th>Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={8} label="No sends yet." />
              ) : (
                rows.map((s: any) => (
                  <tr key={s._id ?? s.id} onClick={() => setRoute({ screen: 'send-detail', id: String(s._id ?? s.id) })}>
                    <td className="mono text-xs">{String(s._id ?? s.id).slice(-8)}</td>
                    <td className="mono">{s.templateSlug ?? '—'}</td>
                    <td className="text-xs">{s.emailAtSend ?? '—'}</td>
                    <td>
                      <StatusPill status={s.status} />
                      {s.bounceType && <span className="text-xs subtle" style={{ marginLeft: 6 }}>· {s.bounceType}</span>}
                    </td>
                    <td>{s.flowSlug ? <span className="tag">{s.flowSlug}</span> : <span className="subtle text-xs">—</span>}</td>
                    <td className="num tabular">{s.openCount ?? 0}</td>
                    <td className="num tabular">{s.clickCount ?? 0}</td>
                    <td className="text-xs subtle">{formatRelative(s.queuedAt)}</td>
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

function formatRelative(d: any): string {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}
