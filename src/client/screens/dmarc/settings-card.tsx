/* DMARC Monitoring: settings card */
import React from 'react'
import { api, type DmarcAlertKind, type DmarcMonitoringPayload, type DmarcMonitoringSettings, type DmarcSettingsPatch } from '../../lib/api'
import { DMARC_ALERT_KINDS } from '../../../shared/dmarc-types.js'

type Kind = Exclude<DmarcAlertKind, 'test'>

const KIND_INFO: Record<Kind, { label: string; desc: string }> = {
  unknown_source_failing: { label: 'Unknown sender failing', desc: 'An unrecognized server is sending mail as your domain and failing DMARC.' },
  known_source_failing: { label: 'Known sender failing', desc: 'A sender you have labeled is failing DMARC, usually a broken SPF or DKIM setup.' },
  alignment_drop: { label: 'Pass rate drop', desc: 'The share of your mail passing DMARC fell below the minimum.' },
  reports_stopped: { label: 'Reports stopped', desc: 'No DMARC reports have arrived for a monitored domain in a while.' },
  policy_ready: { label: 'Policy ready to tighten', desc: 'A domain looks safe to move to a stricter DMARC policy.' },
  dns_misconfigured: { label: 'DNS misconfigured', desc: 'A DMARC, SPF, or reporting DNS record is missing or wrong.' },
}

const NUMBER_FIELDS = [
  { key: 'windowDays', label: 'Lookback window (days)' },
  { key: 'unknownSourceMinMessages', label: 'Unknown sender threshold (messages)' },
  { key: 'knownSourceMinMessages', label: 'Known sender threshold (messages)' },
  { key: 'alignmentMinRate', label: 'Minimum pass rate (%)' },
  { key: 'alignmentMinMessages', label: 'Minimum messages for pass-rate alerts' },
  { key: 'reportsStoppedDays', label: 'Reports stopped after (days)' },
  { key: 'realertAfterHours', label: 'Remind after (hours, 0 = never)' },
  { key: 'dnsCheckIntervalHours', label: 'DNS check every (hours, 0 = never)' },
] as const

type NumKey = (typeof NUMBER_FIELDS)[number]['key']

interface FormState {
  enabled: boolean
  enabledKinds: Kind[]
  nums: Record<NumKey, string>
  reportAddress: string
  extraDomains: string
  ignoredDomains: string
}

function toForm(s: DmarcMonitoringSettings): FormState {
  const nums = {} as Record<NumKey, string>
  for (const f of NUMBER_FIELDS) {
    const v = s.alerts[f.key]
    nums[f.key] = String(f.key === 'alignmentMinRate' ? Number((v * 100).toFixed(2)) : v)
  }
  return {
    enabled: s.alerts.enabled,
    enabledKinds: DMARC_ALERT_KINDS.filter((k) => !s.alerts.disabledKinds.includes(k)),
    nums,
    reportAddress: s.reportAddress ?? '',
    extraDomains: s.extraDomains.join('\n'),
    ignoredDomains: s.ignoredDomains.join('\n'),
  }
}

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Builds a patch holding only the keys that differ. Throws a readable error on bad numbers. */
function buildPatch(form: FormState, current: DmarcMonitoringSettings): DmarcSettingsPatch {
  const patch: DmarcSettingsPatch = {}
  const alerts: NonNullable<DmarcSettingsPatch['alerts']> = {}
  const a = current.alerts

  if (form.enabled !== a.enabled) alerts.enabled = form.enabled

  const disabledKinds = DMARC_ALERT_KINDS.filter((k) => !form.enabledKinds.includes(k))
  const currentDisabled = DMARC_ALERT_KINDS.filter((k) => a.disabledKinds.includes(k))
  if (!sameList(disabledKinds, currentDisabled)) alerts.disabledKinds = disabledKinds

  for (const f of NUMBER_FIELDS) {
    const raw = form.nums[f.key].trim()
    const n = Number(raw)
    if (raw === '' || !Number.isFinite(n)) throw new Error(`${f.label} must be a number.`)
    const value = f.key === 'alignmentMinRate' ? Number((n / 100).toFixed(4)) : n
    if (value !== a[f.key]) alerts[f.key] = value
  }
  if (Object.keys(alerts).length > 0) patch.alerts = alerts

  const address = form.reportAddress.trim()
  const nextAddress = address === '' ? null : address
  if (nextAddress !== current.reportAddress) patch.reportAddress = nextAddress

  const extra = lines(form.extraDomains)
  if (!sameList(extra, current.extraDomains)) patch.extraDomains = extra
  const ignored = lines(form.ignoredDomains)
  if (!sameList(ignored, current.ignoredDomains)) patch.ignoredDomains = ignored

  return patch
}

export function SettingsCard({ data, onChanged }: { data: DmarcMonitoringPayload; onChanged: () => void }) {
  const [form, setForm] = React.useState<FormState>(() => toForm(data.settings))
  const [busy, setBusy] = React.useState<'save' | 'reset' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)

  // Re-sync after a save or refetch. Keyed on content so an identical refetch doesn't clobber edits.
  const settingsKey = JSON.stringify(data.settings)
  React.useEffect(() => {
    setForm(toForm(data.settings))
  }, [settingsKey])

  function setNum(key: NumKey, value: string) {
    setForm((f) => ({ ...f, nums: { ...f.nums, [key]: value } }))
  }

  function toggleKind(kind: Kind, on: boolean) {
    setForm((f) => ({
      ...f,
      enabledKinds: on ? DMARC_ALERT_KINDS.filter((k) => k === kind || f.enabledKinds.includes(k)) : f.enabledKinds.filter((k) => k !== kind),
    }))
  }

  async function save() {
    setError(null)
    setMessage(null)
    let patch: DmarcSettingsPatch
    try {
      patch = buildPatch(form, data.settings)
    } catch (err: any) {
      setError(String(err?.message ?? err))
      return
    }
    if (Object.keys(patch).length === 0) {
      setMessage('No changes to save.')
      return
    }
    setBusy('save')
    try {
      await api.saveDmarcSettings(patch)
      setMessage('Saved.')
      onChanged()
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(null)
    }
  }

  async function reset() {
    setError(null)
    setMessage(null)
    setBusy('reset')
    try {
      await api.resetDmarcSettings()
      setMessage('Reset to defaults.')
      onChanged()
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <span className="card-title">Settings</span>
        <span className="card-sub">Saved in the database. Anything you change here overrides the app's Mailery config.</span>
        <div className="card-actions">
          <button className="btn btn-xs" disabled={busy !== null} onClick={save}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          {data.hasDbOverride && (
            <button className="btn btn-xs" disabled={busy !== null} onClick={reset}>
              {busy === 'reset' ? 'Resetting…' : 'Reset to defaults'}
            </button>
          )}
          {message && <span className="text-xs subtle">{message}</span>}
          {error && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{error}</span>}
        </div>
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 14 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="hstack" htmlFor="dmarc-alerts-enabled" style={{ gap: 6 }}>
            <input
              id="dmarc-alerts-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            <span className="f500 text-sm">Alerts enabled</span>
          </label>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          {DMARC_ALERT_KINDS.map((kind) => (
            <div key={kind} className="field" style={{ marginBottom: 0 }}>
              <label className="hstack" htmlFor={`dmarc-kind-${kind}`} style={{ gap: 6 }}>
                <input
                  id={`dmarc-kind-${kind}`}
                  type="checkbox"
                  checked={form.enabledKinds.includes(kind)}
                  onChange={(e) => toggleKind(kind, e.target.checked)}
                />
                <span className="text-sm">{KIND_INFO[kind].label}</span>
              </label>
              <div className="field-hint" style={{ marginLeft: 22 }}>{KIND_INFO[kind].desc}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {NUMBER_FIELDS.map((f) => (
            <div key={f.key} className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor={`dmarc-num-${f.key}`}>{f.label}</label>
              <input
                id={`dmarc-num-${f.key}`}
                className="input"
                type="number"
                min={0}
                step="any"
                value={form.nums[f.key]}
                onChange={(e) => setNum(f.key, e.target.value)}
              />
            </div>
          ))}
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="dmarc-report-address">Report address</label>
          <input
            id="dmarc-report-address"
            className="input"
            type="text"
            placeholder="reports@dmarc-in.example.com"
            value={form.reportAddress}
            onChange={(e) => setForm((f) => ({ ...f, reportAddress: e.target.value }))}
          />
          <div className="field-hint">The mailbox your DMARC records send reports to (the rua= address). Leave empty for none.</div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" htmlFor="dmarc-extra-domains">Extra domains</label>
            <textarea
              id="dmarc-extra-domains"
              className="input mono"
              rows={4}
              value={form.extraDomains}
              onChange={(e) => setForm((f) => ({ ...f, extraDomains: e.target.value }))}
            />
            <div className="field-hint">One domain per line. Monitored in addition to your sender domains.</div>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" htmlFor="dmarc-ignored-domains">Ignored domains</label>
            <textarea
              id="dmarc-ignored-domains"
              className="input mono"
              rows={4}
              value={form.ignoredDomains}
              onChange={(e) => setForm((f) => ({ ...f, ignoredDomains: e.target.value }))}
            />
            <div className="field-hint">One domain per line. Never monitored or alerted on.</div>
          </div>
        </div>

        <div className="text-xs subtle">
          Secrets (the inbound webhook secret) and the alert handler are set in your app's Mailery config, not here.
        </div>
      </div>
    </div>
  )
}
