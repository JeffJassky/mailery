/* Flow detail — vertical step builder */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { sample } from '../lib/mock'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'

const FALLBACK_STEPS = [
  { kind: 'wait', label: 'Wait', meta: '1 day', icon: 'Clock', iconClass: 'wait' },
  { kind: 'condition', label: "If: not fired 'Activated app'", meta: 'Skip if user has already activated', icon: 'Branch', iconClass: 'condition' },
  { kind: 'send', label: 'Send · Try a starter storyboard', meta: 'templates/activation-rescue-1 · marketing', icon: 'Mail', iconClass: 'send', sends: 142, opens: '61%', clicks: '18%' },
  { kind: 'wait', label: 'Wait', meta: '3 days', icon: 'Clock', iconClass: 'wait' },
  { kind: 'branch', label: 'Branch: opened previous email?', meta: 'Two paths', icon: 'Branch', iconClass: 'condition' },
  { kind: 'tag', label: "Tag · add 'engaged-rescue'", meta: 'Routed through host adapter', icon: 'Tag', iconClass: 'tag' },
  { kind: 'exit', label: 'Exit', meta: 'Goal reached', icon: 'Exit', iconClass: 'exit' },
]

export function FlowDetail({ slug = 'activation-rescue' }: any) {
  const fallbackFlow = sample.flows.find((f) => f.slug === slug) ?? sample.flows[1]!
  const { data: flow } = useLive(() => api.flow(slug), fallbackFlow as any)

  const steps = stepsToCanvas((flow as any)?.steps ?? (flow as any)?.draft?.steps ?? [])
  const canvas = steps.length > 0 ? steps : FALLBACK_STEPS
  const [selectedStep, setSelectedStep] = React.useState(0)
  const [tab, setTab] = React.useState('editor')

  const StepIcon = ({ name }: { name: string }) => {
    const I = (Icons as any)[name] || Icons.Mail
    return <I size={18} />
  }

  const version = (flow as any).version ?? 1
  const active = (flow as any).active ?? (flow as any).stats?.activeRuns ?? 0
  const sends7d = (flow as any).sends7d ?? (flow as any).stats?.sendsLast7Days ?? 0
  const completed = (flow as any).stats?.completedRuns ?? 0
  const triggerName = (flow as any).trigger?.eventName ?? 'event'

  return (
    <>
      <PageHead
        title={(flow as any).name ?? slug}
        desc={<span className="mono">flows/{(flow as any).slug ?? slug}</span>}
        actions={
          <>
            <span className={'pill ' + ((flow as any).enabled ? 'green' : 'neutral')}><span className="dot" />{(flow as any).enabled ? 'Enabled' : 'Disabled'}</span>
            <button className="btn"><Icons.Pause size={14} />Pause</button>
            <button className="btn"><Icons.Code size={14} />View JSON</button>
            <button className="btn btn-primary"><Icons.Rocket size={14} />Publish draft</button>
          </>
        }
      />

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Active runs</div><div className="kpi-value">{active}</div><div className="kpi-meta subtle">Right now</div></div>
        <div className="kpi"><div className="kpi-label">Sends · 7d</div><div className="kpi-value">{sends7d}</div></div>
        <div className="kpi"><div className="kpi-label">Completed runs</div><div className="kpi-value">{completed.toLocaleString()}</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Version</div><div className="kpi-value">v{version}</div>{(flow as any).draft && <div className="kpi-meta"><span className="pill amber"><span className="dot" />Draft v{version + 1}</span></div>}</div>
      </div>

      <div className="tabs">
        <div className={'tab' + (tab === 'editor' ? ' active' : '')} onClick={() => setTab('editor')}>Editor</div>
        <div className={'tab' + (tab === 'runs' ? ' active' : '')} onClick={() => setTab('runs')}>Active runs<span className="tab-count">{active}</span></div>
        <div className={'tab' + (tab === 'history' ? ' active' : '')} onClick={() => setTab('history')}>History</div>
        <div className={'tab' + (tab === 'settings' ? ' active' : '')} onClick={() => setTab('settings')}>Settings</div>
      </div>

      <div className="split split-asym">
        <div className="card">
          <div className="card-head">
            <span className="card-title">Steps</span>
            <span className="card-sub">{canvas.length} steps · pinned to v{version} for in-flight runs</span>
            <div className="card-actions">
              <div className="seg">
                <span className="seg-item active">Visual</span>
                <span className="seg-item">JSON</span>
              </div>
            </div>
          </div>
          <div className="flow-canvas">
            <div className="flow-trigger">
              <div className="flow-trigger-icon"><Icons.Rocket size={16} /></div>
              <div>
                <div className="flow-trigger-label">Trigger</div>
                <div className="flow-trigger-name">Event · "{triggerName}"</div>
                <div className="flow-trigger-meta">Once per contact · {active} entered recently</div>
              </div>
            </div>
            <div className="flow-connector" />

            {canvas.map((s, i) => (
              <React.Fragment key={i}>
                <div className={'flow-step ' + s.iconClass + (selectedStep === i ? ' selected' : '')} onClick={() => setSelectedStep(i)}>
                  <div className="flow-step-icon"><StepIcon name={s.icon} /></div>
                  <div className="flow-step-body">
                    <div className="flow-step-kind">{s.kind}</div>
                    <div className="flow-step-title">{s.label}</div>
                    <div className="flow-step-meta">{s.meta}</div>
                  </div>
                  {s.sends != null && (
                    <div className="flow-step-aside">
                      <div className="flow-step-aside-num">{s.sends}</div>
                      <div>sent</div>
                      <div style={{ marginTop: 4 }}>opens {s.opens}</div>
                      <div>clicks {s.clicks}</div>
                    </div>
                  )}
                </div>
                <div style={{ position: 'relative', height: 24, display: 'flex', alignItems: 'center', flexDirection: 'column' }}>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                    <div className="flow-connector" style={{ height: 24 }} />
                  </div>
                  <div className="flow-add" title="Insert step"><Icons.Plus size={14} /></div>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Step settings</span>
            <span className="card-sub">Step {selectedStep + 1}</span>
          </div>
          <div className="card-body">
            <div className="text-xs subtle">Step type</div>
            <div className="seg" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', margin: '6px 0 16px' }}>
              <span className="seg-item">Wait</span>
              <span className="seg-item active">Send</span>
              <span className="seg-item">Branch</span>
              <span className="seg-item">Tag</span>
            </div>
            <div className="field-hint">Detail editor lands in a later release. For now, edit flow JSON directly in MongoDB.</div>
          </div>
        </div>
      </div>
    </>
  )
}

function stepsToCanvas(steps: any[]): Array<{ kind: string; label: string; meta: string; icon: string; iconClass: string; sends?: number; opens?: string; clicks?: string }> {
  if (!Array.isArray(steps)) return []
  return steps.map((s) => {
    switch (s.type) {
      case 'wait':
        return { kind: 'wait', label: 'Wait', meta: `${s.value} ${s.unit}`, icon: 'Clock', iconClass: 'wait' }
      case 'condition':
        return { kind: 'condition', label: 'Condition', meta: `if false: ${s.ifFalse}`, icon: 'Branch', iconClass: 'condition' }
      case 'branch':
        return { kind: 'branch', label: 'Branch', meta: 'Two paths', icon: 'Branch', iconClass: 'condition' }
      case 'send':
        return { kind: 'send', label: `Send · ${s.templateSlug}`, meta: s.providerOverride ? `via ${s.providerOverride}` : 'default provider', icon: 'Mail', iconClass: 'send' }
      case 'tag':
        return { kind: 'tag', label: 'Tag', meta: [...(s.addTags ?? []).map((t: string) => `+${t}`), ...(s.removeTags ?? []).map((t: string) => `-${t}`)].join(', ') || '—', icon: 'Tag', iconClass: 'tag' }
      case 'fire_event':
        return { kind: 'fire_event', label: `Fire · ${s.eventName}`, meta: 'synthetic event', icon: 'Activity', iconClass: 'send' }
      case 'webhook':
        return { kind: 'webhook', label: 'Webhook', meta: s.url, icon: 'Webhook', iconClass: 'tag' }
      case 'exit':
        return { kind: 'exit', label: 'Exit', meta: s.reason ?? '—', icon: 'Exit', iconClass: 'exit' }
      default:
        return { kind: 'unknown', label: 'Unknown step', meta: JSON.stringify(s).slice(0, 60), icon: 'Mail', iconClass: 'send' }
    }
  })
}
