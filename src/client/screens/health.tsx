/* Health */
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { sample } from '../lib/mock'
import { AreaChart } from './dashboard'

export function Health(_: any) {
  return (
    <>
      <PageHead
        title="Health"
        desc="Circuit breaker · rolling window · provider status."
        actions={<><span className="pill green"><span className="dot" />Healthy</span><button className="btn"><Icons.Pause size={14} />Pause all sends</button></>}
      />

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Hard bounce / 1h</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>0.31%</div><div className="kpi-meta subtle">Trip @ 2.00%</div></div>
        <div className="kpi"><div className="kpi-label">Complaint / 1h</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>0.02%</div><div className="kpi-meta subtle">Trip @ 0.30%</div></div>
        <div className="kpi"><div className="kpi-label">Combined bounce</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>1.18%</div><div className="kpi-meta subtle">Trip @ 5.00%</div></div>
        <div className="kpi"><div className="kpi-label">Failed-to-send</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>0.04%</div><div className="kpi-meta subtle">Degrade @ 10.00%</div></div>
      </div>

      <div className="split split-asym" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head"><span className="card-title">Recent trips</span><span className="card-sub">Last 30 days</span></div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>When</th><th>Reason</th><th>Window value</th><th>Resumed</th></tr></thead>
              <tbody>
                <tr><td className="text-xs">May 11 · 06:12</td><td><span className="pill red"><span className="dot" />Hard bounce</span></td><td className="mono">2.4% / 1h</td><td className="text-xs">06:48 · jeff@</td></tr>
                <tr><td className="text-xs">Apr 28 · 22:04</td><td><span className="pill red"><span className="dot" />Combined bounce</span></td><td className="mono">5.7% / 1h</td><td className="text-xs">22:31 · jeff@</td></tr>
                <tr><td className="text-xs">Apr 14 · 11:21</td><td><span className="pill amber"><span className="dot" />Failed-to-send</span></td><td className="mono">12.8% / 1h</td><td className="text-xs">11:24 · auto</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">Providers</span></div>
          <div className="card-body" style={{ display: 'grid', gap: 10 }}>
            {([
              ['SendGrid', 'marketing', 'green', '200 OK', '58ms'],
              ['Postmark', 'transactional', 'green', '200 OK', '42ms'],
              ['AWS SES', 'disabled', 'gray', '—', '—'],
            ] as [string, string, string, string, string][]).map(([n, role, c, s, lat]) => (
              <div key={n} className="hstack" style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
                <div style={{ width: 30, height: 30, borderRadius: 7, background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center' }}>
                  <Icons.Mail size={14} />
                </div>
                <div>
                  <div className="f500 text-sm">{n}</div>
                  <div className="text-xs subtle">{role}</div>
                </div>
                <span className="grow" />
                <span className={'pill ' + c}><span className="dot" />{s}</span>
                <span className="text-xs subtle mono" style={{ width: 48, textAlign: 'right' }}>{lat}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><span className="card-title">Queue depth</span><span className="card-sub">BullMQ · last 24h</span></div>
        <div className="card-body">
          <AreaChart a={sample.sendSeries} b={sample.openSeries.map((v) => v * 0.3)} height={180} />
          <div className="hstack" style={{ marginTop: 6 }}>
            <span className="text-xs hstack"><span className="status-dot" style={{ background: 'var(--accent)' }} />In-flight</span>
            <span className="text-xs hstack"><span className="status-dot" style={{ background: 'var(--blue)', boxShadow: 'none' }} />Delayed</span>
            <span className="grow" />
            <span className="text-xs subtle">Recovery sweep · every 60s · last 12s ago</span>
          </div>
        </div>
      </div>
    </>
  )
}
