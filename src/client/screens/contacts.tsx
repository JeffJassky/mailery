/* Contacts list */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { sample } from '../lib/mock'

export function Contacts({ setRoute }: any) {
  return (
    <>
      <PageHead
        title="Contacts"
        desc={<>Read-through to the host's <span className="mono">users</span> collection via ContactAdapter.</>}
        actions={
          <>
            <button className="btn"><Icons.Download size={14} />Export</button>
            <button className="btn btn-primary"><Icons.Plus size={14} />Add lead</button>
          </>
        }
      />

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Subscribed</div><div className="kpi-value">11,842</div><div className="kpi-meta"><span className="kpi-delta up">▲ 142</span> this week</div></div>
        <div className="kpi"><div className="kpi-label">Pending DOI</div><div className="kpi-value">348</div><div className="kpi-meta subtle">Avg confirm 4h 12m</div></div>
        <div className="kpi"><div className="kpi-label">Unsubscribed</div><div className="kpi-value">412</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Leads</div><div className="kpi-value">38</div><div className="kpi-meta subtle">Not yet promoted</div></div>
      </div>

      <div className="filter-bar">
        <span className="filter-chip active">Status: any</span>
        <span className="filter-chip">Tag: any</span>
        <span className="filter-chip">Tier: any</span>
        <span className="filter-chip">Last event: 30d</span>
        <span className="grow" />
        <span className="filter-chip">Sort: recent activity</span>
      </div>

      <div className="card card-pad-0">
        <table className="table">
          <thead>
            <tr>
              <th>Contact</th><th>Status</th><th>Tier</th><th>Tags</th><th>Last event</th><th className="num">externalId</th>
            </tr>
          </thead>
          <tbody>
            {sample.contacts.map((c) => (
              <tr key={c.id} onClick={() => setRoute({ screen: 'contact-detail', id: c.id })}>
                <td>
                  <div className="hstack">
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-sunken)', color: 'var(--fg-muted)', display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 12 }}>
                      {c.name.split(' ').map((n) => n[0]).join('')}
                    </div>
                    <div>
                      <div className="f500">{c.name}</div>
                      <div className="text-xs subtle">{c.email}</div>
                    </div>
                  </div>
                </td>
                <td><StatusPill status={c.status === 'pending_doi' ? 'queued' : c.status} /></td>
                <td><span className={'pill ' + (c.tier === 'Pro' ? 'accent' : 'neutral')}>{c.tier}</span></td>
                <td>{c.tags.length ? c.tags.map((t) => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>) : <span className="subtle text-xs">—</span>}</td>
                <td className="text-xs subtle">{c.lastEvent}</td>
                <td className="num mono text-xs">{c.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
