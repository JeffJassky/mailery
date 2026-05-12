/* Broadcast composer — create / edit with segment editing + confirmation gate */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import {
  SEGMENT_FILTER_KINDS,
  defaultSegmentFilter,
  type SegmentFilterKind,
} from '../../shared/options.js'

type Filter = any

// Filter rows in the simple composer (`any` / `not` composites are editable
// only as raw JSON, so we hide them from the dropdown).
const FILTER_KINDS = SEGMENT_FILTER_KINDS.filter((k) => k.side !== 'composite')

export function BroadcastNew({ setRoute, slug: existingSlug }: any) {
  const isEditing = !!existingSlug

  // Live load when editing.
  const { data: live, refetch } = useLive(
    () => (isEditing ? api.broadcast(existingSlug) : Promise.resolve(null)),
    null as any,
  )

  // Templates for the picker.
  const { data: templates } = useLive(() => api.templates(), [] as any[])

  // Local form state.
  const [slug, setSlug] = React.useState('')
  const [name, setName] = React.useState('')
  const [templateSlug, setTemplateSlug] = React.useState('')
  const [filters, setFilters] = React.useState<Filter[]>([
    { kind: 'subscriptionStatus', equals: 'subscribed' },
  ])
  const [scheduleMode, setScheduleMode] = React.useState<'now' | 'at' | 'draft'>('at')
  const [scheduledAtLocal, setScheduledAtLocal] = React.useState<string>(toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)))
  const [respectTz, setRespectTz] = React.useState(false)
  const [typedCount, setTypedCount] = React.useState('')

  const [stageCount, setStageCount] = React.useState<{ stageA: number; stageB: number; afterSuppression: number; computedMs: number } | null>(null)
  const [savingSlug, setSavingSlug] = React.useState<string | null>(existingSlug ?? null)
  const [status, setStatus] = React.useState<string | null>(null)
  const [broadcastStatus, setBroadcastStatus] = React.useState<string>('draft')

  // Seed from live broadcast on load.
  React.useEffect(() => {
    if (!live) return
    setSlug(live.slug ?? '')
    setName(live.name ?? '')
    setTemplateSlug(live.templateSlug ?? '')
    setFilters(live.segmentDefinition?.filters ?? [{ kind: 'subscriptionStatus', equals: 'subscribed' }])
    if (live.scheduledAt) setScheduledAtLocal(toLocalInputValue(new Date(live.scheduledAt)))
    setRespectTz(live.respectRecipientTimezone === true)
    setBroadcastStatus(live.status ?? 'draft')
  }, [live])

  // Live segment count (debounced).
  React.useEffect(() => {
    if (!savingSlug) {
      setStageCount(null)
      return
    }
    const handle = setTimeout(() => {
      api.countSegment(savingSlug, { filters }).then(setStageCount).catch(() => setStageCount(null))
    }, 500)
    return () => clearTimeout(handle)
  }, [filters, savingSlug])

  function updateFilter(i: number, patch: Filter) {
    setFilters(filters.map((f, j) => (i === j ? { ...f, ...patch } : f)))
  }
  function changeFilterKind(i: number, kind: string) {
    setFilters(filters.map((f, j) => (i === j ? defaultSegmentFilter(kind as SegmentFilterKind) : f)))
  }
  function removeFilter(i: number) {
    setFilters(filters.filter((_, j) => j !== i))
  }
  function addFilter() {
    setFilters([...filters, defaultSegmentFilter('hasTag')])
  }

  async function saveDraft(): Promise<string | null> {
    setStatus('Saving…')
    try {
      if (!savingSlug) {
        if (!slug.trim() || !name.trim() || !templateSlug.trim()) {
          setStatus('Slug, name, and template are required.')
          return null
        }
        await api.createBroadcast({
          slug: slug.trim(),
          name: name.trim(),
          templateSlug: templateSlug.trim(),
          segmentDefinition: { filters },
        })
        setSavingSlug(slug.trim())
        setStatus('Created draft')
        return slug.trim()
      } else {
        await api.updateBroadcast(savingSlug, {
          name,
          templateSlug,
          segmentDefinition: { filters },
        })
        setStatus('Saved')
        refetch()
        return savingSlug
      }
    } catch (err: any) {
      setStatus(`Save failed: ${err?.message ?? err}`)
      return null
    }
  }

  async function schedule() {
    const finalSlug = savingSlug ?? (await saveDraft())
    if (!finalSlug) return

    const final = stageCount?.afterSuppression
    if (final == null) {
      setStatus('Live count not ready yet — wait a moment.')
      return
    }
    if (parseInt(typedCount, 10) !== final) {
      setStatus(`Typed count must match the live recipient count exactly (${final.toLocaleString()}).`)
      return
    }
    if (scheduleMode === 'draft') {
      setStatus('Saved as draft.')
      return
    }

    const at = scheduleMode === 'now' ? new Date() : new Date(scheduledAtLocal)
    if (Number.isNaN(at.getTime())) {
      setStatus('Invalid date.')
      return
    }
    try {
      await api.scheduleBroadcast(finalSlug, {
        scheduledAt: at.toISOString(),
        confirmedCount: final,
        respectRecipientTimezone: respectTz,
      })
      setStatus(`Scheduled for ${at.toLocaleString()}`)
      refetch()
    } catch (err: any) {
      setStatus(`Schedule failed: ${err?.message ?? err}`)
    }
  }

  async function cancel() {
    if (!savingSlug) return setRoute({ screen: 'broadcasts' })
    if (broadcastStatus === 'draft') return setRoute({ screen: 'broadcasts' })
    try {
      await api.cancelBroadcast(savingSlug)
      setStatus('Cancelled')
      setRoute({ screen: 'broadcasts' })
    } catch (err: any) {
      setStatus(`Cancel failed: ${err?.message ?? err}`)
    }
  }

  const finalCount = stageCount?.afterSuppression ?? 0
  const countMatches = parseInt(typedCount, 10) === finalCount && finalCount > 0
  const canSchedule = !!savingSlug && countMatches && broadcastStatus === 'draft'

  return (
    <>
      <PageHead
        title={isEditing ? name || 'Broadcast' : 'New broadcast'}
        desc={
          <>
            {savingSlug && <><span className="mono">broadcasts/{savingSlug}</span> · </>}
            <span className={'pill ' + (broadcastStatus === 'sent' ? 'green' : broadcastStatus === 'scheduled' ? 'blue' : 'neutral')}>{broadcastStatus}</span>
          </>
        }
        actions={
          <>
            <button className="btn" onClick={cancel}><Icons.X size={14} />{savingSlug && broadcastStatus !== 'draft' ? 'Cancel broadcast' : 'Back'}</button>
            <button className="btn" onClick={saveDraft}><Icons.Copy size={14} />Save draft</button>
            <button className="btn btn-primary" disabled={!canSchedule} onClick={schedule}><Icons.Rocket size={14} />Schedule</button>
          </>
        }
      />

      {status && (
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          <span className="text-sm">{status}</span>
        </div>
      )}

      <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          <div className="card">
            <div className="card-head"><span className="card-title">1. Content</span></div>
            <div className="card-body">
              {!isEditing && (
                <div className="field">
                  <label className="field-label">Slug</label>
                  <input className="input" placeholder="june-newsletter" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={!!savingSlug} />
                  <div className="field-hint">Set once on create; can't change after.</div>
                </div>
              )}
              <div className="field">
                <label className="field-label">Name</label>
                <input className="input" placeholder="June Newsletter" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">Template</label>
                <select className="select" value={templateSlug} onChange={(e) => setTemplateSlug(e.target.value)}>
                  <option value="">(pick a template)</option>
                  {templates.map((t: any) => (
                    <option key={t.slug} value={t.slug}>{t.slug} — {t.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">2. Segment</span>
              <span className="card-sub">Two-pass evaluation · host filter then mailer post-filter</span>
            </div>
            <div className="card-body">
              <div className="vstack" style={{ gap: 6 }}>
                {filters.map((f, i) => {
                  const kindDef = FILTER_KINDS.find((k) => k.value === f.kind)
                  return (
                    <div key={i} className="hstack" style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', gap: 8 }}>
                      <select className="select" value={f.kind} onChange={(e) => changeFilterKind(i, e.target.value)} style={{ width: 200 }}>
                        {FILTER_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                      </select>
                      <FilterInputs filter={f} onChange={(patch) => updateFilter(i, patch)} />
                      <span className="grow" />
                      <span className={'pill ' + (kindDef?.side === 'host' ? 'violet' : 'blue')} style={{ fontSize: 10.5 }}>{kindDef?.side}</span>
                      <button className="icon-btn" onClick={() => removeFilter(i)} title="Remove"><Icons.X size={12} /></button>
                    </div>
                  )
                })}
                <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={addFilter}><Icons.Plus size={12} />Add filter</button>
              </div>

              <div className="divider" />

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
                <div>
                  <div className="text-xs subtle">Stage A · host filter</div>
                  <div className="kpi-value" style={{ fontSize: 20 }}>{stageCount?.stageA?.toLocaleString() ?? '—'}</div>
                </div>
                <div>
                  <div className="text-xs subtle">Stage B · mailer post-filter</div>
                  <div className="kpi-value" style={{ fontSize: 20 }}>{stageCount?.stageB?.toLocaleString() ?? '—'}</div>
                </div>
                <div>
                  <div className="text-xs subtle">After suppression check</div>
                  <div className="kpi-value" style={{ fontSize: 20, color: 'var(--accent-press)' }}>{stageCount?.afterSuppression?.toLocaleString() ?? '—'}</div>
                </div>
              </div>
              <div className="text-xs subtle" style={{ marginTop: 6 }}>
                {savingSlug ? `Recomputed on filter change · last ${stageCount?.computedMs ?? '—'}ms` : 'Save a draft to enable live counts.'}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">3. Schedule</span></div>
            <div className="card-body">
              <div className="seg" style={{ marginBottom: 12 }}>
                <span className={'seg-item' + (scheduleMode === 'now' ? ' active' : '')} onClick={() => setScheduleMode('now')}>Send now</span>
                <span className={'seg-item' + (scheduleMode === 'at' ? ' active' : '')} onClick={() => setScheduleMode('at')}>At a specific time</span>
                <span className={'seg-item' + (scheduleMode === 'draft' ? ' active' : '')} onClick={() => setScheduleMode('draft')}>Save as draft</span>
              </div>
              {scheduleMode === 'at' && (
                <div className="split split-2">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">Date · time (local)</label>
                    <input className="input" type="datetime-local" value={scheduledAtLocal} onChange={(e) => setScheduledAtLocal(e.target.value)} />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">Per-recipient timezone</label>
                    <label className="hstack" style={{ gap: 6, padding: '8px 0' }}>
                      <input type="checkbox" checked={respectTz} onChange={(e) => setRespectTz(e.target.checked)} />
                      <span className="text-sm">Respect recipient timezone</span>
                    </label>
                    <div className="field-hint">When on, each contact gets the email at the equivalent local time using <span className="mono">contact.timezone</span>.</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-soft)' }}>
            <div className="card-head" style={{ borderBottomColor: 'var(--accent-border)' }}>
              <Icons.Warn size={16} style={{ color: 'var(--accent-press)' }} />
              <span className="card-title" style={{ color: 'var(--accent-press)' }}>Confirmation required (INVARIANT 11)</span>
            </div>
            <div className="card-body">
              <div className="text-sm" style={{ marginBottom: 10 }}>
                {finalCount > 0
                  ? <>This broadcast will send to <span className="f600">{finalCount.toLocaleString()} contacts</span>. To proceed, type the count exactly:</>
                  : <>Save a draft first to compute the recipient count.</>}
              </div>
              <div className="hstack">
                <input
                  className="input"
                  placeholder={finalCount > 0 ? `Type ${finalCount} to enable scheduling` : 'Recipient count'}
                  value={typedCount}
                  onChange={(e) => setTypedCount(e.target.value)}
                  style={{ maxWidth: 260, fontFamily: 'var(--font-mono)' }}
                  disabled={finalCount === 0}
                />
                {countMatches && <span className="pill green"><Icons.Check size={11} />Match</span>}
                {!countMatches && typedCount.length > 0 && <span className="pill red"><Icons.X size={11} />Mismatch</span>}
              </div>
              <div className="field-hint" style={{ marginTop: 6 }}>Audit-logged with <span className="mono">confirmedCount</span> + <span className="mono">confirmedBy</span>.</div>
            </div>
          </div>
        </div>

        <div className="vstack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><span className="card-title">Preview</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              {templateSlug ? (
                <BroadcastPreview slug={templateSlug} />
              ) : (
                <div className="text-xs subtle" style={{ padding: 16 }}>Pick a template to see the preview.</div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Pre-flight checks</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 8 }}>
              <div className="hstack"><Icons.Check size={14} style={{ color: 'var(--green-fg)' }} /><span className="text-sm">DKIM + SPF aligned</span></div>
              <div className="hstack">
                {savingSlug
                  ? <Icons.Check size={14} style={{ color: 'var(--green-fg)' }} />
                  : <Icons.Warn size={14} style={{ color: 'var(--amber-fg)' }} />}
                <span className="text-sm">{savingSlug ? 'Draft persisted' : 'Save a draft to lock in the segment'}</span>
              </div>
              <div className="hstack"><Icons.Check size={14} style={{ color: 'var(--green-fg)' }} /><span className="text-sm">Circuit breaker healthy</span></div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Per-kind filter inputs
// ---------------------------------------------------------------------------

function FilterInputs({ filter, onChange }: { filter: Filter; onChange: (patch: Filter) => void }) {
  switch (filter.kind) {
    case 'subscriptionStatus':
      return (
        <select className="select" value={filter.equals} onChange={(e) => onChange({ equals: e.target.value })}>
          <option>subscribed</option>
          <option>unsubscribed</option>
          <option>pending_doi</option>
          <option>bounced</option>
          <option>complained</option>
        </select>
      )
    case 'hasTag':
    case 'notHasTag':
      return (
        <input className="input" placeholder="vip" value={filter.tag ?? ''} onChange={(e) => onChange({ tag: e.target.value })} />
      )
    case 'fieldEquals':
      return (
        <>
          <input className="input" style={{ width: 140 }} placeholder="field" value={filter.field ?? ''} onChange={(e) => onChange({ field: e.target.value })} />
          <input className="input" style={{ flex: 1 }} placeholder="value" value={String(filter.value ?? '')} onChange={(e) => onChange({ value: e.target.value })} />
        </>
      )
    case 'fieldIn':
      return (
        <>
          <input className="input" style={{ width: 140 }} placeholder="field" value={filter.field ?? ''} onChange={(e) => onChange({ field: e.target.value })} />
          <input className="input" style={{ flex: 1 }} placeholder="value, value, value" value={(filter.values ?? []).join(', ')} onChange={(e) => onChange({ values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} />
        </>
      )
    case 'fieldExists':
      return <input className="input" placeholder="customerType" value={filter.field ?? ''} onChange={(e) => onChange({ field: e.target.value })} />
    case 'firedEvent':
    case 'notFiredEvent':
      return (
        <>
          <input className="input" style={{ flex: 1 }} placeholder="Event name" value={filter.eventName ?? ''} onChange={(e) => onChange({ eventName: e.target.value })} />
          <input className="input" style={{ width: 100 }} type="number" min={1} placeholder="days" value={filter.withinDays ?? ''} onChange={(e) => onChange({ withinDays: Number(e.target.value) || undefined })} />
        </>
      )
    case 'opened':
    case 'notOpened':
      return (
        <>
          <input className="input" style={{ flex: 1 }} placeholder="Template slug (optional)" value={filter.templateSlug ?? ''} onChange={(e) => onChange({ templateSlug: e.target.value || undefined })} />
          <input className="input" style={{ width: 100 }} type="number" min={1} placeholder="days" value={filter.withinDays ?? ''} onChange={(e) => onChange({ withinDays: Number(e.target.value) || undefined })} />
        </>
      )
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Preview pane — calls /api/templates/:slug/preview
// ---------------------------------------------------------------------------

function BroadcastPreview({ slug }: { slug: string }) {
  const [preview, setPreview] = React.useState<{ subject: string; preheader: string; html: string } | null>(null)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    setPreview(null)
    setErr(null)
    api.previewTemplate(slug, { useDraft: false })
      .then(setPreview)
      .catch((e) => setErr(String(e?.message ?? e)))
  }, [slug])

  if (err) return <div className="text-xs subtle" style={{ padding: 16 }}>{err}</div>
  if (!preview) return <div className="text-xs subtle" style={{ padding: 16 }}>Loading…</div>

  return (
    <>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <div className="text-sm f500">{preview.subject}</div>
        <div className="text-xs subtle">{preview.preheader}</div>
      </div>
      <div style={{ padding: 16, background: 'var(--bg-sunken)', maxHeight: 360, overflow: 'auto' }}>
        <iframe
          title="preview"
          srcDoc={preview.html}
          style={{ width: '100%', minHeight: 280, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
        />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function toLocalInputValue(d: Date): string {
  // YYYY-MM-DDTHH:MM in local time, for <input type="datetime-local">
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
