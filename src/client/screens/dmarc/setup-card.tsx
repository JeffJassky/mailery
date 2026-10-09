/* DMARC Monitoring — Setup card */
import React from 'react'
import { api, type DmarcAlertDelivery, type DmarcMonitoringPayload } from '../../lib/api'

type Props = { data: DmarcMonitoringPayload; onChanged: () => void }
type Tone = 'green' | 'amber' | 'red'

const ROUTER_SNIPPET = `createPublicRouter(mailer, { dmarcInbound: { secret: process.env.MAILERY_DMARC_SECRET } })`
const HANDLER_SNIPPET = `onDmarcAlert: async (alert) => { await postToSlack(alert.text) }`

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button className="btn btn-xs" onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function Step({ n, title, tone, status, children }: {
  n: number
  title: string
  tone: Tone
  status: string
  children?: React.ReactNode
}) {
  return (
    <div style={{ display: 'grid', gap: 8, padding: '12px 0', borderTop: n === 1 ? undefined : '1px solid var(--border)' }}>
      <div className="hstack" style={{ gap: 10 }}>
        <span className="text-xs subtle">{n}.</span>
        <strong className="text-sm">{title}</strong>
        <span className={'pill ' + tone}><span className="dot" />{status}</span>
      </div>
      {children && <div style={{ display: 'grid', gap: 8, paddingLeft: 22 }}>{children}</div>}
    </div>
  )
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="hstack" style={{ gap: 8 }}>
      <code className="mono text-xs" style={{ wordBreak: 'break-all' }}>{text}</code>
      <CopyButton text={text} />
    </div>
  )
}

function DomainDns({ domain, onChanged }: { domain: DmarcMonitoringPayload['domains'][number]; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false)
  const dns = domain.dns
  const problems = dns ? dns.issues.length : 0
  const tone: Tone = !dns ? 'amber' : dns.ok && problems === 0 ? 'green' : dns.ok ? 'amber' : 'red'
  const label = !dns ? 'Not checked' : problems === 0 ? 'OK' : `${problems} problem${problems === 1 ? '' : 's'}`
  return (
    <>
      <tr>
        <td className="mono text-xs">{domain.domain}</td>
        <td className="text-xs">{dns?.dmarc.policy ?? '—'}</td>
        <td><span className={'pill ' + tone}><span className="dot" />{label}</span></td>
        <td className="text-xs">{dns ? new Date(dns.checkedAt).toLocaleString() : '—'}</td>
        <td>
          {problems > 0 && (
            <button className="btn btn-xs" onClick={() => setOpen(!open)}>{open ? 'Hide issues' : 'Show issues'}</button>
          )}
        </td>
      </tr>
      {open && dns && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--bg-sunken)' }}>
            <div style={{ display: 'grid', gap: 8, padding: '8px 12px' }}>
              {dns.issues.map((issue, i) => {
                const record = issue.fix ? `${issue.fix.host}  ${issue.fix.type}  "${issue.fix.value}"` : null
                return (
                  <div key={issue.code + i} style={{ display: 'grid', gap: 4 }}>
                    <span className="text-sm">{issue.message}</span>
                    {record && (
                      <div className="hstack" style={{ gap: 8 }}>
                        <code className="mono text-xs" style={{ wordBreak: 'break-all' }}>{record}</code>
                        <CopyButton text={record} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export function SetupCard({ data, onChanged }: Props) {
  const [checking, setChecking] = React.useState(false)
  const [checkError, setCheckError] = React.useState<string | null>(null)
  const [testing, setTesting] = React.useState(false)
  const [testError, setTestError] = React.useState<string | null>(null)
  const [delivery, setDelivery] = React.useState<DmarcAlertDelivery | null>(null)

  const domains = data.domains.filter((d) => !d.ignored)
  const hostPath = (data.inbound.url ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const parseUrl = `https://mailery:<YOUR_SECRET>@${hostPath}`
  const reportAddress = data.settings.reportAddress

  const dnsProblems = domains.filter((d) => d.dns && d.dns.issues.length > 0).length
  const dnsTone: Tone = domains.length === 0 || domains.some((d) => !d.dns) ? 'amber' : domains.some((d) => !d.dns!.ok) ? 'red' : dnsProblems > 0 ? 'amber' : 'green'
  const dnsStatus = domains.length === 0 ? 'No domains' : domains.some((d) => !d.dns) ? 'Not checked' : dnsProblems > 0 ? `${dnsProblems} with problems` : 'OK'
  const noReports = domains.length === 0 || domains.some((d) => d.reportCount30d === 0)

  async function recheck() {
    setChecking(true)
    setCheckError(null)
    try {
      await api.checkDmarcDns()
      onChanged()
    } catch (err: any) {
      setCheckError(String(err?.message ?? err))
    } finally {
      setChecking(false)
    }
  }

  async function sendTest() {
    setTesting(true)
    setTestError(null)
    setDelivery(null)
    try {
      const res = await api.sendTestDmarcAlert()
      setDelivery(res.delivery)
    } catch (err: any) {
      setTestError(String(err?.message ?? err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <span className="card-title">Setup</span>
        <span className="card-sub">Six steps from a DMARC record to alerts in your own tools.</span>
      </div>
      <div className="card-body">
        <Step n={1} title="Reports arrive automatically" tone={data.inbound.mounted ? 'green' : 'amber'} status={data.inbound.mounted ? 'Mounted' : 'Not mounted'}>
          {!data.inbound.mounted && (
            <>
              <Snippet text={ROUTER_SNIPPET} />
              <span className="text-xs subtle">Until then, upload reports by hand below.</span>
            </>
          )}
        </Step>

        <Step n={2} title="Inbound Parse points at Mailery" tone={data.inbound.lastInboundReportAt ? 'green' : 'amber'} status={data.inbound.lastInboundReportAt ? 'Receiving' : 'Nothing received yet'}>
          {data.inbound.url ? (
            <>
              <Snippet text={parseUrl} />
              <span className="text-xs subtle">
                Your provider's inbound-parse destination URL. The secret is the one in your config; Mailery never displays it.
              </span>
            </>
          ) : (
            <span className="text-xs subtle">Available once the inbound route is mounted (step 1).</span>
          )}
        </Step>

        <Step n={3} title="Report address" tone={reportAddress ? 'green' : 'amber'} status={reportAddress ? 'Set' : 'Not set'}>
          {reportAddress ? (
            <span className="mono text-xs">{reportAddress}</span>
          ) : (
            <span className="text-xs subtle">Not set. Set it in Settings below.</span>
          )}
        </Step>

        <Step n={4} title="DNS" tone={dnsTone} status={dnsStatus}>
          <div className="hstack" style={{ gap: 8 }}>
            <button className="btn btn-xs" disabled={checking} onClick={recheck}>
              {checking ? 'Checking…' : 'Re-check DNS'}
            </button>
            {checkError && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{checkError}</span>}
          </div>
          {domains.length === 0 ? (
            <span className="text-xs subtle">No monitored domains yet.</span>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Domain</th><th>Policy</th><th>Status</th><th>Checked</th><th /></tr>
              </thead>
              <tbody>
                {domains.map((d) => <DomainDns key={d.domain} domain={d} onChanged={onChanged} />)}
              </tbody>
            </table>
          )}
        </Step>

        <Step n={5} title="Reports are arriving" tone={noReports ? 'amber' : 'green'} status={noReports ? 'Waiting for reports' : 'Arriving'}>
          {domains.length === 0 ? (
            <span className="text-xs subtle">No monitored domains yet.</span>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Domain</th><th>Last report</th><th className="text-right">Reports (30d)</th></tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.domain}>
                    <td className="mono text-xs">{d.domain}</td>
                    <td className="text-xs">{d.lastReportAt ? new Date(d.lastReportAt).toLocaleString() : '—'}</td>
                    <td className="text-right text-xs" style={{ color: d.reportCount30d === 0 ? 'var(--amber-fg)' : undefined }}>
                      {d.reportCount30d}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Step>

        <Step n={6} title="Alerts reach you" tone={data.alertHandlerConfigured ? 'green' : 'amber'} status={data.alertHandlerConfigured ? 'Handler configured' : 'No handler'}>
          {!data.alertHandlerConfigured && <Snippet text={HANDLER_SNIPPET} />}
          <div className="hstack" style={{ gap: 8 }}>
            <button className="btn btn-xs" disabled={testing} onClick={sendTest}>
              {testing ? 'Sending…' : 'Send test alert'}
            </button>
            {delivery?.outcome === 'delivered' && <span className="pill green"><span className="dot" />Delivered</span>}
            {delivery?.outcome === 'no_handler' && (
              <span className="pill amber"><span className="dot" />No onDmarcAlert handler is configured</span>
            )}
            {delivery?.outcome === 'failed' && <span className="pill red"><span className="dot" />Failed: {delivery.error}</span>}
            {testError && <span className="text-xs" style={{ color: 'var(--red-fg)' }}>{testError}</span>}
          </div>
        </Step>
      </div>
    </div>
  )
}
