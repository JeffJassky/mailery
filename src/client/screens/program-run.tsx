/* Program run view (0.21): action grid, sunset, arm, decision timeline */
import React from 'react'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

const when = (d: unknown) => (d ? new Date(d as string).toLocaleString() : '—')

const REASON_HELP: Record<string, string> = {
  'highest-rank': 'Sent the top candidate',
  'none-eligible': 'Nothing eligible right now',
  completed: 'Every action satisfied or skipped',
  exited: 'An exit event fired',
  'in-flight': 'Waiting for the previous send to resolve',
  'min-gap': 'Candidate found, but the minimum gap has not elapsed',
  'delivery-window': 'Waiting for the delivery window',
  'no-recipients': 'No deliverable recipients',
  'session-suppressed': 'Recent session, stayed quiet',
  sunset: 'Sunset stage',
  holdout: 'Holdout: decided, did not send',
  'policy-silence': 'Contact policy held it back',
}

export function ProgramRun({ slug, subjectId, setRoute }: { slug: string; subjectId: string; setRoute: (r: any) => void }) {
  const [skip, setSkip] = React.useState(0)
  const limit = 25
  const { data, loading, error, refetch } = useLive(() => api.programRun(slug, subjectId, { limit, skip }), [slug, subjectId, skip])
  const prog = useLive(() => api.program(slug), [slug]).data
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState<string | null>(null)

  async function act(fn: () => Promise<any>, label: (r: any) => string) {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      setMsg(label(r))
      refetch()
    } catch (e: any) {
      setMsg(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  if (!data) return <LoadState loading={loading} error={error} empty={false} retry={refetch}><></></LoadState>
  const { run, decisions, total } = data
  const defActions = new Map<string, any>((prog?.published?.actions ?? []).map((a: any) => [a.id, a]))
  const ids = [...new Set([...defActions.keys(), ...Object.keys(run.actions ?? {})])]

  return (
    <>
      <PageHead
        title={<span className="mono">{subjectId}</span>}
        desc={
          <>
            <a onClick={() => setRoute({ screen: 'program-detail', slug })} style={{ cursor: 'pointer' }}>{slug}</a> ·{' '}
            <span className={'pill ' + (run.status === 'completed' ? 'green' : run.status === 'active' ? 'blue' : 'neutral')}>{run.status}</span> ·{' '}
            arm {run.arm} · sunset stage {run.sunsetStage}{run.sunsetAskSent ? ' (ask sent)' : ''} · {run.unansweredAttempts} unanswered
          </>
        }
        actions={
          <>
            <button className="btn" disabled={busy || run.status !== 'active'} onClick={() => act(() => api.tickProgramRun(slug, subjectId), (r) => `Ticked: ${r.result?.status ?? 'ok'}${r.result?.reason ? ' (' + r.result.reason + ')' : ''}`)}>Force tick</button>
            <button
              className="btn"
              disabled={busy || run.status !== 'active'}
              onClick={() => { if (confirm('Abort this run and cancel its queued sends?')) act(() => api.abortProgramRun(slug, subjectId, 'aborted from admin UI'), (r) => `Aborted; cancelled ${r.cancelledSends} send(s).`) }}
            >
              Abort
            </button>
          </>
        }
      />
      {msg && <div className="text-xs" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="card card-pad-0" style={{ marginBottom: 16 }}>
        <table className="table">
          <thead>
            <tr><th>Action</th><th>Status</th><th className="num">Attempts</th><th className="num">Ladder</th><th>Last sent</th><th>Completed</th><th>Cooldown until</th></tr>
          </thead>
          <tbody>
            {ids.length === 0 ? <EmptyRow colSpan={7} label="No action state yet (the run has not ticked)." /> : ids.map((id) => {
              const st = run.actions?.[id]
              const total = defActions.get(id)?.attempts?.length
              return (
                <tr key={id}>
                  <td><div className="f500">{defActions.get(id)?.title ?? id}</div><div className="text-xs subtle mono">{id}</div></td>
                  <td>{st ? <span className={'pill ' + (st.status === 'satisfied' ? 'green' : st.status === 'pending' ? 'blue' : 'amber')}>{st.status}</span> : <span className="subtle text-xs">not evaluated</span>}</td>
                  <td className="num tabular">{st ? `${st.attempts}${total ? ` / ${total}` : ''}` : '—'}</td>
                  <td className="num tabular">{st?.ladder ?? '—'}</td>
                  <td className="text-xs">{when(st?.lastSentAt)}</td>
                  <td className="text-xs">{when(st?.completedAt)}</td>
                  <td className="text-xs">{when(st?.cooldownUntil)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: '8px 0' }}>Decision timeline</h3>
      <div className="text-xs subtle" style={{ marginBottom: 8 }}>Newest first. Every tick writes a row, including silent ones: this is why something did, or did not, send.</div>
      <div className="vstack" style={{ gap: 8 }}>
        {decisions.length === 0 && <div className="card text-xs subtle" style={{ padding: 16 }}>No decisions yet.</div>}
        {decisions.map((d: any) => (
          <div key={d._id} className="card" style={{ padding: 12 }}>
            <div className="hstack" style={{ gap: 8, marginBottom: 6 }}>
              <span className="f500 text-xs">{when(d.at)}</span>
              <span className="pill neutral">{d.trigger}</span>
              <span className={'pill ' + (d.reason === 'highest-rank' ? 'green' : d.reason === 'holdout' ? 'violet' : 'neutral')}>{d.reason}</span>
              <span className="text-xs subtle">{REASON_HELP[d.reason] ?? ''}</span>
              <span className="grow" />
              {d.outcome && <span className="text-xs subtle">outcome: {d.outcome.status}</span>}
            </div>
            <div className="text-xs" style={{ marginBottom: 6 }}>
              Chosen: <span className="mono">{d.chosen ?? 'none'}</span>{d.attempt ? ` (attempt ${d.attempt})` : ''} · v{d.programVersion} · facts <span className="mono">{String(d.factsHash).slice(0, 8)}</span>
            </div>
            {d.candidates.length > 0 && (
              <table className="table">
                <thead><tr><th>Candidate</th><th className="num">Priority</th><th>Eligible</th><th>Satisfied</th><th>Blocked by</th><th className="num">Rank</th></tr></thead>
                <tbody>
                  {d.candidates.map((c: any) => (
                    <tr key={c.actionId}>
                      <td className="mono text-xs">{c.actionId}</td>
                      <td className="num tabular">{c.priority}</td>
                      <td className="text-xs">{c.eligible ? 'yes' : 'no'}</td>
                      <td className="text-xs">{c.satisfied ? 'yes' : 'no'}</td>
                      <td className="mono text-xs">{c.blockedBy ?? '—'}</td>
                      <td className="num tabular">{c.rank ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {d.facts && <details className="text-xs" style={{ marginTop: 6 }}><summary>Facts at decision time</summary><pre className="code" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(d.facts, null, 2)}</pre></details>}
          </div>
        ))}
      </div>
      {total > limit && (
        <div className="hstack" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn btn-sm" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - limit))}>Newer</button>
          <span className="text-xs subtle">{skip + 1}–{Math.min(skip + limit, total)} of {total}</span>
          <button className="btn btn-sm" disabled={skip + limit >= total} onClick={() => setSkip(skip + limit)}>Older</button>
        </div>
      )}
    </>
  )
}
