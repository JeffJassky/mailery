/* Dashboard — health, KPIs, recent activity, quick links */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { sample } from '../lib/mock'
import { api, type DashboardPayload } from '../lib/api'
import { useLive } from '../lib/use-live'

const FALLBACK_DASHBOARD: DashboardPayload = {
  kpis: {
    sends: { value: 14318, delta: 0.084 },
    deliveredRate: { value: 0.9942, delta: 0.0012, bounced: 83 },
    openRate: { value: 0.478, delta: -0.011, exclBots: true },
    clickRate: { value: 0.112, delta: 0.006 },
  },
  health: { status: 'healthy', rates: { hardBounceRate: 0.0031, complaintRate: 0.0002, combinedBounceRate: 0.0118, failureRate: 0.0004 } },
  queue: { inFlight: 412, delayed: 9184, providerOk: true, providerName: 'sendgrid' },
  recentFlows: sample.flows.slice(0, 5),
  recentSends: sample.sends.slice(0, 6),
  recentAudit: sample.audit.slice(0, 5),
}

export function Sparkline({ data, color = 'var(--accent)', height = 36 }: any) {
  const w = 200, h = height
  const max = Math.max(...data), min = Math.min(...data)
  const range = max - min || 1
  const pts = data.map((v: number, i: number) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 4) - 2}`).join(' ')
  const area = `0,${h} ${pts} ${w},${h}`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="spark" style={{ height }}>
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#sg)" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  )
}

function AreaChart({ a, b, height = 200 }: any) {
  const w = 720, h = height
  const max = Math.max(...a, ...b)
  const x = (i: number) => (i / (a.length - 1)) * (w - 32) + 24
  const y = (v: number) => h - 28 - (v / max) * (h - 52)
  const lineA = a.map((v: number, i: number) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ')
  const lineB = b.map((v: number, i: number) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ')
  const areaA = `M${x(0)},${h - 28} ${a.map((v: number, i: number) => `L${x(i)},${y(v)}`).join(' ')} L${x(a.length - 1)},${h - 28} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height }} className="chart-axis">
      <g className="chart-grid">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => <line key={t} x1="24" x2={w - 8} y1={28 + (h - 56) * t} y2={28 + (h - 56) * t} />)}
      </g>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => <text key={t} x="6" y={28 + (h - 56) * t + 3}>{Math.round(max * (1 - t))}</text>)}
      {['00', '04', '08', '12', '16', '20', '24'].map((t, i) => <text key={t} x={24 + (i / 6) * (w - 32)} y={h - 10} textAnchor="middle">{t}</text>)}
      <defs>
        <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaA} fill="url(#ag)" />
      <path d={lineA} fill="none" stroke="var(--accent)" strokeWidth="1.75" />
      <path d={lineB} fill="none" stroke="var(--blue)" strokeWidth="1.75" strokeDasharray="3 3" />
    </svg>
  )
}

export function Dashboard({ setRoute }: any) {
  const { data } = useLive(() => api.dashboard(), FALLBACK_DASHBOARD)
  const kpis = data.kpis
  const queue = data.queue
  const recentFlows = data.recentFlows ?? FALLBACK_DASHBOARD.recentFlows
  const recentSends = data.recentSends ?? FALLBACK_DASHBOARD.recentSends
  const recentAudit = data.recentAudit ?? FALLBACK_DASHBOARD.recentAudit
  const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`
  const fmtDelta = (delta: number | null, unit: 'pct' | 'pp' = 'pct') => {
    if (delta == null) return null
    const sign = delta >= 0 ? '▲' : '▼'
    const abs = Math.abs(delta)
    const val = unit === 'pp' ? `${(abs * 100).toFixed(2)}pp` : `${(abs * 100).toFixed(1)}%`
    return <span className={'kpi-delta ' + (delta >= 0 ? 'up' : 'down')}>{sign} {val}</span>
  }

  return (
    <>
      <PageHead
        title="Dashboard"
        desc="Last 24 hours · production · all providers"
        actions={
          <>
            <button className="btn"><Icons.Calendar size={14} />Last 24h</button>
            <button className="btn-primary btn"><Icons.Plus size={14} />New broadcast</button>
          </>
        }
      />

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Sends</div>
          <div className="kpi-value">{kpis.sends.value.toLocaleString()}</div>
          <div className="kpi-meta">{fmtDelta(kpis.sends.delta)}<span>vs. prev 24h</span></div>
          <div style={{ position: 'absolute', right: -2, bottom: -2, width: 120, opacity: 0.7 }}>
            <Sparkline data={sample.sendSeries} />
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Delivered</div>
          <div className="kpi-value">{fmtPct(kpis.deliveredRate.value)}</div>
          <div className="kpi-meta">{fmtDelta(kpis.deliveredRate.delta, 'pp')}<span>{kpis.deliveredRate.bounced} bounced</span></div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Open rate</div>
          <div className="kpi-value">{fmtPct(kpis.openRate.value)}</div>
          <div className="kpi-meta">{fmtDelta(kpis.openRate.delta, 'pp')}<span>{kpis.openRate.exclBots ? 'excl. bots' : 'raw'}</span></div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Click rate</div>
          <div className="kpi-value">{fmtPct(kpis.clickRate.value)}</div>
          <div className="kpi-meta">{fmtDelta(kpis.clickRate.delta, 'pp')}<span>vs. prev 24h</span></div>
        </div>
      </div>

      <div className="split split-asym" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Send & open activity</span>
            <span className="card-sub">UTC</span>
            <div className="card-actions">
              <div className="seg">
                <span className="seg-item">All</span>
                <span className="seg-item active">Marketing</span>
                <span className="seg-item">Transactional</span>
              </div>
              <button className="btn btn-sm"><Icons.Download size={12} />Export</button>
            </div>
          </div>
          <div className="card-body">
            <div className="hstack" style={{ marginBottom: 8 }}>
              <span className="hstack text-xs"><span className="status-dot" style={{ background: 'var(--accent)' }}></span>Sends</span>
              <span className="hstack text-xs"><span className="status-dot" style={{ background: 'var(--blue)', boxShadow: 'none' }}></span>Opens</span>
              <span className="grow" />
              <span className="text-xs subtle">Hover for hourly breakdown</span>
            </div>
            <AreaChart a={sample.sendSeries} b={sample.openSeries} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Health</span>
            <div className="card-actions"><span className={'pill ' + (data.health.status === 'healthy' ? 'green' : data.health.status === 'tripped' ? 'red' : 'amber')}><span className="dot"></span>{data.health.status}</span></div>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gap: 12 }}>
              {[
                { label: 'Hard bounce / 1h', v: fmtPct(data.health.rates.hardBounceRate ?? 0), warn: '< 2%', cls: 'green' },
                { label: 'Complaint / 1h', v: fmtPct(data.health.rates.complaintRate ?? 0), warn: '< 0.3%', cls: 'green' },
                { label: 'Combined bounce', v: fmtPct((data.health.rates as any).combinedBounceRate ?? data.health.rates.bounceRate ?? 0), warn: '< 5%', cls: 'green' },
                { label: 'Failed-to-send', v: fmtPct(data.health.rates.failureRate ?? 0), warn: '< 10%', cls: 'green' },
              ].map((r) => (
                <div key={r.label} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span className="text-xs subtle">{r.label}</span>
                  <span className="grow" />
                  <span className="f600 tabular">{r.v}</span>
                  <span className={'pill ' + r.cls} style={{ fontSize: 10.5 }}>{r.warn}</span>
                </div>
              ))}
            </div>
            <div className="divider" />
            <div className="text-xs subtle" style={{ marginBottom: 6 }}>Queue</div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-sm">BullMQ jobs in flight</span>
              <span className="mono">{queue.inFlight.toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-sm">Delayed (scheduled)</span>
              <span className="mono">{queue.delayed.toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-sm">Provider · {queue.providerName}</span>
              <span className={'pill ' + (queue.providerOk ? 'green' : 'red')} style={{ fontSize: 10.5 }}><span className="dot" /> {queue.providerOk ? '200 OK' : 'down'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="split split-2" style={{ marginBottom: 16 }}>
        <div className="card card-pad-0">
          <div className="card-head">
            <span className="card-title">Active flows</span>
            <div className="card-actions">
              <button className="btn btn-sm btn-ghost" onClick={() => setRoute({ screen: 'flows' })}>View all<Icons.Chevron size={12} /></button>
            </div>
          </div>
          <table className="table">
            <thead><tr><th>Flow</th><th>Trigger</th><th className="num">Active</th><th className="num">Sends 7d</th></tr></thead>
            <tbody>
              {recentFlows.slice(0, 5).map((f: any) => (
                <tr key={f.slug} onClick={() => setRoute({ screen: 'flow-detail', slug: f.slug })}>
                  <td><div className="f500">{f.name}</div><div className="text-xs subtle mono">{f.slug}</div></td>
                  <td><span className="tag">{typeof f.trigger === 'string' ? f.trigger : (f.trigger?.eventName ?? f.trigger?.type ?? '—')}</span></td>
                  <td className="num tabular">{f.active ?? f.stats?.activeRuns ?? 0}</td>
                  <td className="num tabular">{f.sends7d ?? f.stats?.sendsLast7Days ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card card-pad-0">
          <div className="card-head">
            <span className="card-title">Recent sends</span>
            <div className="card-actions">
              <button className="btn btn-sm btn-ghost" onClick={() => setRoute({ screen: 'sends' })}>View all<Icons.Chevron size={12} /></button>
            </div>
          </div>
          <table className="table">
            <thead><tr><th>Template</th><th>To</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {recentSends.slice(0, 6).map((s: any) => (
                <tr key={s.id ?? s._id} onClick={() => setRoute({ screen: 'send-detail', id: String(s.id ?? s._id) })}>
                  <td className="mono">{s.template ?? s.templateSlug}</td>
                  <td className="text-xs">{s.to ?? s.emailAtSend}</td>
                  <td><StatusPill status={s.status} /></td>
                  <td className="text-xs subtle">{s.time ?? (s.queuedAt ? new Date(s.queuedAt).toLocaleTimeString() : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad-0">
        <div className="card-head">
          <span className="card-title">Recent audit log</span>
          <div className="card-actions">
            <button className="btn btn-sm btn-ghost" onClick={() => setRoute({ screen: 'audit' })}>View all<Icons.Chevron size={12} /></button>
          </div>
        </div>
        <table className="table">
          <thead><tr><th>Actor</th><th>Action</th><th>Resource</th><th>Detail</th><th>When</th></tr></thead>
          <tbody>
            {recentAudit.slice(0, 5).map((e: any, i: number) => (
              <tr key={i}>
                <td className="text-xs mono">{e.actor}</td>
                <td><span className="tag">{e.action}</span></td>
                <td className="mono text-xs">{formatResource(e.resource ?? e.target)}</td>
                <td className="text-xs subtle">{e.note ?? e.diffSummary ?? ''}</td>
                <td className="text-xs subtle">{e.time ?? (e.occurredAt ? new Date(e.occurredAt).toLocaleString() : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function formatResource(r: any): string {
  if (!r) return ''
  if (typeof r === 'string') return r
  if (r.slug) return `${(r.collection ?? '').replace('mailer_', '')}/${r.slug}`
  if (r.id) return `${(r.collection ?? '').replace('mailer_', '')}/${String(r.id).slice(-8)}`
  return r.collection ?? ''
}

export { AreaChart }
