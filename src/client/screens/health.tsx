/* Health */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api, type DnsblCheck, type DmarcSourceRow as DmarcSourceRowType, type HealthBucket } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Health(_: any) {
  const { data: health, loading, error, refetch } = useLive(() => api.health())
  const { data: trips, refetch: refetchTrips } = useLive(() => api.healthTrips())
  const { data: me } = useLive(() => api.me())
  const { data: dnsbl, refetch: refetchDnsbl } = useLive(() => api.dnsbl())
  const { data: postmaster, refetch: refetchPostmaster } = useLive(() => api.postmaster())
  const { data: snds, refetch: refetchSnds } = useLive(() => api.snds())
  const { data: dmarc, refetch: refetchDmarc } = useLive(() => api.dmarc())
  const [dmarcUploading, setDmarcUploading] = React.useState(false)
  const [dmarcMessage, setDmarcMessage] = React.useState<string | null>(null)
  const [dmarcError, setDmarcError] = React.useState<string | null>(null)
  const dmarcInputRef = React.useRef<HTMLInputElement | null>(null)
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

  async function uploadDmarcFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setDmarcUploading(true)
    setDmarcError(null)
    setDmarcMessage(null)
    // Process files independently so one bad attachment doesn't drop the
    // success message for the rest of the batch.
    const fresh: number[] = []
    const dup: number[] = []
    const errors: Array<{ name: string; message: string }> = []
    for (const f of Array.from(files)) {
      try {
        const r = await api.uploadDmarc(f)
        if (r.duplicate) dup.push(1)
        else fresh.push(1)
      } catch (err: any) {
        errors.push({ name: f.name, message: String(err?.message ?? err) })
      }
    }
    const parts: string[] = []
    if (fresh.length) parts.push(`Ingested ${fresh.length} report(s)`)
    if (dup.length) parts.push(`${dup.length} duplicate(s) skipped`)
    if (errors.length) parts.push(`${errors.length} failed`)
    if (parts.length) setDmarcMessage(parts.join(', ') + '.')
    if (errors.length) {
      setDmarcError(errors.map((e) => `${e.name}: ${e.message}`).join('; '))
    }
    refetchDmarc()
    setDmarcUploading(false)
    if (dmarcInputRef.current) dmarcInputRef.current.value = ''
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

  const fmt = (n: number | undefined) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`)

  // Colorize a rate by its trip threshold:
  //  ≥ trip → red, ≥ 50% of trip → amber, else green, undefined → muted.
  function rateColor(rate: number | undefined, tripPct: number | undefined): string {
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
            <span className="card-sub">
              Upload `.zip` / `.gz` aggregate reports from your `rua=` mailbox to see who is sending as your domain.
            </span>
            <div className="card-actions">
              <input
                ref={dmarcInputRef}
                type="file"
                accept=".zip,.gz,.xml"
                multiple
                aria-label="DMARC RUA aggregate report file(s)"
                style={{ display: 'none' }}
                onChange={(e) => uploadDmarcFiles(e.target.files)}
              />
              <button className="btn btn-xs" disabled={dmarcUploading} onClick={() => dmarcInputRef.current?.click()}>
                {dmarcUploading ? 'Uploading…' : 'Upload report(s)'}
              </button>
              {dmarcMessage && <span className="text-xs subtle">{dmarcMessage}</span>}
              {dmarcError && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{dmarcError}</span>}
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Policy</th>
                  <th className="text-right">Reports</th>
                  <th className="text-right">Messages</th>
                  <th className="text-right">Pass</th>
                  <th className="text-right">Fail</th>
                  <th className="text-right">Alignment</th>
                  <th>14d trend</th>
                  <th className="text-right">Last range</th>
                </tr>
              </thead>
              <tbody>
                {!dmarc ? (
                  <EmptyRow colSpan={9} label="Loading…" />
                ) : dmarc.domains.length === 0 ? (
                  <EmptyRow colSpan={9} label="No reports yet. Upload your first DMARC RUA aggregate report (typically a .zip or .gz attachment from your rua= mailbox)." />
                ) : (
                  dmarc.domains.map((d) => (
                    <React.Fragment key={d.domain}>
                      <tr>
                        <td className="mono text-xs">{d.domain}</td>
                        <td className="text-xs">
                          {d.currentPolicy ?? '—'}
                          {d.currentPct != null && d.currentPct !== 100 ? ` (pct=${d.currentPct})` : ''}
                        </td>
                        <td className="text-right text-xs">{d.reportCount}</td>
                        <td className="text-right text-xs">{d.totalMessages.toLocaleString()}</td>
                        <td className="text-right text-xs">{d.passCount.toLocaleString()}</td>
                        <td className="text-right text-xs" style={{ color: d.failCount > 0 ? 'var(--red-fg)' : undefined }}>
                          {d.failCount.toLocaleString()}
                        </td>
                        <td className="text-right text-xs">{pct(d.alignmentRate)}</td>
                        <td>
                          <Sparkline values={d.series.map((p) => p.alignmentRate)} />
                        </td>
                        <td className="text-right text-xs">
                          {d.latestRangeEnd ? new Date(d.latestRangeEnd).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                      {d.progression && (
                        <tr>
                          <td colSpan={9} style={{ background: 'var(--bg-sunken)' }}>
                            <div className="hstack" style={{ padding: '8px 12px', gap: 10 }}>
                              <span className="pill green"><span className="dot" />Suggestion</span>
                              <span className="text-sm">
                                <strong>{d.domain}:</strong> ready to advance to{' '}
                                <span className="mono">
                                  p={d.progression.policy}
                                  {d.progression.pct !== 100 ? ` pct=${d.progression.pct}` : ''}
                                </span>
                                {' — '}
                                <span className="subtle text-xs">{d.progression.reason}</span>
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {dmarc && dmarc.sources.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <span className="card-title">Top failing source IPs (last 30 days)</span>
              <span className="card-sub">
                IPs sending mail as your domain that did not pass DMARC alignment. Tag known sources so the policy-progression suggestion can run.
              </span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Source IP</th>
                    <th>Label</th>
                    <th>Domain</th>
                    <th className="text-right">Messages</th>
                    <th className="text-right">Days seen</th>
                    <th>DKIM</th>
                    <th>SPF</th>
                    <th>Disposition</th>
                    <th>Tag</th>
                  </tr>
                </thead>
                <tbody>
                  {dmarc.sources.map((s) => (
                    <DmarcSourceRow
                      key={`${s.sourceIp}|${s.domain}`}
                      source={s}
                      onChanged={() => refetchDmarc()}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

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

/**
 * 14-day alignment-rate sparkline. Values in [0, 1] or null for missing
 * days. Renders an inline SVG so there's no chart-library cost.
 */
function Sparkline({ values, width = 80, height = 18 }: { values: Array<number | null>; width?: number; height?: number }) {
  if (!values || values.length === 0) {
    return <span className="text-xs subtle">—</span>
  }
  const present = values.filter((v): v is number => v != null)
  if (present.length === 0) return <span className="text-xs subtle">—</span>

  const stepX = values.length > 1 ? width / (values.length - 1) : width

  // Break the line into contiguous-non-null segments so missing days render
  // as gaps rather than straight interpolations across them.
  const segments: string[][] = []
  let current: string[] = []
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length > 0) {
        segments.push(current)
        current = []
      }
      return
    }
    const x = i * stepX
    const y = height - v * height
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (current.length > 0) segments.push(current)

  const last = present[present.length - 1]!
  const color = last >= 0.99 ? 'var(--green-fg)' : last >= 0.95 ? 'var(--amber-fg)' : 'var(--red-fg)'

  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }} aria-hidden="true">
      {segments.map((pts, idx) => (
        <polyline
          key={idx}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          points={pts.join(' ')}
        />
      ))}
    </svg>
  )
}

function DmarcSourceRow({ source, onChanged }: { source: DmarcSourceRowType; onChanged: () => void }) {
  const [editing, setEditing] = React.useState(false)
  const [label, setLabel] = React.useState(source.label ?? '')
  const [ignored, setIgnored] = React.useState(source.ignored)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function save() {
    if (!label.trim()) {
      setError('Label is required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.tagDmarcSource(source.sourceIp, { label: label.trim(), ignored })
      setEditing(false)
      onChanged()
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setSaving(false)
    }
  }

  async function untag() {
    setSaving(true)
    setError(null)
    try {
      await api.untagDmarcSource(source.sourceIp)
      setEditing(false)
      setLabel('')
      setIgnored(false)
      onChanged()
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr style={{ opacity: source.ignored ? 0.55 : 1 }}>
      <td className="mono text-xs">{source.sourceIp}</td>
      <td className="text-xs">
        {editing ? (
          <span className="hstack" style={{ gap: 4 }}>
            <input
              autoFocus
              type="text"
              value={label}
              placeholder="e.g. SendGrid"
              onChange={(e) => setLabel(e.target.value)}
              style={{ width: 140 }}
              disabled={saving}
            />
            <label className="text-xs hstack" style={{ gap: 3 }}>
              <input type="checkbox" checked={ignored} onChange={(e) => setIgnored(e.target.checked)} disabled={saving} />
              ignore
            </label>
            {error && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{error}</span>}
          </span>
        ) : (
          source.label ?? <span className="subtle">unknown</span>
        )}
      </td>
      <td className="mono text-xs">{source.domain}</td>
      <td className="text-right text-xs">{source.totalMessages.toLocaleString()}</td>
      <td className="text-right text-xs">{source.daysSeen}</td>
      <td className="text-xs">{source.dkimResult}</td>
      <td className="text-xs">{source.spfResult}</td>
      <td className="text-xs">{source.dispositionApplied}</td>
      <td>
        {editing ? (
          <span className="hstack" style={{ gap: 4 }}>
            <button className="btn btn-xs" disabled={saving} onClick={save}>{saving ? '…' : 'Save'}</button>
            <button className="btn btn-xs" disabled={saving} onClick={() => { setEditing(false); setLabel(source.label ?? ''); setIgnored(source.ignored); setError(null) }}>Cancel</button>
          </span>
        ) : source.label ? (
          <span className="hstack" style={{ gap: 4 }}>
            <button className="btn btn-xs" disabled={source.tagSource === 'config'} title={source.tagSource === 'config' ? 'Set in MailerConfig — edit there' : ''} onClick={() => setEditing(true)}>Edit</button>
            {source.tagSource === 'db' && (
              <button className="btn btn-xs" disabled={saving} onClick={untag}>Untag</button>
            )}
          </span>
        ) : (
          <button className="btn btn-xs" onClick={() => setEditing(true)}>Tag</button>
        )}
      </td>
    </tr>
  )
}

function pct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(1)}%`
}
