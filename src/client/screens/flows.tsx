/* Flows list */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { sample } from '../lib/mock'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'

export function Flows({ setRoute }: any) {
  const [tab, setTab] = React.useState('all')
  const { data: flows } = useLive(() => api.flows(), sample.flows)

  const filtered = flows.filter((f: any) =>
    tab === 'all' ? true : tab === 'enabled' ? f.enabled : !f.enabled,
  )
  return (
    <>
      <PageHead
        title="Flows"
        desc="Event-triggered and segment-based automations."
        actions={
          <>
            <button className="btn"><Icons.Download size={14} />Export JSON</button>
            <button className="btn btn-primary"><Icons.Plus size={14} />New flow</button>
          </>
        }
      />

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
