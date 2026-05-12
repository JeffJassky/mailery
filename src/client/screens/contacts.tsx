/* Contacts list */
import { PageHead, StatusPill } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Contacts({ setRoute }: any) {
  const { data: live, loading, error, refetch } = useLive(() => api.contacts())
  const contacts = live?.contacts ?? []
  const counts = (live as any)?.counts ?? null

  return (
    <>
      <PageHead
        title="Contacts"
        desc={<>Read-through to the host's <span className="mono">users</span> collection via ContactAdapter.</>}
      />

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Subscribed</div><div className="kpi-value">{counts ? counts.subscribed.toLocaleString() : '—'}</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Pending DOI</div><div className="kpi-value">{counts ? counts.pending_doi.toLocaleString() : '—'}</div></div>
        <div className="kpi"><div className="kpi-label">Unsubscribed</div><div className="kpi-value">{counts ? counts.unsubscribed.toLocaleString() : '—'}</div></div>
        <div className="kpi"><div className="kpi-label">Showing</div><div className="kpi-value">{live ? contacts.length.toLocaleString() : '—'}</div><div className="kpi-meta subtle">{(live as any)?.nextCursor ? 'first page · more available' : (live ? 'all loaded' : '')}</div></div>
      </div>

      <div className="card card-pad-0">
        <LoadState loading={loading && !live} error={error} empty={!!live && contacts.length === 0} emptyLabel="No contacts yet." retry={refetch}>
          <table className="table">
            <thead>
              <tr>
                <th>Contact</th><th>Status</th><th>Tags</th><th className="num">externalId</th>
              </tr>
            </thead>
            <tbody>
              {contacts.length === 0 ? (
                <EmptyRow colSpan={4} label="No contacts yet." />
              ) : (
                contacts.map((c: any) => {
                  const externalId = c.externalId
                  const name = c.fields?.firstName ? `${c.fields.firstName} ${c.fields.lastName ?? ''}`.trim() : c.email
                  const initials = String(name).split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()
                  return (
                    <tr key={externalId} onClick={() => setRoute({ screen: 'contact-detail', id: externalId })}>
                      <td>
                        <div className="hstack">
                          <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-sunken)', color: 'var(--fg-muted)', display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 12 }}>
                            {initials || '?'}
                          </div>
                          <div>
                            <div className="f500">{name}</div>
                            <div className="text-xs subtle">{c.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {c.status
                          ? <StatusPill status={c.status === 'pending_doi' ? 'queued' : c.status} />
                          : <span className="subtle text-xs">—</span>}
                      </td>
                      <td>
                        {Array.isArray(c.tags) && c.tags.length > 0
                          ? c.tags.map((t: string) => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>)
                          : <span className="subtle text-xs">—</span>}
                      </td>
                      <td className="num mono text-xs">{externalId}</td>
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
