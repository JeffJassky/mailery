/* Contact detail */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function ContactDetail({ id }: any) {
  const { data, loading, error, refetch } = useLive(() => api.contact(id))

  return (
    <LoadState loading={loading && !data} error={error} empty={!data} emptyLabel="Contact not found." retry={refetch}>
      {data && <ContactBody data={data} />}
    </LoadState>
  )
}

function ContactBody({ data }: { data: any }) {
  const c = data.contact
  const sub = data.subscription ?? {}
  const events = data.recentEvents ?? []
  const sends = data.recentSends ?? []
  const runs = data.activeRuns ?? []

  const email = c?.email ?? ''
  const name = c?.fields?.firstName ? `${c.fields.firstName} ${c.fields.lastName ?? ''}`.trim() : email
  const externalId = c?.externalId

  return (
    <>
      <PageHead
        title={name}
        desc={<><span className="mono">{email}</span> · <span className="mono">{externalId}</span></>}
      />

      <div className="split split-asym">
        <div className="vstack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><span className="card-title">Active flow runs</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="table">
                <thead><tr><th>Flow</th><th>Current step</th><th>Next action</th><th>Entered</th></tr></thead>
                <tbody>
                  {runs.length > 0 ? (
                    runs.map((r: any, i: number) => (
                      <tr key={i}>
                        <td className="mono">{r.flowSlug}</td>
                        <td>Step {r.currentStepIndex + 1}</td>
                        <td className="text-xs">{r.nextActionAt ? formatRel(r.nextActionAt) : '—'}</td>
                        <td className="subtle text-xs">{r.enteredAt ? formatRel(r.enteredAt) : '—'}</td>
                      </tr>
                    ))
                  ) : (
                    <EmptyRow colSpan={4} label="No active runs." />
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card card-pad-0">
            <div className="card-head"><span className="card-title">Events</span><span className="card-sub">{events.length === 50 ? 'Last 50 · append-only' : `${events.length} total`}</span></div>
            <div style={{ padding: '4px 16px 12px' }}>
              {events.length === 0 ? (
                <div className="subtle text-xs" style={{ padding: 8 }}>No events recorded.</div>
              ) : (
                events.map((e: any, i: number) => (
                  <div key={String(e._id ?? i)} className="hstack" style={{ padding: '10px 0', borderBottom: i < events.length - 1 ? '1px solid var(--border)' : '' }}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--accent-soft)', color: 'var(--accent-press)', display: 'grid', placeItems: 'center' }}>
                      <Icons.Activity size={12} />
                    </div>
                    <div>
                      <div className="text-sm f500">{e.name}</div>
                      {e.properties && (
                        <div className="mono text-xs subtle">{JSON.stringify(e.properties).slice(0, 80)}</div>
                      )}
                    </div>
                    <span className="grow" />
                    <span className="text-xs subtle">{e.occurredAt ? formatRel(e.occurredAt) : ''}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card card-pad-0">
            <div className="card-head"><span className="card-title">Recent sends</span></div>
            <table className="table">
              <thead><tr><th>Template</th><th>Status</th><th>Opens</th><th>Clicks</th><th>When</th></tr></thead>
              <tbody>
                {sends.length === 0 ? (
                  <EmptyRow colSpan={5} label="No sends for this contact." />
                ) : (
                  sends.slice(0, 10).map((s: any, i: number) => (
                    <tr key={String(s._id ?? i)}>
                      <td className="mono text-xs">{s.templateSlug}</td>
                      <td><StatusPill status={s.status} /></td>
                      <td className="tabular">{s.openCount ?? 0}</td>
                      <td className="tabular">{s.clickCount ?? 0}</td>
                      <td className="text-xs subtle">{s.queuedAt ? formatRel(s.queuedAt) : ''}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="vstack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><span className="card-title">Subscription</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 8 }}>
              <div className="hstack">
                <span className="text-sm subtle">Status</span>
                <span className="grow" />
                {(() => {
                  const raw = sub.status ?? c?.status ?? null
                  if (!raw) return <span className="text-xs subtle">—</span>
                  return <StatusPill status={raw === 'pending_doi' ? 'queued' : raw} />
                })()}
              </div>
              <div className="hstack"><span className="text-sm subtle">Source</span><span className="grow" /><span className="mono text-xs">{sub.source ?? '—'}</span></div>
              <div className="hstack"><span className="text-sm subtle">Subscribed</span><span className="grow" /><span className="text-xs">{sub.subscribedAt ? formatRel(sub.subscribedAt) : '—'}</span></div>
              <div className="hstack"><span className="text-sm subtle">Email at subscribe</span><span className="grow" /><span className="mono text-xs">{sub.emailAtSubscribe ?? email}</span></div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Adapter fields</span><span className="card-sub">From host users.find</span></div>
            <div className="card-body">
              <pre className="code" style={{ margin: 0, padding: 12, fontSize: 11, overflow: 'auto', maxHeight: 320 }}>
{JSON.stringify({
  externalId,
  email,
  tags: c?.tags ?? [],
  timezone: c?.timezone,
  fields: c?.fields ?? {},
}, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function formatRel(d: any): string {
  const date = typeof d === 'string' ? new Date(d) : d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  if (diff < 0) {
    const future = -diff
    if (future < 60_000) return `in ${Math.floor(future / 1000)}s`
    if (future < 3_600_000) return `in ${Math.floor(future / 60_000)}m`
    if (future < 86_400_000) return `in ${Math.floor(future / 3_600_000)}h`
    return `in ${Math.floor(future / 86_400_000)}d`
  }
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}
