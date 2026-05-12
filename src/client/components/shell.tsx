/* App shell — sidebar, topbar */
import React from 'react'
import { Icons } from './icons'
import type { MePayload } from '../lib/api'

type Route = { screen: string; slug?: string; id?: string }

const HEALTH_LABEL: Record<string, { text: string; cls: string }> = {
  healthy: { text: 'Healthy', cls: 'dot' },
  degraded: { text: 'Degraded', cls: 'dot amber' },
  tripped: { text: 'Tripped', cls: 'dot red' },
}

function formatCount(n: number | undefined): string | undefined {
  if (n == null) return undefined
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}

export function Sidebar({
  route,
  setRoute,
  me,
}: {
  route: Route
  setRoute: (r: Route) => void
  me: MePayload | undefined
}) {
  const Item = ({ icon: Ic, label, badge, screen }: any) => (
    <div
      className={'sidebar-link' + (route.screen === screen ? ' active' : '')}
      onClick={() => setRoute({ screen })}
    >
      <Ic className="icon" />
      <span>{label}</span>
      {badge != null && <span className="sidebar-link-badge">{badge}</span>}
    </div>
  )

  const counts = me?.counts
  const status = me?.health.status ?? ''
  const health = HEALTH_LABEL[status] ?? { text: status || '…', cls: 'dot' }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-logo">M</div>
        <div className="sidebar-brand-name">Mailery</div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">Overview</div>
        <nav className="sidebar-nav">
          <Item icon={Icons.Home} label="Dashboard" screen="dashboard" />
          <Item icon={Icons.Health} label="Health" screen="health" />
        </nav>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">Compose</div>
        <nav className="sidebar-nav">
          <Item icon={Icons.Flows} label="Flows" screen="flows" badge={formatCount(counts?.flows)} />
          <Item icon={Icons.Template} label="Templates" screen="templates" badge={formatCount(counts?.templates)} />
          <Item icon={Icons.Broadcast} label="Broadcasts" screen="broadcasts" badge={formatCount(counts?.broadcasts)} />
        </nav>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">Audience</div>
        <nav className="sidebar-nav">
          <Item icon={Icons.Contacts} label="Contacts" screen="contacts" badge={formatCount(counts?.contacts)} />
          <Item icon={Icons.Shield} label="Suppressions" screen="suppressions" badge={formatCount(counts?.suppressions)} />
        </nav>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">Activity</div>
        <nav className="sidebar-nav">
          <Item icon={Icons.Send} label="Sends" screen="sends" />
          <Item icon={Icons.Audit} label="Audit log" screen="audit" />
        </nav>
      </div>

      <div className="sidebar-footer">
        <span className={health.cls}></span>
        <span>{me ? health.text : '…'}</span>
        {me && (
          <span style={{ marginLeft: 'auto' }} className="mono text-xs">
            {me.providers.default}
          </span>
        )}
      </div>
    </aside>
  )
}

export function Topbar({
  crumbs,
  theme,
  setTheme,
  right,
}: {
  crumbs: string[]
  theme: string
  setTheme: (t: string) => void
  right?: React.ReactNode
}) {
  return (
    <div className="topbar">
      <div className="crumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Icons.Chevron className="crumb-sep icon" size={12} />}
            <span className={i === crumbs.length - 1 ? 'crumb-current' : ''}>{c}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="topbar-spacer" />
      <div className="topbar-search">
        <Icons.Search size={14} />
        <span>Search contacts, sends, flows…</span>
        <kbd>⌘K</kbd>
      </div>
      {right}
      <button
        className="icon-btn"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title="Toggle theme"
      >
        {theme === 'dark' ? <Icons.Sun size={15} /> : <Icons.Moon size={15} />}
      </button>
      <button className="icon-btn" title="Notifications">
        <Icons.Bell size={15} />
      </button>
    </div>
  )
}

export function PageHead({
  title,
  desc,
  actions,
}: {
  title: React.ReactNode
  desc?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {desc && <div className="page-desc">{desc}</div>}
      </div>
      {actions && <div className="right">{actions}</div>}
    </div>
  )
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    healthy: { cls: 'green', label: 'Healthy' },
    degraded: { cls: 'amber', label: 'Degraded' },
    tripped: { cls: 'red', label: 'Tripped' },
    sent: { cls: 'green', label: 'Sent' },
    delivered: { cls: 'green', label: 'Delivered' },
    opened: { cls: 'blue', label: 'Opened' },
    clicked: { cls: 'violet', label: 'Clicked' },
    queued: { cls: 'neutral', label: 'Queued' },
    sending: { cls: 'blue', label: 'Sending' },
    bounced: { cls: 'red', label: 'Bounced' },
    failed: { cls: 'red', label: 'Failed' },
    suppressed: { cls: 'amber', label: 'Suppressed' },
    complained: { cls: 'red', label: 'Complained' },
    enabled: { cls: 'green', label: 'Enabled' },
    disabled: { cls: 'neutral', label: 'Disabled' },
    paused: { cls: 'amber', label: 'Paused' },
    draft: { cls: 'neutral', label: 'Draft' },
    scheduled: { cls: 'blue', label: 'Scheduled' },
    active: { cls: 'green', label: 'Active' },
    completed: { cls: 'neutral', label: 'Completed' },
    subscribed: { cls: 'green', label: 'Subscribed' },
    unsubscribed: { cls: 'neutral', label: 'Unsubscribed' },
  }
  const s = map[status] ?? { cls: 'neutral', label: status }
  return (
    <span className={'pill ' + s.cls}>
      <span className="dot"></span>
      {s.label}
    </span>
  )
}
