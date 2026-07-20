/* Flow detail — visual step editor */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState } from '../lib/load-state'
import {
  FLOW_STEP_KINDS,
  defaultFlowStep,
  PREDICATE_KINDS,
  defaultPredicate,
  predicateKind,
  type PredicateKind,
} from '../../shared/options.js'

type FlowStep = any

const STEP_TYPES = FLOW_STEP_KINDS

function summarizeStep(
  s: FlowStep,
  templatesBySlug?: Map<string, any>,
): { kind: string; label: string; meta: string; sub?: string; icon: string; iconClass: string } {
  const def = STEP_TYPES.find((t) => t.value === s.type) ?? STEP_TYPES[STEP_TYPES.length - 1]!
  let label = def.label
  let meta = ''
  let sub: string | undefined
  switch (s.type) {
    case 'wait':
      meta = `${s.value} ${s.unit}`
      break
    case 'condition':
      label = 'If: ' + (predicateSummary(s.test) || 'predicate')
      meta = `if false: ${s.ifFalse}`
      break
    case 'branch':
      label = 'Branch: ' + (predicateSummary(s.test) || 'predicate')
      meta = `${(s.ifTrueSteps ?? []).length} true / ${(s.ifFalseSteps ?? []).length} false`
      break
    case 'send': {
      const tpl = s.templateSlug ? templatesBySlug?.get(s.templateSlug) : undefined
      const subject = tpl?.draft?.subject || tpl?.subject
      const kind = tpl?.kind
      if (subject) {
        label = subject
        meta = [s.templateSlug, kind].filter(Boolean).join(' · ')
        const preheader = tpl?.draft?.preheader || tpl?.preheader
        const plain = tpl?.body?.plainText
        const tail = (preheader || plain || '').replace(/\s+/g, ' ').trim()
        if (tail) sub = tail.length > 80 ? tail.slice(0, 80) + '…' : tail
      } else if (s.templateSlug) {
        label = `Send · ${s.templateSlug}`
        meta = s.providerOverride ? `via ${s.providerOverride}` : 'default provider'
      } else {
        label = 'Send · (no template)'
        meta = s.providerOverride ? `via ${s.providerOverride}` : 'default provider'
      }
      break
    }
    case 'tag':
      meta = [...(s.addTags ?? []).map((t: string) => `+${t}`), ...(s.removeTags ?? []).map((t: string) => `-${t}`)].join(', ') || '—'
      break
    case 'fire_event':
      label = `Fire · ${s.eventName || '(empty)'}`
      meta = 'synthetic event'
      break
    case 'webhook':
      meta = s.url || '(no url)'
      break
    case 'exit':
      meta = s.reason ?? '—'
      break
  }
  return { kind: def.value, label, meta, sub, icon: def.icon, iconClass: def.iconClass }
}

function predicateSummary(p: any): string {
  if (!p) return ''
  if ('hasTag' in p) return `has tag "${p.hasTag}"`
  if ('notHasTag' in p) return `not tag "${p.notHasTag}"`
  if ('hasFiredEvent' in p) return `fired "${p.hasFiredEvent}"`
  if ('notHasFiredEvent' in p) return `not fired "${p.notHasFiredEvent}"`
  if ('fieldEquals' in p) return `${p.fieldEquals.field} = ${JSON.stringify(p.fieldEquals.value)}`
  if ('subscriptionStatus' in p) return `subscription = ${p.subscriptionStatus}`
  if ('all' in p) return `all of ${p.all.length}`
  if ('any' in p) return `any of ${p.any.length}`
  if ('not' in p) return `not (…)`
  return 'predicate'
}

function EventTriggerInput({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { data } = useLive(() => api.events())
  const registered = data?.registered ?? []
  const seen = data?.seen ?? []
  const policy = registered.find((r) => r.name === value)?.dedupePolicy
  const listId = 'event-trigger-options'
  return (
    <div style={{ flex: 1 }}>
      <input
        className="input"
        list={listId}
        style={{ width: '100%', padding: '4px 8px', fontSize: 13 }}
        placeholder="Created"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {registered.map((r) => (
          <option key={`r:${r.name}`} value={r.name}>
            registered · {r.dedupePolicy}
          </option>
        ))}
        {seen.map((n) => (
          <option key={`s:${n}`} value={n}>
            seen in mailer_events (unregistered)
          </option>
        ))}
      </datalist>
      {value && (
        <div className="text-xs subtle" style={{ marginTop: 4 }}>
          {policy
            ? <>Registered · dedupe <span className="mono">{policy}</span></>
            : <>Not registered. Trigger still fires; call <span className="mono">mailer.registerEvent</span> to declare a dedupe policy.</>}
        </div>
      )}
    </div>
  )
}

export function FlowDetail({ slug, setRoute }: any) {
  const { data: flow, loading, error, refetch } = useLive(() => api.flow(slug), [slug])

  if (loading && !flow) {
    return <LoadState loading error={null} empty={false}><></></LoadState>
  }
  if (error || !flow) {
    return <LoadState loading={false} error={error} empty={!flow} emptyLabel="Flow not found." retry={refetch}><></></LoadState>
  }
  return <FlowEditor slug={slug} flow={flow} refetch={refetch} setRoute={setRoute} />
}

function FlowEditor({ slug, flow, refetch, setRoute }: { slug: string; flow: any; refetch: () => void; setRoute: any }) {
  const { data: templates } = useLive(() => api.templates())
  const templatesBySlug = React.useMemo(() => {
    const m = new Map<string, any>()
    for (const t of templates ?? []) m.set(t.slug, t)
    return m
  }, [templates])
  const [steps, setSteps] = React.useState<FlowStep[]>([])
  const [trigger, setTrigger] = React.useState<{ eventName: string; once: boolean }>({ eventName: '', once: true })
  const [selectedIdx, setSelectedIdx] = React.useState(0)
  const [dirty, setDirty] = React.useState(false)
  const [saveStatus, setSaveStatus] = React.useState<string | null>(null)
  const [showAddPicker, setShowAddPicker] = React.useState<number | null>(null)

  // Hydrate state from live flow on load / refetch.
  React.useEffect(() => {
    if (!flow) return
    const incoming = flow?.draft?.steps ?? flow?.steps ?? []
    setSteps(Array.isArray(incoming) ? incoming : [])
    if (flow?.trigger?.eventName) {
      setTrigger({ eventName: flow.trigger.eventName, once: flow.trigger.once !== false })
    }
    setDirty(false)
  }, [flow])

  function insertStep(at: number, type: string) {
    const newStep = defaultFlowStep(type as any)
    const next = [...steps.slice(0, at), newStep, ...steps.slice(at)]
    setSteps(next)
    setSelectedIdx(at)
    setShowAddPicker(null)
    setDirty(true)
  }

  function deleteStep(at: number) {
    const next = steps.filter((_, i) => i !== at)
    setSteps(next)
    setSelectedIdx(Math.min(at, next.length - 1))
    setDirty(true)
  }

  function updateStep(at: number, patch: Partial<FlowStep>) {
    setSteps(steps.map((s, i) => (i === at ? { ...s, ...patch } : s)))
    setDirty(true)
  }

  function moveStep(at: number, dir: -1 | 1) {
    const j = at + dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[at], next[j]] = [next[j]!, next[at]!]
    setSteps(next)
    setSelectedIdx(j)
    setDirty(true)
  }

  async function saveDraft() {
    setSaveStatus('Saving…')
    try {
      await api.updateFlowDraft(slug, {
        steps,
        trigger: { eventName: trigger.eventName, once: trigger.once },
      })
      setDirty(false)
      setSaveStatus('Saved')
      refetch()
    } catch (err: any) {
      setSaveStatus(`Save failed: ${err?.message ?? err}`)
    }
  }

  async function publish() {
    if (dirty) await saveDraft().catch(() => {})
    setSaveStatus('Publishing…')
    try {
      const res = await api.publishFlow(slug)
      setSaveStatus(`Published v${res.version}`)
      refetch()
    } catch (err: any) {
      setSaveStatus(`Publish failed: ${err?.message ?? err}`)
    }
  }

  async function togglePauseResume() {
    try {
      if (flow.enabled) await api.pauseFlow(slug)
      else await api.resumeFlow(slug)
      refetch()
    } catch (err: any) {
      setSaveStatus(`${err?.message ?? err}`)
    }
  }

  const version = flow.version ?? 1
  const active = flow.active ?? flow.stats?.activeRuns ?? 0
  const sends7d = flow.sends7d ?? flow.stats?.sendsLast7Days ?? 0
  const completed = flow.stats?.completedRuns ?? 0
  const selected = steps[selectedIdx] ?? null
  const StepIcon = ({ name }: { name: string }) => {
    const I = (Icons as any)[name] || Icons.Mail
    return <I size={18} />
  }
  void setRoute

  return (
    <>
      <PageHead
        title={flow.name ?? slug}
        desc={<span className="mono">flows/{flow.slug ?? slug}</span>}
        actions={
          <>
            <span className={'pill ' + (flow.enabled ? 'green' : 'neutral')}><span className="dot" />{flow.enabled ? 'Enabled' : 'Disabled'}</span>
            <button className="btn" onClick={togglePauseResume}>
              {flow.enabled ? <><Icons.Pause size={14} />Pause</> : <><Icons.Play size={14} />Resume</>}
            </button>
            <button className="btn" onClick={saveDraft} disabled={!dirty}><Icons.Copy size={14} />Save draft</button>
            <button className="btn btn-primary" onClick={publish}><Icons.Rocket size={14} />Publish</button>
          </>
        }
      />

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Active runs</div><div className="kpi-value">{active}</div><div className="kpi-meta subtle">Right now</div></div>
        <div className="kpi"><div className="kpi-label">Sends · 7d</div><div className="kpi-value">{sends7d}</div></div>
        <div className="kpi"><div className="kpi-label">Completed runs</div><div className="kpi-value">{Number(completed).toLocaleString()}</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi">
          <div className="kpi-label">Version</div>
          <div className="kpi-value">v{version}</div>
          <div className="kpi-meta">{saveStatus ? <span className="text-xs">{saveStatus}</span> : (dirty ? <span className="pill amber"><span className="dot" />Unsaved</span> : null)}</div>
        </div>
      </div>

      <div className="split split-asym">
        <div className="card">
          <div className="card-head">
            <span className="card-title">Steps</span>
            <span className="card-sub">{steps.length} steps · click to edit</span>
          </div>
          <div className="flow-canvas">
            <div className="flow-trigger">
              <div className="flow-trigger-icon"><Icons.Rocket size={16} /></div>
              <div style={{ flex: 1 }}>
                <div className="flow-trigger-label">Trigger</div>
                <div className="hstack" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <span className="flow-trigger-name" style={{ paddingTop: 6 }}>Event ·</span>
                  <EventTriggerInput
                    value={trigger.eventName}
                    onChange={(v) => { setTrigger({ ...trigger, eventName: v }); setDirty(true) }}
                  />
                </div>
                <div className="flow-trigger-meta">
                  <label className="hstack" style={{ gap: 6, marginTop: 6 }}>
                    <input type="checkbox" checked={trigger.once} onChange={(e) => { setTrigger({ ...trigger, once: e.target.checked }); setDirty(true) }} />
                    <span className="text-xs">Once per contact</span>
                  </label>
                </div>
              </div>
            </div>

            <AddStepButton onPick={(t) => insertStep(0, t)} expanded={showAddPicker === 0} setExpanded={(b) => setShowAddPicker(b ? 0 : null)} />

            {steps.map((s, i) => {
              const summary = summarizeStep(s, templatesBySlug)
              return (
                <React.Fragment key={i}>
                  <div className={'flow-step ' + summary.iconClass + (selectedIdx === i ? ' selected' : '')} onClick={() => setSelectedIdx(i)}>
                    <div className="flow-step-icon"><StepIcon name={summary.icon} /></div>
                    <div className="flow-step-body">
                      <div className="flow-step-kind">{summary.kind}</div>
                      <div className="flow-step-title">{summary.label}</div>
                      <div className="flow-step-meta">{summary.meta}</div>
                      {summary.sub && <div className="flow-step-meta subtle" style={{ marginTop: 2 }}>{summary.sub}</div>}
                    </div>
                    <div className="flow-step-aside" style={{ alignItems: 'center', gap: 4 }}>
                      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); moveStep(i, -1) }} title="Move up"><Icons.Chevron size={12} style={{ transform: 'rotate(-90deg)' }} /></button>
                      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); moveStep(i, 1) }} title="Move down"><Icons.Chevron size={12} style={{ transform: 'rotate(90deg)' }} /></button>
                    </div>
                  </div>
                  <AddStepButton onPick={(t) => insertStep(i + 1, t)} expanded={showAddPicker === i + 1} setExpanded={(b) => setShowAddPicker(b ? i + 1 : null)} />
                </React.Fragment>
              )
            })}

            {steps.length === 0 && (
              <div className="text-xs subtle" style={{ padding: 16, textAlign: 'center' }}>
                Empty flow. Add your first step above.
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Step settings</span>
            <span className="card-sub">{selected ? `Step ${selectedIdx + 1} · ${selected.type}` : 'Select a step'}</span>
            {selected && (
              <div className="card-actions">
                <button className="btn btn-sm btn-danger" onClick={() => deleteStep(selectedIdx)}><Icons.X size={12} />Delete</button>
              </div>
            )}
          </div>
          <div className="card-body">
            {selected ? (
              <StepEditor step={selected} onChange={(patch) => updateStep(selectedIdx, patch)} />
            ) : (
              <div className="text-xs subtle">Click a step in the canvas to edit it, or use the + button to add one.</div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function AddStepButton({ onPick, expanded, setExpanded }: { onPick: (t: string) => void; expanded: boolean; setExpanded: (b: boolean) => void }) {
  return (
    <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
      <div className="flow-connector" style={{ height: 16 }} />
      {expanded ? (
        <div className="card" style={{ padding: 8, display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 480, marginBottom: 8 }}>
          {STEP_TYPES.map((t) => (
            <button key={t.value} className="btn btn-sm" onClick={() => onPick(t.value)}>{t.label}</button>
          ))}
          <button className="btn btn-sm btn-ghost" onClick={() => setExpanded(false)}>Cancel</button>
        </div>
      ) : (
        <button className="flow-add" onClick={() => setExpanded(true)} title="Insert step"><Icons.Plus size={14} /></button>
      )}
      <div className="flow-connector" style={{ height: 16 }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-type step editors
// ---------------------------------------------------------------------------

function StepEditor({ step, onChange }: { step: FlowStep; onChange: (patch: Partial<FlowStep>) => void }) {
  switch (step.type) {
    case 'wait':
      return (
        <div className="field">
          <label className="field-label">Wait duration</label>
          <div className="hstack" style={{ gap: 8 }}>
            <input
              className="input"
              type="number"
              min={1}
              style={{ width: 100 }}
              value={step.value}
              onChange={(e) => onChange({ value: Math.max(1, Number(e.target.value)) })}
            />
            <select
              className="select"
              value={step.unit}
              onChange={(e) => onChange({ unit: e.target.value })}
              style={{ flex: 1 }}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
          </div>
          <div className="field-hint">The runner schedules a delayed wakeup; no CPU until then.</div>
        </div>
      )

    case 'condition':
      return (
        <>
          <div className="field">
            <label className="field-label">If predicate is FALSE</label>
            <div className="seg">
              <span className={'seg-item' + (step.ifFalse === 'exit' ? ' active' : '')} onClick={() => onChange({ ifFalse: 'exit' })}>Exit the run</span>
              <span className={'seg-item' + (step.ifFalse === 'continue' ? ' active' : '')} onClick={() => onChange({ ifFalse: 'continue' })}>Skip next step</span>
            </div>
          </div>
          <PredicateEditor predicate={step.test} onChange={(test) => onChange({ test })} />
        </>
      )

    case 'branch':
      return (
        <>
          <div className="field">
            <label className="field-label">Predicate (JSON)</label>
            <JsonTextarea
              value={step.test}
              onChange={(v) => onChange({ test: v })}
            />
          </div>
          <div className="field">
            <label className="field-label">If TRUE — steps (JSON array)</label>
            <JsonTextarea
              value={step.ifTrueSteps ?? []}
              onChange={(v) => onChange({ ifTrueSteps: v })}
            />
          </div>
          <div className="field">
            <label className="field-label">If FALSE — steps (JSON array)</label>
            <JsonTextarea
              value={step.ifFalseSteps ?? []}
              onChange={(v) => onChange({ ifFalseSteps: v })}
            />
          </div>
          <div className="field-hint">Branch's nested step arrays are edited as JSON. For typical two-arm logic, prefer a <span className="mono">condition</span> step with <span className="mono">ifFalse: 'exit'</span>.</div>
        </>
      )

    case 'send':
      return <SendStepEditor step={step} onChange={onChange} />


    case 'tag':
      return (
        <>
          <div className="field">
            <label className="field-label">Tags to ADD</label>
            <input
              className="input"
              placeholder="engaged, vip (comma-separated)"
              value={(step.addTags ?? []).join(', ')}
              onChange={(e) => onChange({ addTags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
            />
          </div>
          <div className="field">
            <label className="field-label">Tags to REMOVE</label>
            <input
              className="input"
              placeholder="new-signup, cold"
              value={(step.removeTags ?? []).join(', ')}
              onChange={(e) => onChange({ removeTags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
            />
          </div>
          <div className="field-hint">Routes through your adapter's <span className="mono">addTags</span> / <span className="mono">removeTags</span> if defined, else mailer's tag collection.</div>
        </>
      )

    case 'fire_event':
      return (
        <>
          <div className="field">
            <label className="field-label">Event name</label>
            <input
              className="input"
              placeholder="Engaged via flow"
              value={step.eventName ?? ''}
              onChange={(e) => onChange({ eventName: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">Properties (JSON, optional)</label>
            <JsonTextarea
              value={step.properties ?? {}}
              onChange={(v) => onChange({ properties: v })}
              minHeight={60}
            />
          </div>
        </>
      )

    case 'webhook':
      return (
        <>
          <div className="field">
            <label className="field-label">URL</label>
            <input
              className="input"
              placeholder="https://analytics.example/event"
              value={step.url ?? ''}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">Method</label>
            <select className="select" value={step.method ?? 'POST'} onChange={(e) => onChange({ method: e.target.value })}>
              <option>POST</option>
              <option>PUT</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label">Payload (JSON, optional)</label>
            <JsonTextarea
              value={step.payload ?? {}}
              onChange={(v) => onChange({ payload: v })}
              minHeight={60}
            />
            <div className="field-hint">If blank, mailer sends <span className="mono">{'{ externalId, flowRunId }'}</span>.</div>
          </div>
          <div className="field">
            <label className="field-label">On failure</label>
            <select className="select" value={step.failureMode ?? 'soft'} onChange={(e) => onChange({ failureMode: e.target.value })}>
              <option value="soft">Log + continue (default)</option>
              <option value="fail_run">Fail the flow run</option>
            </select>
          </div>
        </>
      )

    case 'exit':
      return (
        <div className="field">
          <label className="field-label">Exit reason (optional)</label>
          <input
            className="input"
            placeholder="goal_reached"
            value={step.reason ?? ''}
            onChange={(e) => onChange({ reason: e.target.value })}
          />
          <div className="field-hint">Recorded on the flow_run for filtering exited runs by reason.</div>
        </div>
      )

    default:
      return <div className="text-xs subtle">Unknown step type: {step.type}</div>
  }
}

// ---------------------------------------------------------------------------
// Predicate editor (handles common cases visually; falls back to JSON)
// ---------------------------------------------------------------------------

function PredicateEditor({ predicate, onChange }: { predicate: any; onChange: (p: any) => void }) {
  const kind: PredicateKind | '__json' = predicateKind(predicate) ?? '__json'
  const setKind = (k: string) => {
    if (k === '__json') onChange(predicate)
    else onChange(defaultPredicate(k as PredicateKind))
  }

  return (
    <div className="field">
      <label className="field-label">Predicate</label>
      <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} style={{ marginBottom: 8 }}>
        {PREDICATE_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}{k.noisy ? ' (noisy)' : ''}
          </option>
        ))}
        <option value="__json">raw JSON (advanced)</option>
      </select>

      {kind === 'hasTag' && (
        <input className="input" placeholder="vip" value={predicate.hasTag ?? ''} onChange={(e) => onChange({ hasTag: e.target.value })} />
      )}
      {kind === 'notHasTag' && (
        <input className="input" placeholder="cold" value={predicate.notHasTag ?? ''} onChange={(e) => onChange({ notHasTag: e.target.value })} />
      )}
      {kind === 'fieldEquals' && (
        <div className="hstack" style={{ gap: 8 }}>
          <input className="input" placeholder="field" style={{ flex: 1 }} value={predicate.fieldEquals?.field ?? ''} onChange={(e) => onChange({ fieldEquals: { field: e.target.value, value: predicate.fieldEquals?.value } })} />
          <input className="input" placeholder="value" style={{ flex: 1 }} value={String(predicate.fieldEquals?.value ?? '')} onChange={(e) => onChange({ fieldEquals: { field: predicate.fieldEquals?.field, value: e.target.value } })} />
        </div>
      )}
      {kind === 'fieldExists' && (
        <input className="input" placeholder="customerType" value={predicate.fieldExists ?? ''} onChange={(e) => onChange({ fieldExists: e.target.value })} />
      )}
      {(kind === 'hasFiredEvent' || kind === 'notHasFiredEvent') && (
        <input
          className="input"
          placeholder="Activated app"
          value={(kind === 'hasFiredEvent' ? predicate.hasFiredEvent : predicate.notHasFiredEvent) ?? ''}
          onChange={(e) => onChange({ [kind]: e.target.value })}
        />
      )}
      {kind === 'subscriptionStatus' && (
        <select className="select" value={predicate.subscriptionStatus} onChange={(e) => onChange({ subscriptionStatus: e.target.value })}>
          <option>subscribed</option>
          <option>unsubscribed</option>
          <option>pending_doi</option>
          <option>bounced</option>
          <option>complained</option>
        </select>
      )}
      {(kind === 'hasOpenedExcludingBots' || kind === 'hasClickedExcludingBots') && (
        <div className="vstack" style={{ gap: 6 }}>
          <input className="input" placeholder="Template slug (optional)" value={(predicate[kind] as any).templateSlug ?? ''} onChange={(e) => onChange({ [kind]: { ...predicate[kind], templateSlug: e.target.value || undefined } })} />
          <label className="hstack" style={{ gap: 6 }}>
            <input type="checkbox" checked={(predicate[kind] as any).sinceFlowStart === true} onChange={(e) => onChange({ [kind]: { ...predicate[kind], sinceFlowStart: e.target.checked || undefined } })} />
            <span className="text-xs">Since this flow run started</span>
          </label>
          <input className="input" placeholder="Within days (optional)" type="number" value={(predicate[kind] as any).withinDays ?? ''} onChange={(e) => onChange({ [kind]: { ...predicate[kind], withinDays: Number(e.target.value) || undefined } })} />
        </div>
      )}
      {(kind === 'openedAtLeastN' || kind === 'clickedAtLeastN') && (
        <div className="hstack" style={{ gap: 8 }}>
          <input className="input" type="number" min={1} style={{ flex: 1 }} placeholder="count" value={(predicate[kind] as any).count ?? 1} onChange={(e) => onChange({ [kind]: { ...predicate[kind], count: Math.max(1, Number(e.target.value)) } })} />
          <input className="input" type="number" min={1} style={{ flex: 1 }} placeholder="within days" value={(predicate[kind] as any).withinDays ?? 7} onChange={(e) => onChange({ [kind]: { ...predicate[kind], withinDays: Math.max(1, Number(e.target.value)) } })} />
        </div>
      )}
      {kind === '__json' && (
        <JsonTextarea value={predicate} onChange={(v) => onChange(v as any)} />
      )}
    </div>
  )
}

/**
 * JSON textarea with inline parse-error display. Replaces the old
 * silently-swallowing onBlur pattern so the operator sees when their JSON
 * doesn't actually save.
 */
function JsonTextarea({
  value,
  onChange,
  minHeight = 80,
}: {
  value: unknown
  onChange: (parsed: any) => void
  minHeight?: number
}) {
  const [text, setText] = React.useState(() => JSON.stringify(value, null, 2))
  const [err, setErr] = React.useState<string | null>(null)
  const externalRef = React.useRef(JSON.stringify(value))

  // Re-sync on external value change (parent state replaced).
  React.useEffect(() => {
    const next = JSON.stringify(value)
    if (next !== externalRef.current) {
      externalRef.current = next
      setText(JSON.stringify(value, null, 2))
      setErr(null)
    }
  }, [value])

  function commit() {
    try {
      const parsed = JSON.parse(text)
      setErr(null)
      externalRef.current = JSON.stringify(parsed)
      onChange(parsed)
    } catch (e: any) {
      setErr(e?.message ?? 'invalid JSON')
    }
  }

  return (
    <>
      <textarea
        className={'input' + (err ? ' input-error' : '')}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12, minHeight, borderColor: err ? 'var(--red-fg)' : undefined }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
      {err && (
        <div className="field-hint" style={{ color: 'var(--red-fg)' }}>
          JSON not saved — {err}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Send-step editor with Config / Preview tabs
// ---------------------------------------------------------------------------

function SendStepEditor({ step, onChange }: { step: FlowStep; onChange: (patch: Partial<FlowStep>) => void }) {
  const [tab, setTab] = React.useState<'config' | 'preview'>('config')
  return (
    <>
      <div className="seg" style={{ marginBottom: 12 }}>
        <span className={'seg-item' + (tab === 'config' ? ' active' : '')} onClick={() => setTab('config')}>Config</span>
        <span className={'seg-item' + (tab === 'preview' ? ' active' : '')} onClick={() => setTab('preview')}>Preview</span>
      </div>
      {tab === 'config' ? (
        <>
          <div className="field">
            <label className="field-label">Template</label>
            <TemplatePicker value={step.templateSlug} onChange={(v) => onChange({ templateSlug: v })} />
          </div>
          <div className="field">
            <label className="field-label">Provider override</label>
            <input
              className="input"
              placeholder="(use default)"
              value={step.providerOverride ?? ''}
              onChange={(e) => onChange({ providerOverride: e.target.value || undefined })}
            />
            <div className="field-hint">Leave blank to use the default provider for this template's kind.</div>
          </div>
          <div className="field">
            <label className="field-label">Vars (JSON, optional)</label>
            <JsonTextarea
              value={step.vars ?? {}}
              onChange={(v) => onChange({ vars: v as any })}
              minHeight={60}
            />
            <div className="field-hint">Per-step variables available in the template as <span className="mono">{'{{vars.x}}'}</span>.</div>
          </div>
          <DeliveryWindowEditor
            value={step.delivery}
            onChange={(delivery) => onChange({ delivery } as Partial<FlowStep>)}
          />
        </>
      ) : (
        <SendStepPreview templateSlug={step.templateSlug} vars={step.vars} />
      )}
    </>
  )
}

type DeliveryWindowValue = {
  weekdaysOnly?: boolean
  timeOfDay?: string
  useContactTimezone?: boolean
  timezone?: string
}

function DeliveryWindowEditor({
  value,
  onChange,
}: {
  value: DeliveryWindowValue | undefined
  onChange: (v: DeliveryWindowValue | undefined) => void
}) {
  const v = value ?? {}

  function patch(p: Partial<DeliveryWindowValue>) {
    const next = { ...v, ...p }
    // Drop falsy/empty keys; an all-empty window means "no constraints".
    if (!next.weekdaysOnly) delete next.weekdaysOnly
    if (!next.timeOfDay) delete next.timeOfDay
    if (!next.useContactTimezone) delete next.useContactTimezone
    if (!next.timezone) delete next.timezone
    onChange(Object.keys(next).length > 0 ? next : undefined)
  }

  return (
    <div className="field">
      <label className="field-label">Delivery window</label>
      <div className="vstack" style={{ gap: 8 }}>
        <label className="hstack text-sm" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!v.weekdaysOnly}
            onChange={(e) => patch({ weekdaysOnly: e.target.checked })}
          />
          Weekdays only — a send landing on Sat/Sun waits until Monday
        </label>
        <div className="hstack" style={{ gap: 8, alignItems: 'center' }}>
          <span className="text-sm" style={{ minWidth: 90 }}>Time of day</span>
          <input
            className="input"
            type="time"
            style={{ width: 130 }}
            value={v.timeOfDay ?? ''}
            onChange={(e) => patch({ timeOfDay: e.target.value || undefined })}
          />
          {v.timeOfDay && (
            <button className="btn btn-xs" onClick={() => patch({ timeOfDay: undefined })}>Clear</button>
          )}
        </div>
        <label className="hstack text-sm" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!v.useContactTimezone}
            onChange={(e) => patch({ useContactTimezone: e.target.checked })}
          />
          Use the contact's timezone when known
        </label>
        <div className="hstack" style={{ gap: 8, alignItems: 'center' }}>
          <span className="text-sm" style={{ minWidth: 90 }}>Fallback zone</span>
          <input
            className="input"
            placeholder="UTC"
            style={{ width: 220 }}
            value={v.timezone ?? ''}
            onChange={(e) => patch({ timezone: e.target.value || undefined })}
          />
        </div>
      </div>
      <div className="field-hint">
        Times are interpreted in the contact's timezone (when enabled and known), else the fallback IANA zone, else UTC. The window only delays sends — never moves them earlier.
      </div>
    </div>
  )
}

function SendStepPreview({ templateSlug, vars }: { templateSlug?: string; vars?: any }) {
  const [data, setData] = React.useState<{ subject: string; preheader: string; html: string; plainText: string } | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  // Stringify outside the deps so the React lint rule sees a stable
  // primitive — and the latest vars object stays accessible via ref.
  const varsKey = JSON.stringify(vars ?? {})
  const varsRef = React.useRef(vars)
  varsRef.current = vars

  React.useEffect(() => {
    if (!templateSlug) { setData(null); setErr(null); return }
    let cancelled = false
    setLoading(true)
    setErr(null)
    api
      .previewTemplate(templateSlug, { useDraft: true, vars: varsRef.current ?? {} })
      .then((out) => { if (!cancelled) setData(out) })
      .catch((e) => { if (!cancelled) setErr(String(e?.message ?? e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [templateSlug, varsKey])

  if (!templateSlug) {
    return <div className="text-xs subtle">Pick a template in the Config tab to see a preview.</div>
  }
  if (loading && !data) return <div className="text-xs subtle">Rendering preview…</div>
  if (err) return <div className="text-xs" style={{ color: 'var(--red-fg)' }}>Preview failed: {err}</div>
  if (!data) return null
  return (
    <div className="vstack" style={{ gap: 8 }}>
      <div>
        <div className="text-sm f500">{data.subject}</div>
        <div className="text-xs subtle">{data.preheader}</div>
      </div>
      <iframe
        title="send-preview"
        sandbox=""
        srcDoc={data.html}
        style={{ width: '100%', minHeight: 480, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Template picker
// ---------------------------------------------------------------------------

function TemplatePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: templates } = useLive(() => api.templates())

  if (!templates || templates.length === 0) {
    return <input className="input" placeholder="welcome-1" value={value} onChange={(e) => onChange(e.target.value)} />
  }

  const matched = templates.find((t: any) => t.slug === value)
  return (
    <>
      <select className="select" value={matched ? value : '__custom'} onChange={(e) => onChange(e.target.value === '__custom' ? value : e.target.value)}>
        {templates.map((t: any) => (
          <option key={t.slug} value={t.slug}>{t.slug} — {t.name}</option>
        ))}
        <option value="__custom">(custom slug…)</option>
      </select>
      {!matched && (
        <input
          className="input"
          style={{ marginTop: 6 }}
          placeholder="welcome-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </>
  )
}
