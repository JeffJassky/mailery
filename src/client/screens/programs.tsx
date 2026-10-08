/* Programs list (0.21) */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

const STARTER = {
  slug: 'activation',
  name: 'Activation',
  category: 'lifecycle.onboarding',
  subject: 'account',
  recipients: 'owners',
  entry: { eventName: 'Account Created' },
  exit: {},
  policy: { minGapDays: 3 },
  actions: [
    {
      id: 'connect-first-source',
      version: 1,
      title: 'Connect your first source',
      priority: 100,
      satisfied: { fact: 'connected', equals: true },
      attempts: [{ deliveries: [{ channel: 'email', templateSlug: 'activation-connect-1' }] }],
      onExhaust: 'skip',
    },
  ],
}

export function Programs({ setRoute }: any) {
  const { data, loading, error, refetch } = useLive(() => api.programs())
  const rows = data ?? []
  const [creating, setCreating] = React.useState(false)
  const [text, setText] = React.useState(JSON.stringify(STARTER, null, 2))
  const [err, setErr] = React.useState<string | null>(null)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      const def = JSON.parse(text)
      const res = await api.createProgram(def)
      setCreating(false)
      setRoute({ screen: 'program-detail', slug: res.slug })
    } catch (e2: any) {
      setErr(String(e2?.message ?? e2))
    }
  }

  return (
    <>
      <PageHead
        title="Programs"
        desc="Next-best-action email programs: one email at a time, about whatever the account still needs to do."
        actions={<button className="btn btn-primary" onClick={() => setCreating(true)}><Icons.Plus size={14} />New program</button>}
      />

      {creating && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <div className="card-head" style={{ padding: 0, marginBottom: 12 }}>
            <span className="card-title">New program (saved as a disabled draft)</span>
            <span className="grow" />
            <button className="icon-btn" onClick={() => setCreating(false)}><Icons.X size={14} /></button>
          </div>
          <form onSubmit={create} className="vstack" style={{ gap: 12 }}>
            <textarea className="input mono text-xs" style={{ minHeight: 280 }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
            {err && <div className="text-xs" style={{ color: 'var(--red-fg)' }}>{err}</div>}
            <div className="hstack" style={{ gap: 8 }}>
              <button type="submit" className="btn btn-primary">Save draft</button>
              <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="card card-pad-0">
        <LoadState loading={loading && !data} error={error} empty={!!data && rows.length === 0} emptyLabel="No programs yet." retry={refetch}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 32 }}></th>
                <th>Program</th>
                <th>Category</th>
                <th>Version</th>
                <th className="num">Active</th>
                <th className="num">Completed</th>
                <th className="num">Exited</th>
                <th className="num">Sunset</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={8} label="No programs yet." />
              ) : (
                rows.map((p) => (
                  <tr key={p.slug} onClick={() => setRoute({ screen: 'program-detail', slug: p.slug })}>
                    <td><span className={'status-dot ' + (p.enabled ? 'green' : 'gray')} /></td>
                    <td>
                      <div className="f500">{p.name}</div>
                      <div className="text-xs subtle mono">{p.slug}</div>
                    </td>
                    <td className="mono text-xs">{p.category ?? '—'}</td>
                    <td className="mono text-xs">
                      {p.version > 0 ? `v${p.version}` : 'unpublished'}
                      {p.draft && <span className="pill amber" style={{ marginLeft: 6 }}>draft</span>}
                    </td>
                    <td className="num tabular">{p.runs.active}</td>
                    <td className="num tabular">{p.runs.completed}</td>
                    <td className="num tabular">{p.runs.exited}</td>
                    <td className="num tabular">{p.runs.sunset}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </LoadState>
      </div>
    </>
  )
}
