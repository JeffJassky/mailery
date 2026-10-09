/* DMARC Monitoring */
import React from 'react'
import { PageHead } from '../../components/shell'
import { api, type DmarcSourceRow as DmarcSourceRowType } from '../../lib/api'
import { useLive } from '../../lib/use-live'
import { LoadState, EmptyRow } from '../../lib/load-state'
import { AlertsCard } from './alerts-card'
import { SetupCard } from './setup-card'
import { SettingsCard } from './settings-card'

export function Dmarc(_: any) {
  const { data: dmarc, loading, error, refetch: refetchDmarc } = useLive(() => api.dmarc())
  const { data: monitoring, loading: monLoading, error: monError, refetch: refetchMonitoring } = useLive(() => api.dmarcMonitoring())
  const [dmarcUploading, setDmarcUploading] = React.useState(false)
  const [dmarcMessage, setDmarcMessage] = React.useState<string | null>(null)
  const [dmarcError, setDmarcError] = React.useState<string | null>(null)
  const dmarcInputRef = React.useRef<HTMLInputElement | null>(null)

  function refetchAll() {
    refetchDmarc()
    refetchMonitoring()
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
    refetchAll()
    setDmarcUploading(false)
    if (dmarcInputRef.current) dmarcInputRef.current.value = ''
  }

  return (
    <>
      <PageHead
        title="DMARC Monitoring"
        desc="Aggregate reports, DNS checks and alerts for the domains you send as."
      />

      <LoadState
        loading={(loading && !dmarc) || (monLoading && !monitoring)}
        error={error ?? monError}
        empty={false}
        retry={refetchAll}
      >
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body">
            <p className="text-sm" style={{ margin: 0 }}>
              Gmail, Yahoo and Microsoft require bulk senders to authenticate with SPF, DKIM and DMARC. DMARC aggregate reports are
              the only way to see silent breakage, such as a rotated DKIM key or a new tool sending as your domain, and spoofing of
              your domain. Reports are the evidence that tightening your policy from none to quarantine to reject is safe, and the
              early warning when something breaks later.{' '}
              <a
                href="https://jeffjassky.github.io/mailery/guide/deliverability#dmarc-rua-report-ingestion"
                target="_blank"
                rel="noreferrer"
              >
                Read the DMARC guide
              </a>
              .
            </p>
          </div>
        </div>

        {monitoring && <AlertsCard data={monitoring} onChanged={refetchAll} />}
        {monitoring && <SetupCard data={monitoring} onChanged={refetchAll} />}

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span className="card-title">DMARC domains</span>
            <span className="card-sub">
              Aggregate reports received per domain. Reports normally arrive through the inbound webhook; you can also upload them by hand.
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
                    <th>Reverse DNS</th>
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
                      onChanged={refetchAll}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

{dmarc && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span className="card-title">Recent reports</span>
            <span className="card-sub">The 30 most recently received aggregate reports.</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Domain</th>
                  <th>Reporter</th>
                  <th>Policy</th>
                  <th className="text-right">Messages</th>
                  <th className="text-right">Pass</th>
                  <th className="text-right">Fail</th>
                  <th>Via</th>
                </tr>
              </thead>
              <tbody>
                {dmarc.recentReports.length === 0 ? (
                  <EmptyRow colSpan={8} label="No reports received yet." />
                ) : (
                  dmarc.recentReports.map((r) => (
                    <tr key={`${r.orgName}|${r.reportId}`}>
                      <td className="text-xs">{new Date(r.receivedAt).toLocaleString()}</td>
                      <td className="mono text-xs">{r.domain}</td>
                      <td className="text-xs">{r.orgName}</td>
                      <td className="text-xs">{r.policyP}{r.policyPct !== 100 ? ` (pct=${r.policyPct})` : ''}</td>
                      <td className="text-right text-xs">{r.totalMessages.toLocaleString()}</td>
                      <td className="text-right text-xs">{r.passCount.toLocaleString()}</td>
                      <td className="text-right text-xs" style={{ color: r.failCount > 0 ? 'var(--red-fg)' : undefined }}>
                        {r.failCount.toLocaleString()}
                      </td>
                      <td className="text-xs">{r.via ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        )}

        {monitoring && <SettingsCard data={monitoring} onChanged={refetchAll} />}
      </LoadState>
    </>
  )
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
      <td className="mono text-xs">{source.ptr ?? '—'}</td>
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
