/* Dashboard — health, KPIs, recent activity, quick links */
import { Icons } from '../components/icons'
import { PageHead, StatusPill } from '../components/shell'
import { sample } from '../lib/mock'

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
          <div className="kpi-value">14,318</div>
          <div className="kpi-meta"><span className="kpi-delta up">▲ 8.4%</span><span>vs. prev 24h</span></div>
          <div style={{ position: 'absolute', right: -2, bottom: -2, width: 120, opacity: 0.7 }}>
            <Sparkline data={sample.sendSeries} />
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Delivered</div>
          <div className="kpi-value">99.42%</div>
          <div className="kpi-meta"><span className="kpi-delta up">▲ 0.12pp</span><span>83 bounced</span></div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Open rate</div>
          <div className="kpi-value">47.8%</div>
          <div className="kpi-meta"><span className="kpi-delta down">▼ 1.1pp</span><span>excl. bots</span></div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Click rate</div>
          <div className="kpi-value">11.2%</div>
          <div className="kpi-meta"><span className="kpi-delta up">▲ 0.6pp</span><span>vs. prev 24h</span></div>
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
            <div className="card-actions"><span className="pill green"><span className="dot"></span>Healthy</span></div>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gap: 12 }}>
              {[
                { label: 'Hard bounce / 1h', v: '0.31%', warn: '< 2%', cls: 'green' },
                { label: 'Complaint / 1h', v: '0.02%', warn: '< 0.3%', cls: 'green' },
                { label: 'Combined bounce', v: '1.18%', warn: '< 5%', cls: 'green' },
                { label: 'Failed-to-send', v: '0.04%', warn: '< 10%', cls: 'green' },
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
              <span className="mono">412</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-sm">Delayed (scheduled)</span>
              <span className="mono">9,184</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-sm">Provider · SendGrid</span>
              <span className="pill green" style={{ fontSize: 10.5 }}><span className="dot" /> 200 OK</span>
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
              {sample.flows.slice(0, 5).map((f) => (
                <tr key={f.slug} onClick={() => setRoute({ screen: 'flow-detail', slug: f.slug })}>
                  <td><div className="f500">{f.name}</div><div className="text-xs subtle mono">{f.slug}</div></td>
                  <td><span className="tag">{f.trigger}</span></td>
                  <td className="num tabular">{f.active}</td>
                  <td className="num tabular">{f.sends7d}</td>
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
              {sample.sends.slice(0, 6).map((s) => (
                <tr key={s.id} onClick={() => setRoute({ screen: 'send-detail', id: s.id })}>
                  <td className="mono">{s.template}</td>
                  <td className="text-xs">{s.to}</td>
                  <td><StatusPill status={s.status} /></td>
                  <td className="text-xs subtle">{s.time}</td>
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
            {sample.audit.slice(0, 5).map((e, i) => (
              <tr key={i}>
                <td className="text-xs mono">{e.actor}</td>
                <td><span className="tag">{e.action}</span></td>
                <td className="mono text-xs">{e.target}</td>
                <td className="text-xs subtle">{e.note}</td>
                <td className="text-xs subtle">{e.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export { AreaChart }
