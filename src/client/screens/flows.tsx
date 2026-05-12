/* Flows list */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { sample } from '../lib/mock'

export function Flows({ setRoute }: any) {
  const [tab, setTab] = React.useState('all')
  const filtered = sample.flows.filter((f) =>
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
        <div className={'tab' + (tab === 'all' ? ' active' : '')} onClick={() => setTab('all')}>All<span className="tab-count">{sample.flows.length}</span></div>
        <div className={'tab' + (tab === 'enabled' ? ' active' : '')} onClick={() => setTab('enabled')}>Enabled<span className="tab-count">{sample.flows.filter((f) => f.enabled).length}</span></div>
        <div className={'tab' + (tab === 'disabled' ? ' active' : '')} onClick={() => setTab('disabled')}>Disabled<span className="tab-count">{sample.flows.filter((f) => !f.enabled).length}</span></div>
      </div>

      <div className="filter-bar">
        <span className="filter-chip"><Icons.Filter size={12} />Goal: any</span>
        <span className="filter-chip">Trigger: event</span>
        <span className="filter-chip active">Showing {filtered.length} of {sample.flows.length}</span>
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
            {filtered.map((f) => (
              <tr key={f.slug} onClick={() => setRoute({ screen: 'flow-detail', slug: f.slug })}>
                <td><span className={'status-dot ' + (f.enabled ? 'green' : 'gray')} /></td>
                <td>
                  <div className="f500">{f.name}</div>
                  <div className="text-xs subtle mono">{f.slug}</div>
                </td>
                <td><span className="tag">{f.trigger}</span></td>
                <td><span className="pill neutral">{f.goal}</span></td>
                <td className="num tabular">{f.active}</td>
                <td className="num tabular">{f.sends7d}</td>
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
