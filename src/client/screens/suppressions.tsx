/* Suppressions list */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Suppressions(_: any) {
  const { data: suppressions, loading, error, refetch } = useLive(() => api.suppressions())
  const rows = suppressions ?? []
  const reasonCount = (reason: string) => rows.filter((s: any) => s.reason === reason).length

  const [adding, setAdding] = React.useState(false)
  const [form, setForm] = React.useState({ email: '', scope: 'all' as 'all' | 'marketing' | 'transactional', reason: 'manual', notes: '' })
  const [addErr, setAddErr] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault()
    setAddErr(null)
    setBusy(true)
    try {
      await api.addSuppression({
        email: form.email.trim(),
        scope: form.scope,
        reason: form.reason,
        source: 'admin',
        notes: form.notes.trim() || undefined,
      })
      setAdding(false)
      setForm({ email: '', scope: 'all', reason: 'manual', notes: '' })
      refetch()
    } catch (err: any) {
      setAddErr(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead
        title="Suppressions"
        desc="Do-not-send list scoped by kind. Auto-added on hard bounce, complaint, or unsubscribe."
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Icons.Plus size={14} />Add suppression</button>
        }
      />

      {adding && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <div className="card-head" style={{ padding: 0, marginBottom: 12 }}>
            <span className="card-title">Add suppression</span>
            <span className="grow" />
            <button className="icon-btn" onClick={() => setAdding(false)}><Icons.X size={14} /></button>
          </div>
          <form onSubmit={submitAdd} className="vstack" style={{ gap: 12 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label">Email</label>
              <input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="hstack" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="field-label">Scope</label>
                <select className="select" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as any })}>
                  <option value="all">All</option>
                  <option value="marketing">Marketing only</option>
                  <option value="transactional">Transactional only</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="field-label">Reason</label>
                <select className="select" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
                  <option value="manual">manual</option>
                  <option value="hard_bounce">hard_bounce</option>
                  <option value="complaint">complaint</option>
                  <option value="unsubscribed">unsubscribed</option>
                </select>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label">Notes (optional)</label>
              <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            {addErr && <div className="text-xs" style={{ color: 'var(--red-fg)' }}>{addErr}</div>}
            <div className="hstack" style={{ gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={busy}>Add</button>
              <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Total suppressed</div><div className="kpi-value">{suppressions ? rows.length : '—'}</div><div className="kpi-meta subtle">All scopes</div></div>
        <div className="kpi"><div className="kpi-label">Hard bounce</div><div className="kpi-value">{suppressions ? reasonCount('hard_bounce') : '—'}</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Complaints</div><div className="kpi-value">{suppressions ? reasonCount('complaint') : '—'}</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Unsubscribed</div><div className="kpi-value">{suppressions ? reasonCount('unsubscribed') : '—'}</div></div>
      </div>

      <div className="card card-pad-0">
        <LoadState loading={loading && !suppressions} error={error} empty={!!suppressions && rows.length === 0} emptyLabel="No suppressions yet." retry={refetch}>
          <table className="table">
            <thead>
              <tr><th>Email</th><th>Scope</th><th>Reason</th><th>Source</th><th>Added</th><th style={{ width: 32 }}></th></tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={6} label="No suppressions yet." />
              ) : (
                rows.map((s: any, i: number) => (
                  <tr key={String(s._id ?? (s.email ?? '') + s.scope + i)}>
                    <td className="mono text-xs">{s.email ?? <span className="subtle">(hash only)</span>}</td>
                    <td><span className={'pill ' + scopePillClass(s.scope)}>{s.scope}</span></td>
                    <td><span className="tag">{s.reason}</span></td>
                    <td className="text-xs subtle mono">{s.source ?? '—'}</td>
                    <td className="text-xs subtle">{s.addedAt ? new Date(s.addedAt).toLocaleString() : '—'}</td>
                    <td><Icons.Dots size={14} /></td>
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

function scopePillClass(scope: string | undefined): string {
  switch (scope) {
    case 'all': return 'red'
    case 'marketing': return 'amber'
    case 'transactional': return 'violet'
    default: return 'neutral'
  }
}
