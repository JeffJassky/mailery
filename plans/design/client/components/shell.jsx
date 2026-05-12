/* App shell — sidebar, topbar, theme toggle */

function Sidebar({ route, setRoute, counts }) {
  const Item = ({ id, icon: Ic, label, badge, screen }) => (
    <div className={"sidebar-link" + (route.screen === screen ? " active" : "")}
         onClick={() => setRoute({ screen })}>
      <Ic className="icon" />
      <span>{label}</span>
      {badge != null && <span className="sidebar-link-badge">{badge}</span>}
    </div>
  );
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
          <Item icon={Icons.Flows} label="Flows" screen="flows" badge={counts.flows} />
          <Item icon={Icons.Template} label="Templates" screen="templates" badge={counts.templates} />
          <Item icon={Icons.Broadcast} label="Broadcasts" screen="broadcasts" badge={counts.broadcasts} />
        </nav>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">Audience</div>
        <nav className="sidebar-nav">
          <Item icon={Icons.Contacts} label="Contacts" screen="contacts" badge="12.4k" />
          <Item icon={Icons.Shield} label="Suppressions" screen="suppressions" badge="218" />
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
        <span className="dot"></span>
        <span>All systems normal</span>
        <span style={{marginLeft:"auto"}} className="mono">redis ok</span>
      </div>
    </aside>
  );
}

function Topbar({ crumbs, theme, setTheme, right }) {
  return (
    <div className="topbar">
      <div className="crumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Icons.Chevron className="crumb-sep icon" size={12} />}
            <span className={i === crumbs.length - 1 ? "crumb-current" : ""}>{c}</span>
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
      <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme">
        {theme === "dark" ? <Icons.Sun size={15} /> : <Icons.Moon size={15} />}
      </button>
      <button className="icon-btn" title="Notifications"><Icons.Bell size={15} /></button>
    </div>
  );
}

function PageHead({ title, desc, actions }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {desc && <div className="page-desc">{desc}</div>}
      </div>
      {actions && <div className="right">{actions}</div>}
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    healthy: { cls: "green", label: "Healthy" },
    degraded: { cls: "amber", label: "Degraded" },
    tripped: { cls: "red", label: "Tripped" },
    sent: { cls: "green", label: "Sent" },
    delivered: { cls: "green", label: "Delivered" },
    opened: { cls: "blue", label: "Opened" },
    clicked: { cls: "violet", label: "Clicked" },
    queued: { cls: "neutral", label: "Queued" },
    sending: { cls: "blue", label: "Sending" },
    bounced: { cls: "red", label: "Bounced" },
    failed: { cls: "red", label: "Failed" },
    suppressed: { cls: "amber", label: "Suppressed" },
    complained: { cls: "red", label: "Complained" },
    enabled: { cls: "green", label: "Enabled" },
    disabled: { cls: "neutral", label: "Disabled" },
    paused: { cls: "amber", label: "Paused" },
    draft: { cls: "neutral", label: "Draft" },
    scheduled: { cls: "blue", label: "Scheduled" },
    active: { cls: "green", label: "Active" },
    completed: { cls: "neutral", label: "Completed" },
    subscribed: { cls: "green", label: "Subscribed" },
    unsubscribed: { cls: "neutral", label: "Unsubscribed" },
  };
  const s = map[status] || { cls: "neutral", label: status };
  return <span className={"pill " + s.cls}><span className="dot"></span>{s.label}</span>;
}

Object.assign(window, { Sidebar, Topbar, PageHead, StatusPill });
