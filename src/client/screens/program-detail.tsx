/* Program detail (0.21): actions, JSON draft editor, funnel by arm, runs */
import React from 'react'
import { PageHead } from '../components/shell'
import { api, type ProgramArmFunnel } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

const CodeEditor = React.lazy(() => import('../components/code-editor'))

const compact = (v: unknown): string => (v === undefined ? '—' : JSON.stringify(v))

export function ProgramDetail({ slug, setRoute }: { slug: string; setRoute: (r: any) => void }) {
  const { data: prog, loading, error, refetch } = useLive(() => api.program(slug), [slug])
  const [tab, setTab] = React.useState<'actions' | 'editor' | 'funnel' | 'runs'>('actions')
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [issues, setIssues] = React.useState<Array<{ path: string; message: string }>>([])

  const [text, setText] = React.useState('')
  const [dirty, setDirty] = React.useState(false)
  const loadedFor = React.useRef<string>('')
  React.useEffect(() => {
    if (!prog) return
    const key = `${prog.slug}:${prog.version}:${prog.draft?.lastModifiedAt ?? ''}`
    if (loadedFor.current === key || dirty) return
    loadedFor.current = key
    setText(JSON.stringify(prog.draft?.definition ?? prog.published ?? {}, null, 2))
  }, [prog, dirty])

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true)
    setMsg(null)
    setIssues([])
    try {
      await fn()
      setMsg({ kind: 'ok', text: label })
      refetch()
    } catch (e: any) {
      setMsg({ kind: 'err', text: String(e?.message ?? e) })
      if (Array.isArray(e?.body?.issues)) setIssues(e.body.issues)
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = () =>
    act('Draft saved.', async () => {
      await api.saveProgramDraft(slug, JSON.parse(text))
      setDirty(false)
      loadedFor.current = ''
    })

  const publish = () =>
    act('Published.', async () => {
      if (dirty) {
        await api.saveProgramDraft(slug, JSON.parse(text))
        setDirty(false)
      }
      const r = await api.publishProgram(slug)
      setMsg({ kind: 'ok', text: `Published version ${r.version}.` })
      loadedFor.current = ''
    })

  if (loading && !prog) return <LoadState loading error={null} empty={false}><></></LoadState>
  if (error || !prog) return <LoadState loading={false} error={error} empty={false} retry={refetch}><></></LoadState>

  const def = prog.published
  return (
    <>
      <PageHead
        title={def?.name ?? prog.draft?.definition?.name ?? slug}
        desc={
          <>
            <span className="mono">{slug}</span> · {prog.version > 0 ? `v${prog.version}` : 'never published'} ·{' '}
            <span className={'pill ' + (prog.enabled ? 'green' : 'neutral')}>{prog.enabled ? 'enabled' : 'disabled'}</span>
            {prog.draft && <span className="pill amber" style={{ marginLeft: 6 }}>unpublished draft</span>}
          </>
        }
        actions={
          <>
            {prog.enabled ? (
              <button className="btn" disabled={busy} onClick={() => act('Disabled.', () => api.disableProgram(slug))}>Disable</button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={busy || prog.version < 1}
                title={prog.version < 1 ? 'Publish first' : 'Enabling does not replay earlier entry events; use Enter on the runs tab to backfill.'}
                onClick={() => act('Enabled.', () => api.enableProgram(slug))}
              >
                Enable
              </button>
            )}
          </>
        }
      />

      {msg && (
        <div className="text-xs" style={{ marginBottom: 12, color: msg.kind === 'err' ? 'var(--red-fg)' : 'var(--green-fg)' }}>{msg.text}</div>
      )}

      <div className="tabs">
        {(['actions', 'editor', 'funnel', 'runs'] as const).map((t) => (
          <div key={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
            {t === 'editor' ? 'Definition' : t[0]!.toUpperCase() + t.slice(1)}
          </div>
        ))}
      </div>

      {tab === 'actions' && <ActionsTable def={def} />}

      {tab === 'editor' && (
        <div className="card" style={{ padding: 16 }}>
          <div className="hstack" style={{ gap: 8, marginBottom: 12 }}>
            <button className="btn" disabled={busy || !dirty} onClick={saveDraft}>Save draft</button>
            <button className="btn btn-primary" disabled={busy} onClick={publish}>Publish{dirty ? ' (saves draft first)' : ''}</button>
            <span className="grow" />
            <span className="text-xs subtle">
              {prog.draft ? `Draft by ${prog.draft.lastModifiedBy}` : 'Showing the published definition'}
              {dirty && ' · unsaved edits'}
            </span>
          </div>
          {issues.length > 0 && (
            <div className="card" style={{ padding: 12, marginBottom: 12, borderColor: 'var(--red-fg)' }}>
              <div className="f500 text-xs" style={{ color: 'var(--red-fg)', marginBottom: 6 }}>Publish blocked: {issues.length} issue(s)</div>
              <ul className="text-xs" style={{ margin: 0, paddingLeft: 18 }}>
                {issues.map((i, n) => (
                  <li key={n}><span className="mono">{i.path || '(program)'}</span> — {i.message}</li>
                ))}
              </ul>
            </div>
          )}
          <React.Suspense fallback={<div className="text-xs subtle">Loading editor…</div>}>
            <CodeEditor language="json" value={text} onChange={(v) => { setText(v); setDirty(true) }} height={520} />
          </React.Suspense>
          {prog.versions.length > 0 && (
            <div className="text-xs subtle" style={{ marginTop: 12 }}>
              Versions: {prog.versions.map((v) => `v${v.version} (${new Date(v.publishedAt).toLocaleDateString()} by ${v.publishedBy})`).join(' · ')}
            </div>
          )}
        </div>
      )}

      {tab === 'funnel' && <Funnel slug={slug} />}
      {tab === 'runs' && <Runs slug={slug} setRoute={setRoute} />}
    </>
  )
}

function ActionsTable({ def }: { def: any }) {
  if (!def) return <div className="card text-xs subtle" style={{ padding: 16 }}>Not published yet. Use the Definition tab to edit the draft and publish it.</div>
  return (
    <div className="card card-pad-0">
      <table className="table">
        <thead>
          <tr>
            <th className="num">Priority</th>
            <th>Action</th>
            <th className="num">Attempts</th>
            <th>Requires</th>
            <th>Eligible</th>
            <th>Satisfied</th>
            <th>On exhaust</th>
          </tr>
        </thead>
        <tbody>
          {def.actions.length === 0 ? <EmptyRow colSpan={7} /> : def.actions.map((a: any) => (
            <tr key={a.id}>
              <td className="num tabular">{a.priority}</td>
              <td><div className="f500">{a.title}</div><div className="text-xs subtle mono">{a.id} v{a.version}</div></td>
              <td className="num tabular">{a.attempts.length}</td>
              <td className="mono text-xs">{(a.requires ?? []).join(', ') || '—'}</td>
              <td className="mono text-xs" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{compact(a.eligible)}</td>
              <td className="mono text-xs" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{compact(a.satisfied)}</td>
              <td className="text-xs">{a.onExhaust}{a.cooldownDays ? ` · ${a.cooldownDays}d cooldown` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 1000) / 10}%`)

function Funnel({ slug }: { slug: string }) {
  const { data, loading, error, refetch } = useLive(() => api.programStats(slug), [slug])
  const cell = (f: ProgramArmFunnel) => (
    <>
      <td className="num tabular">{f.evaluated}</td>
      <td className="num tabular">{f.chosen}</td>
      <td className="num tabular">{f.sent}</td>
      <td className="num tabular">{f.satisfied}</td>
    </>
  )
  return (
    <LoadState loading={loading && !data} error={error} empty={false} retry={refetch}>
      {data && (
        <>
          <div className="hstack" style={{ gap: 12, marginBottom: 12 }}>
            {(['treatment', 'holdout'] as const).map((arm) => (
              <div key={arm} className="card" style={{ padding: 12, minWidth: 180 }}>
                <div className="text-xs subtle">{arm}</div>
                <div className="f500">{data.runs[arm].total} runs</div>
                <div className="text-xs">Completion {pct(data.runs[arm].completionRate)}</div>
              </div>
            ))}
          </div>
          <div className="card card-pad-0">
            <table className="table">
              <thead>
                <tr>
                  <th rowSpan={2}>Action</th>
                  <th colSpan={4} style={{ textAlign: 'center' }}>Treatment</th>
                  <th colSpan={4} style={{ textAlign: 'center' }}>Holdout</th>
                </tr>
                <tr>
                  {[0, 1].flatMap((i) => ['Evaluated', 'Chosen', 'Sent', 'Satisfied'].map((h) => <th key={`${i}${h}`} className="num">{h}</th>))}
                </tr>
              </thead>
              <tbody>
                {data.actions.length === 0 ? <EmptyRow colSpan={9} label="No decisions yet." /> : data.actions.map((a) => (
                  <tr key={a.actionId}>
                    <td><div className="f500">{a.title ?? a.actionId}</div><div className="text-xs subtle mono">{a.actionId}</div></td>
                    {cell(a.treatment)}
                    {cell(a.holdout)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-xs subtle" style={{ marginTop: 8 }}>
            Evaluated: decisions listing the action as an unblocked candidate. Sent: delivered treatment emails, or simulated sends in holdout. Satisfied: runs where the action completed.
          </div>
        </>
      )}
    </LoadState>
  )
}

function Runs({ slug, setRoute }: { slug: string; setRoute: (r: any) => void }) {
  const [status, setStatus] = React.useState('')
  const [arm, setArm] = React.useState('')
  const [skip, setSkip] = React.useState(0)
  const limit = 25
  const { data, loading, error, refetch } = useLive(() => api.programRuns(slug, { status, arm, limit, skip }), [slug, status, arm, skip])
  const [enterId, setEnterId] = React.useState('')
  const [enterMsg, setEnterMsg] = React.useState<string | null>(null)

  async function enter(e: React.FormEvent) {
    e.preventDefault()
    setEnterMsg(null)
    try {
      const r = await api.enterProgram(slug, enterId.trim())
      setEnterMsg(r.created ? 'Entered.' : 'That subject already has a run.')
      setEnterId('')
      refetch()
    } catch (err: any) {
      setEnterMsg(String(err?.message ?? err))
    }
  }

  return (
    <>
      <div className="hstack" style={{ gap: 8, marginBottom: 12 }}>
        <select className="select" value={status} onChange={(e) => { setSkip(0); setStatus(e.target.value) }}>
          <option value="">Any status</option>
          {['active', 'completed', 'exited', 'sunset'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="select" value={arm} onChange={(e) => { setSkip(0); setArm(e.target.value) }}>
          <option value="">Both arms</option>
          <option>treatment</option>
          <option>holdout</option>
        </select>
        <span className="grow" />
        <form onSubmit={enter} className="hstack" style={{ gap: 8 }}>
          <input className="input" placeholder="subject id to enter" value={enterId} onChange={(e) => setEnterId(e.target.value)} />
          <button className="btn" type="submit" disabled={!enterId.trim()}>Enter</button>
        </form>
      </div>
      {enterMsg && <div className="text-xs" style={{ marginBottom: 8 }}>{enterMsg}</div>}
      <div className="card card-pad-0">
        <LoadState loading={loading && !data} error={error} empty={!!data && data.runs.length === 0} emptyLabel="No runs." retry={refetch}>
          <table className="table">
            <thead>
              <tr><th>Subject</th><th>Status</th><th>Arm</th><th className="num">Unanswered</th><th>Last sent</th><th>Next tick</th></tr>
            </thead>
            <tbody>
              {(data?.runs ?? []).map((r: any) => (
                <tr key={r._id} onClick={() => setRoute({ screen: 'program-run', slug, id: r.subjectId })}>
                  <td className="mono text-xs">{r.subjectId}</td>
                  <td><span className={'pill ' + (r.status === 'completed' ? 'green' : r.status === 'active' ? 'blue' : 'neutral')}>{r.status}</span></td>
                  <td className="text-xs">{r.arm}</td>
                  <td className="num tabular">{r.unansweredAttempts}</td>
                  <td className="text-xs">{r.lastSentAt ? new Date(r.lastSentAt).toLocaleString() : '—'}</td>
                  <td className="text-xs">{r.status === 'active' ? new Date(r.nextTickAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </LoadState>
      </div>
      {data && data.total > limit && (
        <div className="hstack" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn btn-sm" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - limit))}>Previous</button>
          <span className="text-xs subtle">{skip + 1}–{Math.min(skip + limit, data.total)} of {data.total}</span>
          <button className="btn btn-sm" disabled={skip + limit >= data.total} onClick={() => setSkip(skip + limit)}>Next</button>
        </div>
      )}
    </>
  )
}
