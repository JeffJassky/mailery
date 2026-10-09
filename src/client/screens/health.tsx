/* Health */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api, type DnsblCheck, type HealthBucket } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Health({ setRoute }: any) {
  const { data: health, loading, error, refetch } = useLive(() => api.health())
  const { data: trips, refetch: refetchTrips } = useLive(() => api.healthTrips())
  const { data: me } = useLive(() => api.me())
  const { data: dnsbl, refetch: refetchDnsbl } = useLive(() => api.dnsbl())
  const { data: postmaster, refetch: refetchPostmaster } = useLive(() => api.postmaster())
  const { data: snds, refetch: refetchSnds } = useLive(() => api.snds())
  const { data: dmarc } = useLive(() => api.dmarc())
  const { data: dmarcMon } = useLive(() => api.dmarcMonitoring())
  const [rechecking, setRechecking] = React.useState(false)
  const [recheckError, setRecheckError] = React.useState<string | null>(null)
  const [pmRefreshing, setPmRefreshing] = React.useState(false)
  const [pmError, setPmError] = React.useState<string | null>(null)
  const [sndsRefreshing, setSndsRefreshing] = React.useState(false)
  const [sndsError, setSndsError] = React.useState<string | null>(null)

  async function recheckDnsbl() {
    setRechecking(true)
    setRecheckError(null)
    try {
      await api.recheckDnsbl()
      refetchDnsbl()
    } catch (err: any) {
      setRecheckError(String(err?.message ?? err))
    } finally {
      setRechecking(false)
    }
  }

  async function refreshPostmaster() {
    setPmRefreshing(true)
    setPmError(null)
    try {
      await api.refreshPostmaster()
      refetchPostmaster()
    } catch (err: any) {
      setPmError(String(err?.message ?? err))
    } finally {
      setPmRefreshing(false)
    }
  }

  async function refreshSnds() {
    setSndsRefreshing(true)
    setSndsError(null)
    try {
      await api.refreshSnds()
      refetchSnds()
    } catch (err: any) {
      setSndsError(String(err?.message ?? err))
    } finally {
      setSndsRefreshing(false)
    }
  }

  const [resuming, setResuming] = React.useState<string | null>(null)
  const [resumeError, setResumeError] = React.useState<string | null>(null)

  async function resumeAll() {
    setResuming('all')
    setResumeError(null)
    try {
      await api.resumeHealth()
      refetch()
      refetchTrips()
    } catch (err: any) {
      setResumeError(String(err?.message ?? err))
    } finally {
      setResuming(null)
    }
  }

  async function resumeBucket(b: HealthBucket) {
    if (!b.senderDomain || !b.kind) return
    setResuming(b._id)
    setResumeError(null)
    try {
      await api.resumeHealth({ senderDomain: b.senderDomain, kind: b.kind })
      refetch()
      refetchTrips()
    } catch (err: any) {
      setResumeError(String(err?.message ?? err))
    } finally {
      setResuming(null)
    }
  }

  const rates = health?.rates ?? ({} as Partial<HealthBucket['rates']>)
  const thresholds = health?.thresholds ?? {}
  const buckets = health?.buckets ?? []
  const status = health?.status ?? null

  // Null = nothing sent in the window yet, so there is no rate to show.
  const fmt = (n: number | null | undefined) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`)

  // Colorize a rate by its trip threshold:
  //  ≥ trip → red, ≥ 50% of trip → amber, else green, no rate → muted.
  function rateColor(rate: number | null | undefined, tripPct: number | undefined): string {
    if (rate == null || tripPct == null) return 'var(--fg-muted)'
    const ratePct = rate * 100
    if (ratePct >= tripPct) return 'var(--red-fg)'
    if (ratePct >= tripPct / 2) return 'var(--amber-fg)'
    return 'var(--green-fg)'
  }
  const fmtTrip = (pct: number | undefined, label: string) => (pct == null ? '' : `${label} @ ${pct.toFixed(2)}%`)

  return (
    <>
      <PageHead
        title="Health"
        desc="Circuit breaker · rolling window · per-(domain × kind) buckets."
        actions={
          <>
            <span className={'pill ' + statusClass(status)}><span className="dot" />{status ?? (health ? 'no telemetry' : '…')}</span>
            {status && status !== 'healthy' && (
              <button className="btn btn-primary" disabled={resuming === 'all'} onClick={resumeAll}>
                <Icons.Play size={14} />{resuming === 'all' ? 'Resuming…' : 'Resume all'}
              </button>
            )}
            {resumeError && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{resumeError}</span>}
          </>
        }
      />

      <LoadState loading={loading && !health} error={error} empty={false} retry={refetch}>
        <div className="kpis">
          <div className="kpi">
            <div className="kpi-label">Hard bounce / 1h (overall)</div>
            <div className="kpi-value" style={{ color: rateColor(rates.hardBounceRate, thresholds.hardBounceRatePctTrip) }}>{fmt(rates.hardBounceRate)}</div>
            <div className="kpi-meta subtle">{fmtTrip(thresholds.hardBounceRatePctTrip, 'Trip')}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Complaint / 1h (overall)</div>
            <div className="kpi-value" style={{ color: rateColor(rates.complaintRate, thresholds.complaintRatePctTrip) }}>{fmt(rates.complaintRate)}</div>
            <div className="kpi-meta subtle">{fmtTrip(thresholds.complaintRatePctTrip, 'Trip')}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Combined bounce (overall)</div>
            <div className="kpi-value" style={{ color: rateColor(rates.bounceRate, thresholds.combinedBounceRatePctTrip) }}>{fmt(rates.bounceRate)}</div>
            <div className="kpi-meta subtle">{fmtTrip(thresholds.combinedBounceRatePctTrip, 'Trip')}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Failed-to-send (overall)</div>
            <div className="kpi-value" style={{ color: rateColor(rates.failureRate, thresholds.failedToSendRatePctDegrade) }}>{fmt(rates.failureRate)}</div>
            <div className="kpi-meta subtle">{fmtTrip(thresholds.failedToSendRatePctDegrade, 'Degrade')}</div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span className="card-title">Per-(sender domain × kind)</span>
            <span className="card-sub">Trips happen per bucket — one subdomain tanking doesn't hold mail for the others.</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Sender domain</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th className="text-right">Hard bounce</th>
                  <th className="text-right">Complaint</th>
                  <th className="text-right">Combined</th>
                  <th className="text-right">Failure</th>
                  <th className="text-right">Sent / 1h</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {buckets.length === 0 ? (
                  <EmptyRow colSpan={9} label="No buckets yet. Buckets are created the first time a counter is recorded for a (domain, kind) pair." />
                ) : (
                  buckets.map((b) => (
                    <tr key={b._id}>
                      <td className="mono text-xs">{b.senderDomain ?? '_unknown'}</td>
                      <td>{b.kind ?? '—'}</td>
                      <td>
                        <span className={'pill ' + statusClass(b.status)}><span className="dot" />{b.status}</span>
                      </td>
                      <td className="text-right" style={{ color: rateColor(b.rates.hardBounceRate, thresholds.hardBounceRatePctTrip) }}>{fmt(b.rates.hardBounceRate)}</td>
                      <td className="text-right" style={{ color: rateColor(b.rates.complaintRate, thresholds.complaintRatePctTrip) }}>{fmt(b.rates.complaintRate)}</td>
                      <td className="text-right" style={{ color: rateColor(b.rates.bounceRate, thresholds.combinedBounceRatePctTrip) }}>{fmt(b.rates.bounceRate)}</td>
                      <td className="text-right" style={{ color: rateColor(b.rates.failureRate, thresholds.failedToSendRatePctDegrade) }}>{fmt(b.rates.failureRate)}</td>
                      <td className="text-right mono text-xs">{b.counters.sent}</td>
                      <td className="text-right">
                        {b.status === 'tripped' && (
                          <button
                            className="btn btn-xs"
                            disabled={resuming === b._id}
                            onClick={() => resumeBucket(b)}
                            title={b.trippedReason ?? undefined}
                          >
                            {resuming === b._id ? 'Resuming…' : 'Resume'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span className="card-title">DNS block lists</span>
            <span className="card-sub">
              {dnsbl?.latestRunAt
                ? `Last run ${new Date(dnsbl.latestRunAt).toLocaleString()} · every ${dnsbl.intervalHours}h`
                : 'No checks run yet'}
            </span>
            <div className="card-actions">
              <button className="btn btn-xs" disabled={rechecking} onClick={recheckDnsbl}>
                {rechecking ? 'Rechecking…' : 'Recheck now'}
              </button>
              {recheckError && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{recheckError}</span>}
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Type</th>
                  <th>List</th>
                  <th>Status</th>
                  <th>Detail</th>
                  <th className="text-right">Checked</th>
                </tr>
              </thead>
              <tbody>
                {!dnsbl ? (
                  <EmptyRow colSpan={6} label="Loading…" />
                ) : dnsbl.checks.length === 0 ? (
                  <EmptyRow colSpan={6} label="No DNSBL checks yet. Press 'Recheck now' to run the first scan." />
                ) : (
                  dnsbl.checks.map((d: DnsblCheck, i: number) => (
                    <tr key={String(d._id ?? `${d.target}|${d.list}|${i}`)}>
                      <td className="mono text-xs">{d.target}</td>
                      <td>{d.targetKind}</td>
                      <td className="text-xs">{d.listLabel}</td>
                      <td>
                        <span className={'pill ' + dnsblResultClass(d.result)}>
                          <span className="dot" />{d.result}
                        </span>
                      </td>
                      <td className="text-xs mono">
                        {d.result === 'listed'
                          ? d.returnCodes.join(', ')
                          : d.result === 'error'
                          ? d.errorMessage ?? '—'
                          : '—'}
                      </td>
                      <td className="text-right text-xs">{new Date(d.runAt).toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span className="card-title">Google Postmaster Tools</span>
            <span className="card-sub">
              {postmaster
                ? postmaster.configured
                  ? `Pulled every ${postmaster.intervalHours}h · ${postmaster.domains.length} domain(s)`
                  : 'Not configured — set MailerConfig.postmaster to enable'
                : 'Loading…'}
            </span>
            {postmaster?.configured && (
              <div className="card-actions">
                <button className="btn btn-xs" disabled={pmRefreshing} onClick={refreshPostmaster}>
                  {pmRefreshing ? 'Refreshing…' : 'Refresh now'}
                </button>
                {pmError && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{pmError}</span>}
              </div>
            )}
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Reputation</th>
                  <th className="text-right">User spam %</th>
                  <th className="text-right">SPF pass</th>
                  <th className="text-right">DKIM pass</th>
                  <th className="text-right">DMARC pass</th>
                  <th className="text-right">As of</th>
                </tr>
              </thead>
              <tbody>
                {!postmaster ? (
                  <EmptyRow colSpan={7} label="Loading…" />
                ) : !postmaster.configured ? (
                  <EmptyRow colSpan={7} label="Configure MailerConfig.postmaster (OAuth client + refresh token) to start pulling Gmail reputation data." />
                ) : postmaster.domains.length === 0 ? (
                  <EmptyRow colSpan={7} label="No snapshots yet. Press 'Refresh now' or wait for the first scheduled pull." />
                ) : (
                  postmaster.domains.map((d) => {
                    const s = d.latest
                    return (
                      <tr key={d.domain}>
                        <td className="mono text-xs">{d.domain}</td>
                        <td>
                          <span className={'pill ' + reputationClass(s?.domainReputation)}>
                            <span className="dot" />{s?.domainReputation ?? '—'}
                          </span>
                        </td>
                        <td className="text-right text-xs">{pct(s?.userReportedSpamRatio)}</td>
                        <td className="text-right text-xs">{pct(s?.spfSuccessRatio)}</td>
                        <td className="text-right text-xs">{pct(s?.dkimSuccessRatio)}</td>
                        <td className="text-right text-xs">{pct(s?.dmarcSuccessRatio)}</td>
                        <td className="text-right text-xs">{s?.date ?? '—'}</td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span className="card-title">Microsoft SNDS</span>
            <span className="card-sub">
              {snds
                ? snds.configured
                  ? `Pulled every ${snds.intervalHours}h · ${snds.ips.length} IP(s)`
                  : 'Not configured — only useful for dedicated IPs'
                : 'Loading…'}
            </span>
            {snds?.configured && (
              <div className="card-actions">
                <button className="btn btn-xs" disabled={sndsRefreshing} onClick={refreshSnds}>
                  {sndsRefreshing ? 'Refreshing…' : 'Refresh now'}
                </button>
                {sndsError && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{sndsError}</span>}
              </div>
            )}
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>IP</th>
                  <th>Filter</th>
                  <th className="text-right">Complaint rate</th>
                  <th className="text-right">Trap msgs</th>
                  <th className="text-right">Recipients</th>
                  <th className="text-right">Activity window</th>
                </tr>
              </thead>
              <tbody>
                {!snds ? (
                  <EmptyRow colSpan={6} label="Loading…" />
                ) : !snds.configured ? (
                  <EmptyRow colSpan={6} label="Set MailerConfig.snds.accessKey to enable. Only useful when sending from a dedicated IP." />
                ) : snds.ips.length === 0 ? (
                  <EmptyRow colSpan={6} label="No snapshots yet. Press 'Refresh now' to fetch, or wait for the next scheduled pull." />
                ) : (
                  snds.ips.map((row) => {
                    const s = row.latest
                    return (
                      <tr key={row.ip}>
                        <td className="mono text-xs">{row.ip}</td>
                        <td>
                          <span className={'pill ' + sndsFilterClass(s?.filterResult)}>
                            <span className="dot" />{s?.filterResult ?? '—'}
                          </span>
                        </td>
                        <td className="text-right text-xs">{pct(s?.complaintRate)}</td>
                        <td className="text-right text-xs">{s?.trapMessageCount ?? 0}</td>
                        <td className="text-right text-xs">{s?.messageRecipients ?? 0}</td>
                        <td className="text-right text-xs">
                          {s
                            ? `${new Date(s.activityStart).toLocaleDateString()} – ${new Date(s.activityEnd).toLocaleDateString()}`
                            : '—'}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span className="card-title">DMARC RUA reports</span>
            <span className="card-sub">Pass rate per domain and open alerts. Setup, alerts and sources live on their own screen.</span>
            <div className="card-actions">
              <button className="btn btn-xs" onClick={() => setRoute({ screen: 'dmarc' })}>Open DMARC Monitoring</button>
            </div>
          </div>
          <div className="card-body">
            <div className="hstack" style={{ gap: 16, flexWrap: 'wrap' }}>
              {!dmarc ? (
                <span className="text-xs subtle">Loading…</span>
              ) : dmarc.domains.length === 0 ? (
                <span className="text-xs subtle">No reports yet.</span>
              ) : (
                dmarc.domains.map((d) => (
                  <span key={d.domain} className="text-sm">
                    <span className="mono text-xs">{d.domain}</span>{' '}
                    <span className="f500">{pct(d.totalMessages > 0 ? d.passCount / d.totalMessages : null)}</span> pass
                  </span>
                ))
              )}
              <span className="grow" />
              <span className="text-sm">
                <span className="f500">{dmarcMon ? dmarcMon.alerts.open.length : '…'}</span> open alert(s)
              </span>
            </div>
          </div>
        </div>
        <div className="split split-asym" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="card-head"><span className="card-title">Recent trips</span><span className="card-sub">From audit log</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="table">
                <thead><tr><th>When</th><th>Action</th><th>Detail</th><th>Actor</th></tr></thead>
                <tbody>
                  {!trips ? (
                    <EmptyRow colSpan={4} label="Loading…" />
                  ) : trips.length === 0 ? (
                    <EmptyRow colSpan={4} label="No trips or resumes recorded." />
                  ) : (
                    trips.map((t: any, i: number) => (
                      <tr key={String(t._id ?? i)}>
                        <td className="text-xs">{t.occurredAt ? new Date(t.occurredAt).toLocaleString() : '—'}</td>
                        <td>
                          <span className={'pill ' + (t.action === 'health.trip' ? 'red' : 'green')}>
                            <span className="dot" />{t.action === 'health.trip' ? 'Tripped' : 'Resumed'}
                          </span>
                        </td>
                        <td className="text-xs mono">{t.resource?.id ?? t.diffSummary ?? '—'}</td>
                        <td className="text-xs mono">{t.actor ?? '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Providers</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 10 }}>
              {!me ? (
                <div className="text-xs subtle">Loading…</div>
              ) : me.providers.names.length === 0 ? (
                <div className="text-xs subtle">No providers configured.</div>
              ) : (
                me.providers.names.map((name) => (
                  <div key={name} className="hstack" style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
                    <div style={{ width: 30, height: 30, borderRadius: 7, background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center' }}>
                      <Icons.Mail size={14} />
                    </div>
                    <div>
                      <div className="f500 text-sm">{name}</div>
                      <div className="text-xs subtle">{name === me.providers.default ? 'default' : 'configured'}</div>
                    </div>
                    <span className="grow" />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </LoadState>
    </>
  )
}

function statusClass(s: string | null | undefined): string {
  if (s === 'tripped') return 'red'
  if (s === 'degraded') return 'amber'
  if (s === 'healthy') return 'green'
  return 'neutral'
}

function dnsblResultClass(r: string): string {
  if (r === 'listed') return 'red'
  if (r === 'error') return 'amber'
  if (r === 'clean') return 'green'
  return 'neutral'
}

function reputationClass(r: string | null | undefined): string {
  if (r === 'BAD') return 'red'
  if (r === 'LOW') return 'amber'
  if (r === 'HIGH' || r === 'MEDIUM') return 'green'
  return 'neutral'
}

function sndsFilterClass(r: string | null | undefined): string {
  if (r === 'RED') return 'red'
  if (r === 'YELLOW') return 'amber'
  if (r === 'GREEN') return 'green'
  return 'neutral'
}

function pct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(1)}%`
}
