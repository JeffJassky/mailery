/* Flow detail — vertical step builder (Customer.io style) */

const FLOW_STEPS = {
  "activation-rescue": [
    { kind: "wait", label: "Wait", meta: "1 day", icon: "Clock", iconClass: "wait" },
    { kind: "condition", label: "If: not fired 'Activated app'", meta: "Skip if user has already activated", icon: "Branch", iconClass: "condition" },
    { kind: "send", label: "Send · Try a starter storyboard", meta: "templates/activation-rescue-1 · marketing", icon: "Mail", iconClass: "send", sends: 142, opens: "61%", clicks: "18%" },
    { kind: "wait", label: "Wait", meta: "3 days", icon: "Clock", iconClass: "wait" },
    { kind: "branch", label: "Branch: opened previous email?", meta: "Two paths", icon: "Branch", iconClass: "condition" },
    { kind: "tag", label: "Tag · add 'engaged-rescue'", meta: "Routed through host adapter", icon: "Tag", iconClass: "tag" },
    { kind: "exit", label: "Exit", meta: "Goal reached", icon: "Exit", iconClass: "exit" },
  ]
};

function FlowDetail({ slug = "activation-rescue", setRoute }) {
  const flow = sample.flows.find(f => f.slug === slug) || sample.flows[1];
  const steps = FLOW_STEPS["activation-rescue"];
  const [selectedStep, setSelectedStep] = React.useState(2);
  const [tab, setTab] = React.useState("editor");

  const StepIcon = ({ name }) => {
    const I = Icons[name] || Icons.Mail;
    return <I size={18} />;
  };

  return (
    <>
      <PageHead
        title={flow.name}
        desc={<span className="mono">flows/{flow.slug}</span>}
        actions={
          <>
            <span className="pill green"><span className="dot" />Enabled</span>
            <button className="btn"><Icons.Pause size={14} />Pause</button>
            <button className="btn"><Icons.Code size={14} />View JSON</button>
            <button className="btn btn-primary"><Icons.Rocket size={14} />Publish draft</button>
          </>
        }
      />

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Active runs</div><div className="kpi-value">{flow.active}</div><div className="kpi-meta subtle">Right now</div></div>
        <div className="kpi"><div className="kpi-label">Sends · 7d</div><div className="kpi-value">{flow.sends7d}</div><div className="kpi-meta"><span className="kpi-delta up">▲ 12%</span></div></div>
        <div className="kpi"><div className="kpi-label">Completed runs</div><div className="kpi-value">2,184</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Version</div><div className="kpi-value">v{flow.version}</div><div className="kpi-meta"><span className="pill amber"><span className="dot" />Draft v{flow.version+1}</span></div></div>
      </div>

      <div className="tabs">
        <div className={"tab"+(tab==="editor"?" active":"")} onClick={()=>setTab("editor")}>Editor</div>
        <div className={"tab"+(tab==="runs"?" active":"")} onClick={()=>setTab("runs")}>Active runs<span className="tab-count">{flow.active}</span></div>
        <div className={"tab"+(tab==="history"?" active":"")} onClick={()=>setTab("history")}>History</div>
        <div className={"tab"+(tab==="settings"?" active":"")} onClick={()=>setTab("settings")}>Settings</div>
      </div>

      <div className="split split-asym">
        <div className="card">
          <div className="card-head">
            <span className="card-title">Steps</span>
            <span className="card-sub">7 steps · pinned to v{flow.version} for in-flight runs</span>
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
                <div className="flow-trigger-name">Event · "Downloaded app"</div>
                <div className="flow-trigger-meta">Once per contact · 142 entered in last 7d</div>
              </div>
            </div>
            <div className="flow-connector" />

            {steps.map((s, i) => (
              <React.Fragment key={i}>
                <div className={"flow-step " + s.iconClass + (selectedStep===i?" selected":"")} onClick={()=>setSelectedStep(i)}>
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
                      <div style={{marginTop:4}}>opens {s.opens}</div>
                      <div>clicks {s.clicks}</div>
                    </div>
                  )}
                </div>
                <div style={{position:"relative", height:24, display:"flex", alignItems:"center", flexDirection:"column"}}>
                  <div style={{position:"absolute", inset:0, display:"flex", justifyContent:"center", alignItems:"center"}}>
                    <div className="flow-connector" style={{height:24}} />
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
            <span className="card-sub">Step {selectedStep+1}</span>
          </div>
          <div className="card-body">
            <div className="field">
              <label className="field-label">Step type</label>
              <div className="seg" style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)"}}>
                <span className="seg-item">Wait</span>
                <span className="seg-item active">Send</span>
                <span className="seg-item">Branch</span>
                <span className="seg-item">Tag</span>
              </div>
            </div>
            <div className="field">
              <label className="field-label">Template</label>
              <select className="select" defaultValue="activation-rescue-1">
                <option>activation-rescue-1 — Try a starter storyboard</option>
                <option>welcome-1 — Welcome · day 0</option>
              </select>
              <div className="field-hint">Marketing · suppression scope checked at send time.</div>
            </div>
            <div className="field">
              <label className="field-label">Provider override</label>
              <select className="select"><option>Default (SendGrid)</option><option>Postmark</option></select>
            </div>
            <div className="field">
              <label className="field-label">Send-time predicate</label>
              <pre className="code">{`{`}
{`  `}<span className="k">"not"</span>: {`{`}
{`    `}<span className="k">"hasFiredEvent"</span>: <span className="s">"Activated app"</span>
{`  }`}
{`}`}</pre>
              <div className="field-hint">Re-checked at send time, not enrollment.</div>
            </div>
            <div className="field" style={{marginBottom:0}}>
              <label className="field-label hstack"><Icons.Eye size={14}/>Tracking</label>
              <div className="hstack">
                <div className="toggle on"><div className="track"><div className="knob" /></div><span>Opens</span></div>
                <div className="toggle on" style={{marginLeft:16}}><div className="track"><div className="knob" /></div><span>Clicks</span></div>
              </div>
            </div>
            <div className="divider" />
            <div className="hstack">
              <button className="btn btn-sm"><Icons.Eye size={12} />Preview</button>
              <button className="btn btn-sm"><Icons.Send size={12} />Test send</button>
              <span className="grow" />
              <button className="btn btn-sm btn-danger"><Icons.X size={12} />Delete step</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

window.FlowDetail = FlowDetail;
