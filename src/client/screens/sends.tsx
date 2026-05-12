/* Sends log */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { sample } from '../lib/mock'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'

export function Sends({ setRoute }: any) {
  const { data: sends } = useLive(() => api.sends(), sample.sends)

  return (
    <>
      <PageHead
        title="Sends"
        desc="Every send. Live status from provider webhooks."
        actions={<button className="btn"><Icons.Download size={14} />Export CSV</button>}
      />

      <div className="filter-bar">
        <span className="filter-chip active">Last 1h</span>
        <span className="filter-chip">Template: any</span>
        <span className="filter-chip">Status: any</span>
        <span className="filter-chip">Flow: any</span>
        <span className="grow" />
        <span className="text-xs subtle tabular">{sends.length} shown</span>
      </div>

      <div className="card card-pad-0">
        <table className="table">
          <thead>
            <tr>
              <th>id</th><th>Template</th><th>To</th><th>Status</th><th>Flow</th>
              <th className="num">Opens</th><th className="num">Clicks</th><th>Time</th>
            </tr>
          </thead>
          <tbody>
            {sends.map((s: any) => (
              <tr key={s.id ?? s._id} onClick={() => setRoute({ screen: 'send-detail', id: String(s.id ?? s._id) })}>
                <td className="mono text-xs">{String(s.id ?? s._id).slice(-8)}</td>
                <td className="mono">{s.template ?? s.templateSlug}</td>
                <td className="text-xs">{s.to ?? s.emailAtSend}</td>
                <td>
                  <StatusPill status={s.status} />
                  {s.bounce && <span className="text-xs subtle" style={{ marginLeft: 6 }}>· {s.bounce}</span>}
                  {s.bounceType && !s.bounce && <span className="text-xs subtle" style={{ marginLeft: 6 }}>· {s.bounceType}</span>}
                </td>
                <td>{(s.flow ?? s.flowSlug) ? <span className="tag">{s.flow ?? s.flowSlug}</span> : <span className="subtle text-xs">—</span>}</td>
                <td className="num tabular">{s.opens ?? s.openCount ?? 0}</td>
                <td className="num tabular">{s.clicks ?? s.clickCount ?? 0}</td>
                <td className="text-xs subtle">{s.time ?? formatRelative(s.queuedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
