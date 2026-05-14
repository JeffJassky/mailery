/* List Hygiene — engagement breakdown + sunset-impact projection.
 *
 * Visibility-only by design. The original PR8 roadmap included a "Suppress
 * these N contacts" action button; the operator-facing scope was narrowed
 * during build to report-only — sunsetting requires deliberate, audited
 * action and the existing Suppressions screen + REST endpoint already
 * support it. Reintroducing the bulk-action button is tracked as a
 * potential v2.
 */
import React from 'react'
import { PageHead } from '../components/shell'
import { api, type HygieneBucket, type HygieneReport } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function ListHygiene(_: any) {
  const { data, loading, error, refetch } = useLive(() => api.hygiene())

  return (
    <>
      <PageHead
        title="List hygiene"
        desc="Engagement breakdown of your subscriber list. Sunsetting long-inactive contacts is the single biggest lever on bounce + complaint rates."
        actions={
          <button className="btn btn-xs" disabled={loading} onClick={refetch}>
            {loading ? 'Computing…' : 'Recompute'}
          </button>
        }
      />

      <LoadState loading={loading && !data} error={error} empty={false} retry={refetch}>
        {data && <HygieneBody report={data} />}
      </LoadState>
    </>
  )
}

function HygieneBody({ report }: { report: HygieneReport }) {
  const sunset = report.sunsetCandidate
  const proj = sunset.projectedImpact

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Subscribed contacts</div>
          <div className="kpi-value">{report.totalSubscribers.toLocaleString()}</div>
          <div className="kpi-meta subtle">{report.totalWithSends.toLocaleString()} have received at least one send</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Engaged (30d)</div>
          <div className="kpi-value" style={{ color: 'var(--green-fg)' }}>{fmtPct(report.buckets[0]?.pctOfTotal)}</div>
          <div className="kpi-meta subtle">{report.buckets[0]?.count.toLocaleString() ?? 0} contacts</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Inactive &gt;180d</div>
          <div className="kpi-value" style={{ color: 'var(--amber-fg)' }}>{fmtPct(report.buckets[4]?.pctOfTotal)}</div>
          <div className="kpi-meta subtle">{report.buckets[4]?.count.toLocaleString() ?? 0} contacts</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Never engaged</div>
          <div className="kpi-value" style={{ color: 'var(--fg-muted)' }}>{fmtPct(report.buckets[5]?.pctOfTotal)}</div>
          <div className="kpi-meta subtle">{report.buckets[5]?.count.toLocaleString() ?? 0} contacts</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="card-title">Engagement breakdown</span>
          <span className="card-sub">
            Days since the contact last opened or clicked any mail you sent.
          </span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Cohort</th>
                <th className="text-right">Contacts</th>
                <th className="text-right">% of subscribers</th>
                <th>Distribution</th>
              </tr>
            </thead>
            <tbody>
              {report.buckets.length === 0 || report.totalSubscribers === 0 ? (
                <EmptyRow colSpan={4} label="No subscribers yet." />
              ) : (
                report.buckets.map((b) => (
                  <BucketRow key={b.label} bucket={b} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="card-title">Sunset opportunity</span>
          <span className="card-sub">
            Long-inactive contacts disproportionately bounce or complain. Surface only — no automatic action.
          </span>
        </div>
        <div className="card-body" style={{ display: 'grid', gap: 12 }}>
          {sunset.count === 0 ? (
            <div className="text-sm subtle">
              No sunset candidates — every subscribed contact has engaged within the last 180 days, or has been on the list for less than 180 days.
            </div>
          ) : (
            <>
              <div className="text-sm">
                <strong>{sunset.count.toLocaleString()}</strong> subscribed contact{sunset.count === 1 ? '' : 's'} are candidates for sunset
                ({fmtPct(sunset.pctOfTotal)} of your list).
                Definition: inactive &gt;180 days, or never engaged after &gt;180 days of being subscribed.
              </div>

              {sunset.cohortLifetime && (
                <div className="text-sm">
                  <span className="subtle">Cohort lifetime metrics ({sunset.cohortLifetime.totalSends.toLocaleString()} sends): </span>
                  bounce <strong>{fmtPct(sunset.cohortLifetime.bouncedRate)}</strong>,{' '}
                  hard bounce <strong>{fmtPct(sunset.cohortLifetime.hardBouncedRate)}</strong>,{' '}
                  complaint <strong>{fmtPct(sunset.cohortLifetime.complaintRate)}</strong>.
                </div>
              )}

              {proj && proj.recentTotalSends > 0 && (
                <ProjectedImpact proj={proj} />
              )}
            </>
          )}
        </div>
      </div>

      <div className="text-xs subtle">
        Computed {new Date(report.computedAt).toLocaleString()}.
      </div>
    </>
  )
}

function BucketRow({ bucket }: { bucket: HygieneBucket }) {
  const pct = bucket.pctOfTotal * 100
  const color =
    bucket.label.startsWith('Engaged (last 30')
      ? 'var(--green-fg)'
      : bucket.label.startsWith('Engaged')
      ? '#6abd76'
      : bucket.label.startsWith('Inactive')
      ? 'var(--amber-fg)'
      : 'var(--fg-muted)'
  return (
    <tr>
      <td>{bucket.label}</td>
      <td className="text-right mono text-xs">{bucket.count.toLocaleString()}</td>
      <td className="text-right text-xs">{fmtPct(bucket.pctOfTotal)}</td>
      <td>
        <div style={{ height: 8, background: 'var(--bg-sunken)', borderRadius: 4, overflow: 'hidden', maxWidth: 240 }}>
          <div
            style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: color, transition: 'width 0.3s' }}
          />
        </div>
      </td>
    </tr>
  )
}

function ProjectedImpact({ proj }: { proj: NonNullable<HygieneReport['sunsetCandidate']['projectedImpact']> }) {
  const bounceDelta = proj.currentOverallBounceRate - proj.projectedBounceRate
  const complaintDelta = proj.currentOverallComplaintRate - proj.projectedComplaintRate
  const cohortShareBounces = proj.recentBounced > 0 ? proj.cohortRecentBounced / proj.recentBounced : 0
  const cohortShareComplaints = proj.recentComplained > 0 ? proj.cohortRecentComplained / proj.recentComplained : 0

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="text-xs subtle">
        Of the last 90 days&apos; {proj.recentTotalSends.toLocaleString()} sends, the sunset cohort generated:
      </div>
      <div className="hstack" style={{ gap: 24 }}>
        <ImpactStat
          label="Recent bounces from cohort"
          value={`${proj.cohortRecentBounced.toLocaleString()} / ${proj.recentBounced.toLocaleString()}`}
          sub={`${fmtPct(cohortShareBounces)} of total bounces`}
        />
        <ImpactStat
          label="Recent complaints from cohort"
          value={`${proj.cohortRecentComplained.toLocaleString()} / ${proj.recentComplained.toLocaleString()}`}
          sub={`${fmtPct(cohortShareComplaints)} of total complaints`}
        />
      </div>
      <div className="text-xs subtle" style={{ marginTop: 4 }}>
        Projected rates after sunset:
      </div>
      <div className="hstack" style={{ gap: 24 }}>
        <ImpactStat
          label="Bounce rate"
          value={`${fmtPct(proj.currentOverallBounceRate)} → ${fmtPct(proj.projectedBounceRate)}`}
          sub={bounceDelta > 0 ? `−${fmtPct(bounceDelta)}` : 'no change'}
          good={bounceDelta > 0}
        />
        <ImpactStat
          label="Complaint rate"
          value={`${fmtPct(proj.currentOverallComplaintRate)} → ${fmtPct(proj.projectedComplaintRate)}`}
          sub={complaintDelta > 0 ? `−${fmtPct(complaintDelta)}` : 'no change'}
          good={complaintDelta > 0}
        />
      </div>
    </div>
  )
}

function ImpactStat({ label, value, sub, good }: { label: string; value: string; sub: string; good?: boolean }) {
  return (
    <div>
      <div className="text-xs subtle">{label}</div>
      <div className="text-sm mono">{value}</div>
      <div className="text-xs" style={{ color: good ? 'var(--green-fg)' : 'var(--fg-muted)' }}>{sub}</div>
    </div>
  )
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(2)}%`
}
