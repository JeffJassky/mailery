/* Health */
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { sample } from '../lib/mock'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { AreaChart } from './dashboard'

const HEALTH_FALLBACK = {
  status: 'healthy' as const,
  rates: { hardBounceRate: 0.0031, complaintRate: 0.0002, combinedBounceRate: 0.0118, failureRate: 0.0004 },
}

export function Health(_: any) {
  const { data: health } = useLive(() => api.health(), HEALTH_FALLBACK)

  const rates = (health as any).rates ?? {}
  const fmt = (n: number) => `${(n * 100).toFixed(2)}%`

  return (
    <>
      <PageHead
        title="Health"
        desc="Circuit breaker · rolling window · provider status."
        actions={
          <>
            <span className={'pill ' + statusClass((health as any).status)}><span className="dot" />{(health as any).status ?? 'healthy'}</span>
            <button className="btn"><Icons.Pause size={14} />Pause all sends</button>
          </>
        }
      />

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Hard bounce / 1h</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>{fmt(rates.hardBounceRate ?? 0)}</div><div className="kpi-meta subtle">Trip @ 2.00%</div></div>
        <div className="kpi"><div className="kpi-label">Complaint / 1h</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>{fmt(rates.complaintRate ?? 0)}</div><div className="kpi-meta subtle">Trip @ 0.30%</div></div>
        <div className="kpi"><div className="kpi-label">Combined bounce</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>{fmt(rates.combinedBounceRate ?? rates.bounceRate ?? 0)}</div><div className="kpi-meta subtle">Trip @ 5.00%</div></div>
        <div className="kpi"><div className="kpi-label">Failed-to-send</div><div className="kpi-value" style={{ color: 'var(--green-fg)' }}>{fmt(rates.failureRate ?? 0)}</div><div className="kpi-meta subtle">Degrade @ 10.00%</div></div>
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
            <span className="text-xs subtle">Recovery sweep · every 60s</span>
          </div>
        </div>
      </div>
    </>
  )
}

function statusClass(s: string | undefined): string {
  if (s === 'tripped') return 'red'
  if (s === 'degraded') return 'amber'
  return 'green'
}
