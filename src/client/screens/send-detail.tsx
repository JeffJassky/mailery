/* Send detail */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState } from '../lib/load-state'

export function SendDetail({ id }: any) {
  const { data, loading, error, refetch } = useLive(() => api.send(id))

  return (
    <LoadState loading={loading && !data} error={error} empty={!data} emptyLabel="Send not found." retry={refetch}>
      {data && <Body data={data} />}
    </LoadState>
  )
}

function Body({ data }: { data: any }) {
  const s = data.send ?? {}
  const webhookEvents = data.webhookEvents ?? []
  const timeline = buildTimeline(s)

  return (
    <>
      <PageHead
        title={<span className="mono">{String(s._id)}</span>}
        desc={<>Sent to <span className="mono">{s.emailAtSend ?? '—'}</span></>}
        actions={
          <>
            <button className="btn"><Icons.Eye size={14} />View as HTML</button>
            <button className="btn"><Icons.Send size={14} />Resend</button>
          </>
        }
      />

      <div className="split split-asym">
        <div className="vstack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><span className="card-title">Status timeline</span><div className="card-actions"><StatusPill status={s.status ?? 'queued'} /></div></div>
            <div className="card-body">
              {timeline.length === 0 ? (
                <div className="text-xs subtle" style={{ padding: 8 }}>No timeline events yet.</div>
              ) : (
                <div style={{ position: 'relative', paddingLeft: 24 }}>
                  <div style={{ position: 'absolute', left: 7, top: 6, bottom: 6, width: 2, background: 'var(--border)' }} />
                  {timeline.map((e, i) => (
                    <div key={i} style={{ position: 'relative', paddingBottom: 14 }}>
                      <div style={{
                        position: 'absolute', left: -21, top: 4, width: 12, height: 12, borderRadius: '50%',
                        background: i === timeline.length - 1 ? 'var(--accent)' : 'var(--bg-elev)',
                        border: '2px solid ' + (i === timeline.length - 1 ? 'var(--accent)' : 'var(--border-strong)'),
                      }} />
                      <div className="hstack"><span className="text-sm f500" style={{ textTransform: 'capitalize' }}>{e.t}</span><span className="grow" /><span className="text-xs subtle mono">{e.at}</span></div>
                      <div className="text-xs subtle">{e.desc}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="vstack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><span className="card-title">Metadata</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 8, fontSize: 13 }}>
              {([
                ['Template', <span className="mono">{s.templateSlug ?? '—'}</span>],
                ['Kind', <span className="pill neutral">{s.kind ?? '—'}</span>],
                ['Provider', <span className="mono">{s.provider ?? '—'}</span>],
                ['Provider message ID', <span className="mono text-xs">{s.providerMessageId ?? '—'}</span>],
                ['Flow run', s.flowRunId ? <span className="mono text-xs">{String(s.flowRunId).slice(-8)}</span> : '—'],
                ['From', <span className="mono text-xs">{s.fromEmail ?? '—'}</span>],
                ['Subject', s.subjectAtSend ?? s.subject ?? '—'],
                ['Body hash', <span className="mono text-xs">{s.bodyHash ? `sha256:${String(s.bodyHash).slice(0, 8)}…` : '—'}</span>],
                ['dedupeKey', <span className="mono text-xs">{s.dedupeKey ?? '—'}</span>],
              ] as [string, any][]).map(([k, v]) => (
                <div key={k} className="hstack" style={{ alignItems: 'baseline' }}>
                  <span className="subtle" style={{ width: 140, flex: '0 0 auto' }}>{k}</span>
                  <span style={{ textAlign: 'right', flex: 1 }}>{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Webhook events</span><span className="card-sub">{webhookEvents.length} received</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 8 }}>
              {webhookEvents.length > 0 ? (
                webhookEvents.map((w: any, i: number) => (
                  <div key={String(w._id ?? i)} className="hstack">
                    <StatusPill status={w.normalizedType ?? w.type ?? 'delivered'} />
                    <span className="grow" />
                    <span className="text-xs subtle mono">{w.occurredAt ? new Date(w.occurredAt).toLocaleTimeString() : ''}</span>
                    <span className="text-xs subtle mono">{w.providerEventId ?? ''}</span>
                  </div>
                ))
              ) : (
                <div className="text-xs subtle">No webhook events yet.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function buildTimeline(s: any): Array<{ at: string; t: string; desc: string }> {
  const fmt = (d: any) => d ? new Date(d).toLocaleTimeString() : ''
  const out: Array<{ at: string; t: string; desc: string }> = []
  if (s.queuedAt) out.push({ at: fmt(s.queuedAt), t: 'queued', desc: 'Enqueued for dispatch' })
  if (s.sentAt) out.push({ at: fmt(s.sentAt), t: 'sent', desc: `Provider ${s.provider ?? ''}` })
  if (s.deliveredAt) out.push({ at: fmt(s.deliveredAt), t: 'delivered', desc: 'Webhook · delivered' })
  if (s.openedAt) out.push({ at: fmt(s.openedAt), t: 'opened', desc: `Open${(s.openCount ?? 0) > 1 ? ` (×${s.openCount})` : ''}` })
  if (s.firstClickAt) out.push({ at: fmt(s.firstClickAt), t: 'clicked', desc: `Click${(s.clickCount ?? 0) > 1 ? ` (×${s.clickCount})` : ''}` })
  return out
}
