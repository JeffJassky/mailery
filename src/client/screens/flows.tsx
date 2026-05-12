/* Flows list */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { sample } from '../lib/mock'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'

export function Flows({ setRoute }: any) {
  const [tab, setTab] = React.useState('all')
  const { data: flows, refetch } = useLive(() => api.flows(), sample.flows)
  const [creating, setCreating] = React.useState(false)
  const [createForm, setCreateForm] = React.useState({ slug: '', name: '', eventName: '', goal: 'activation' })
  const [creatingError, setCreatingError] = React.useState<string | null>(null)

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreatingError(null)
    try {
      await api.createFlow({
        slug: createForm.slug.trim(),
        name: createForm.name.trim(),
        trigger: { eventName: createForm.eventName.trim(), once: true },
        goal: createForm.goal,
      })
      setCreating(false)
      setCreateForm({ slug: '', name: '', eventName: '', goal: 'activation' })
      refetch()
    } catch (err: any) {
      setCreatingError(String(err?.message ?? err))
    }
  }

  const filtered = flows.filter((f: any) =>
    tab === 'all' ? true : tab === 'enabled' ? f.enabled : !f.enabled,
  )
  return (
    <>
      <PageHead
        title="Flows"
        desc="Event-triggered automations."
        actions={
          <>
            <button className="btn"><Icons.Download size={14} />Export JSON</button>
            <button className="btn btn-primary" onClick={() => setCreating(true)}><Icons.Plus size={14} />New flow</button>
          </>
        }
      />

      {creating && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <div className="card-head" style={{ padding: 0, marginBottom: 12 }}>
            <span className="card-title">New flow</span>
            <span className="grow" />
            <button className="icon-btn" onClick={() => setCreating(false)}><Icons.X size={14} /></button>
          </div>
          <form onSubmit={submitCreate} className="vstack" style={{ gap: 12 }}>
            <div className="hstack" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="field-label">Slug</label>
                <input className="input" placeholder="welcome-series" value={createForm.slug} onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value })} required />
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="field-label">Name</label>
                <input className="input" placeholder="Welcome Series" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} required />
              </div>
            </div>
            <div className="hstack" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="field-label">Trigger event</label>
                <input className="input" placeholder="Created" value={createForm.eventName} onChange={(e) => setCreateForm({ ...createForm, eventName: e.target.value })} required />
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="field-label">Goal</label>
                <select className="select" value={createForm.goal} onChange={(e) => setCreateForm({ ...createForm, goal: e.target.value })}>
                  <option>activation</option>
                  <option>conversion</option>
                  <option>retention</option>
                  <option>reactivation</option>
                  <option>transactional</option>
                </select>
              </div>
            </div>
            {creatingError && <div className="text-xs" style={{ color: 'var(--red-fg)' }}>{creatingError}</div>}
            <div className="hstack" style={{ gap: 8 }}>
              <button type="submit" className="btn btn-primary">Create (disabled, draft only)</button>
              <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="tabs">
        <div className={'tab' + (tab === 'all' ? ' active' : '')} onClick={() => setTab('all')}>All<span className="tab-count">{flows.length}</span></div>
        <div className={'tab' + (tab === 'enabled' ? ' active' : '')} onClick={() => setTab('enabled')}>Enabled<span className="tab-count">{flows.filter((f: any) => f.enabled).length}</span></div>
        <div className={'tab' + (tab === 'disabled' ? ' active' : '')} onClick={() => setTab('disabled')}>Disabled<span className="tab-count">{flows.filter((f: any) => !f.enabled).length}</span></div>
      </div>

      <div className="filter-bar">
        <span className="filter-chip"><Icons.Filter size={12} />Goal: any</span>
        <span className="filter-chip">Trigger: event</span>
        <span className="filter-chip active">Showing {filtered.length} of {flows.length}</span>
      </div>

      <div className="card card-pad-0">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th>Flow</th>
              <th>Trigger</th>
              <th>Goal</th>
              <th className="num">Active runs</th>
              <th className="num">Sends 7d</th>
              <th>Version</th>
              <th style={{ width: 32 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((f: any) => (
              <tr key={f.slug} onClick={() => setRoute({ screen: 'flow-detail', slug: f.slug })}>
                <td><span className={'status-dot ' + (f.enabled ? 'green' : 'gray')} /></td>
                <td>
                  <div className="f500">{f.name}</div>
                  <div className="text-xs subtle mono">{f.slug}</div>
                </td>
                <td><span className="tag">{triggerLabel(f)}</span></td>
                <td><span className="pill neutral">{f.goal}</span></td>
                <td className="num tabular">{f.active ?? f.stats?.activeRuns ?? 0}</td>
                <td className="num tabular">{f.sends7d ?? f.stats?.sendsLast7Days ?? 0}</td>
                <td className="mono text-xs">v{f.version}</td>
                <td><Icons.Dots size={14} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function triggerLabel(f: any): string {
  if (typeof f.trigger === 'string') return f.trigger
  if (f.trigger?.type === 'event') return `event: ${f.trigger.eventName}`
  return f.trigger?.type ?? '—'
}
