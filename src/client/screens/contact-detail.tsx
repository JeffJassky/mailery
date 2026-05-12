/* Contact detail */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { sample } from '../lib/mock'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'

export function ContactDetail({ id = 'u_2018f' }: any) {
  const fallbackContact = sample.contacts.find((x) => x.id === id) ?? sample.contacts[0]
  const fallbackSends = sample.sends.filter((s) => s.to === fallbackContact?.email)
    .concat(sample.sends.slice(0, 4))
  const fallbackEvents = [
    { name: 'Exported', time: '2 h ago', props: "{ format: 'pdf' }" },
    { name: 'Activated app', time: '2 d ago' },
    { name: 'Downloaded app', time: '3 d ago' },
    { name: 'Created', time: '3 d ago' },
  ]

  const { data } = useLive(() => api.contact(id), {
    contact: fallbackContact as any,
    subscription: { source: 'signup' } as any,
    recentEvents: fallbackEvents as any[],
    recentSends: fallbackSends as any[],
    activeRuns: [] as any[],
  })

  const c = (data as any).contact ?? fallbackContact
  const sub = (data as any).subscription ?? {}
  const events = ((data as any).recentEvents ?? fallbackEvents) as any[]
  const sends = ((data as any).recentSends ?? fallbackSends) as any[]
  const runs = ((data as any).activeRuns ?? []) as any[]

  const email = c?.email ?? ''
  const name = c?.name ?? (c?.fields?.firstName ? `${c.fields.firstName} ${c.fields.lastName ?? ''}`.trim() : email)
  const externalId = c?.externalId ?? id
  const tier = c?.tier ?? c?.fields?.tier ?? 'Free'

  return (
    <>
      <PageHead
        title={name}
        desc={<><span className="mono">{email}</span> · {tier} · <span className="mono">{externalId}</span></>}
        actions={
          <>
            <button className="btn"><Icons.Send size={14} />Resend last</button>
            <button className="btn"><Icons.Tag size={14} />Add tag</button>
            <button className="btn btn-danger"><Icons.Shield size={14} />Unsubscribe</button>
          </>
        }
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
                    <tr><td colSpan={4} className="subtle text-xs" style={{ padding: 16 }}>No active runs.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card card-pad-0">
            <div className="card-head"><span className="card-title">Events</span><span className="card-sub">Last 50 · append-only</span></div>
            <div style={{ padding: '4px 16px 12px' }}>
              {events.map((e: any, i: number) => (
                <div key={i} className="hstack" style={{ padding: '10px 0', borderBottom: i < events.length - 1 ? '1px solid var(--border)' : '' }}>
                  <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--accent-soft)', color: 'var(--accent-press)', display: 'grid', placeItems: 'center' }}>
                    <Icons.Activity size={12} />
                  </div>
                  <div>
                    <div className="text-sm f500">{e.name}</div>
                    {(e.props || e.properties) && (
                      <div className="mono text-xs subtle">
                        {typeof e.props === 'string' ? e.props : JSON.stringify(e.properties).slice(0, 80)}
                      </div>
                    )}
                  </div>
                  <span className="grow" />
                  <span className="text-xs subtle">{e.time ?? (e.occurredAt ? formatRel(e.occurredAt) : '')}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card card-pad-0">
            <div className="card-head"><span className="card-title">Recent sends</span></div>
            <table className="table">
              <thead><tr><th>Template</th><th>Status</th><th>Opens</th><th>Clicks</th><th>When</th></tr></thead>
              <tbody>
                {sends.slice(0, 6).map((s: any, i: number) => (
                  <tr key={i}>
                    <td className="mono text-xs">{s.template ?? s.templateSlug}</td>
                    <td><StatusPill status={s.status} /></td>
                    <td className="tabular">{s.opens ?? s.openCount ?? 0}</td>
                    <td className="tabular">{s.clicks ?? s.clickCount ?? 0}</td>
                    <td className="text-xs subtle">{s.time ?? (s.queuedAt ? formatRel(s.queuedAt) : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="vstack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><span className="card-title">Subscription</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 8 }}>
              <div className="hstack"><span className="text-sm subtle">Status</span><span className="grow" /><StatusPill status={(sub.status ?? c?.status ?? 'subscribed') === 'pending_doi' ? 'queued' : (sub.status ?? c?.status ?? 'subscribed')} /></div>
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

          <div className="card">
            <div className="card-head"><span className="card-title">Suppression check</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 8 }}>
              <div className="hstack"><Icons.Check size={14} style={{ color: 'var(--green-fg)' }} /><span className="text-sm">Not suppressed (marketing)</span></div>
              <div className="hstack"><Icons.Check size={14} style={{ color: 'var(--green-fg)' }} /><span className="text-sm">Not suppressed (transactional)</span></div>
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
