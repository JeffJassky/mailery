/* Broadcast composer — segment + confirmation gate */

function BroadcastNew({ setRoute }) {
  const [count] = React.useState(4231);
  const [typed, setTyped] = React.useState("");
  const match = typed === String(count);
  const segPreview = [
    { kind:"subscriptionStatus", value:"subscribed", side:"mailer" },
    { kind:"fieldEquals", value:"tier = Free", side:"host" },
    { kind:"firedEvent", value:"Created · within 90d", side:"mailer" },
    { kind:"notFiredEvent", value:"Hit Free Limit", side:"mailer" },
    { kind:"notHasTag", value:"do-not-email", side:"host" },
  ];

  return (
    <>
      <PageHead
        title="New broadcast"
        desc={<>Compose to a segment, schedule once. <span className="mono">draft</span></>}
        actions={
          <>
            <button className="btn" onClick={()=>setRoute({screen:"broadcasts"})}><Icons.X size={14}/>Cancel</button>
            <button className="btn">Save draft</button>
            <button className={"btn btn-primary"+(match?"":" ")} style={!match?{opacity:0.55, pointerEvents:"none"}:{}}>
              <Icons.Rocket size={14}/>Schedule broadcast
            </button>
          </>
        }
      />

      <div className="split" style={{gridTemplateColumns:"minmax(0,1fr) 380px", gap:16}}>
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div className="card">
            <div className="card-head"><span className="card-title">1. Content</span></div>
            <div className="card-body">
              <div className="field">
                <label className="field-label">Name</label>
                <input className="input" defaultValue="Import beta launching"/>
              </div>
              <div className="field">
                <label className="field-label">Template</label>
                <select className="select" defaultValue="feature-import-beta">
                  <option>welcome-1 — Welcome · day 0</option>
                  <option>feature-import-beta — Import beta launching</option>
                  <option>summer-launch — Summer launch teaser (draft)</option>
                </select>
                <div className="field-hint">Marketing template · subject "Import is live for everyone"</div>
              </div>
              <div className="field" style={{marginBottom:0}}>
                <label className="field-label">From</label>
                <div className="hstack">
                  <input className="input" defaultValue="Jeff at StoryFolder" style={{flex:1}}/>
                  <input className="input" defaultValue="jeff@storyfolder.com" style={{flex:1.5}}/>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">2. Segment</span>
              <span className="card-sub">Two-pass evaluation · host filter then mailer post-filter</span>
              <div className="card-actions">
                <button className="btn btn-sm"><Icons.Code size={12}/>Edit JSON</button>
              </div>
            </div>
            <div className="card-body">
              <div className="vstack" style={{gap:6}}>
                {segPreview.map((f,i)=>(
                  <div key={i} className="hstack" style={{padding:"8px 10px",border:"1px solid var(--border)",borderRadius:8,background:"var(--bg)"}}>
                    <span className="tag">{f.kind}</span>
                    <span className="text-sm">{f.value}</span>
                    <span className="grow"/>
                    <span className={"pill "+(f.side==="host"?"violet":"blue")} style={{fontSize:10.5}}>{f.side}</span>
                    <button className="icon-btn" style={{width:24,height:24,border:"none",background:"transparent"}}><Icons.X size={12}/></button>
                  </div>
                ))}
                <button className="btn btn-sm btn-ghost" style={{alignSelf:"flex-start"}}><Icons.Plus size={12}/>Add filter</button>
              </div>

              <div className="divider"/>

              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                <div>
                  <div className="text-xs subtle">Stage A · host filter</div>
                  <div className="kpi-value" style={{fontSize:20}}>9,184</div>
                </div>
                <div>
                  <div className="text-xs subtle">Stage B · mailer post-filter</div>
                  <div className="kpi-value" style={{fontSize:20}}>4,567</div>
                </div>
                <div>
                  <div className="text-xs subtle">After suppression check</div>
                  <div className="kpi-value" style={{fontSize:20,color:"var(--accent-press)"}}>{count.toLocaleString()}</div>
                </div>
              </div>
              <div className="text-xs subtle" style={{marginTop:6}}>Recomputed every 500ms · last 220ms · cached</div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">3. Schedule</span></div>
            <div className="card-body">
              <div className="seg" style={{marginBottom:12}}>
                <span className="seg-item">Send now</span>
                <span className="seg-item active">At a specific time</span>
                <span className="seg-item">Save as draft</span>
              </div>
              <div className="split split-2">
                <div className="field" style={{marginBottom:0}}>
                  <label className="field-label">Date · time</label>
                  <input className="input" defaultValue="May 14, 2026  ·  10:00"/>
                </div>
                <div className="field" style={{marginBottom:0}}>
                  <label className="field-label">Time zone</label>
                  <select className="select"><option>America/Los_Angeles (PT)</option><option>UTC</option></select>
                </div>
              </div>
              <div className="field-hint" style={{marginTop:8}}>Per-recipient timezone delivery is on by default — uses each contact's <span className="mono">timezone</span> from the adapter.</div>
            </div>
          </div>

          <div className="card" style={{borderColor:"var(--accent-border)", background:"var(--accent-soft)"}}>
            <div className="card-head" style={{borderBottomColor:"var(--accent-border)"}}>
              <Icons.Warn size={16} style={{color:"var(--accent-press)"}}/>
              <span className="card-title" style={{color:"var(--accent-press)"}}>Confirmation required (INVARIANT 11)</span>
            </div>
            <div className="card-body">
              <div className="text-sm" style={{marginBottom:10}}>
                This broadcast will send to <span className="f600">{count.toLocaleString()} contacts</span>. To proceed, type the count exactly:
              </div>
              <div className="hstack">
                <input className="input" placeholder="Type 4231 to enable scheduling" value={typed} onChange={e=>setTyped(e.target.value)} style={{maxWidth:260, fontFamily:"var(--font-mono)"}}/>
                {match && <span className="pill green"><Icons.Check size={11}/>Match</span>}
                {!match && typed.length>0 && <span className="pill red"><Icons.X size={11}/>Mismatch</span>}
              </div>
              <div className="field-hint" style={{marginTop:6}}>Audit-logged with <span className="mono">confirmedCount</span> + <span className="mono">confirmedBy</span>.</div>
            </div>
          </div>
        </div>

        <div className="vstack" style={{gap:16}}>
          <div className="card">
            <div className="card-head"><span className="card-title">Preview</span><span className="card-sub">Subject</span></div>
            <div className="card-body" style={{padding:0}}>
              <div style={{padding:"12px 16px", borderBottom:"1px solid var(--border)"}}>
                <div className="text-sm f500">Import is live for everyone</div>
                <div className="text-xs subtle">Drop a PDF or Figma file and we'll storyboard it for you.</div>
              </div>
              <div style={{padding:16, background:"var(--bg-sunken)"}}>
                <div style={{background:"#fff", borderRadius:8, padding:16, color:"#1c1917", fontSize:13, lineHeight:1.55}}>
                  <div style={{height:6,width:40,background:"#f97316",borderRadius:3,marginBottom:14}}/>
                  <div style={{fontWeight:600,fontSize:16,marginBottom:6}}>Import is here.</div>
                  <div style={{color:"#57534e",marginBottom:10}}>Bring in a storyboard you already have. We'll keep the order, the notes, even the columns.</div>
                  <div style={{display:"inline-block",background:"#f97316",color:"#fff",padding:"6px 12px",borderRadius:6,fontWeight:600,fontSize:12}}>Try Import →</div>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Pre-flight checks</span></div>
            <div className="card-body" style={{display:"grid",gap:8}}>
              <div className="hstack"><Icons.Check size={14} style={{color:"var(--green-fg)"}}/><span className="text-sm">DKIM + SPF aligned</span></div>
              <div className="hstack"><Icons.Check size={14} style={{color:"var(--green-fg)"}}/><span className="text-sm">Suppression check ran (218 excluded)</span></div>
              <div className="hstack"><Icons.Check size={14} style={{color:"var(--green-fg)"}}/><span className="text-sm">Circuit breaker healthy</span></div>
              <div className="hstack"><Icons.Warn size={14} style={{color:"var(--amber-fg)"}}/><span className="text-sm">Last broadcast was 28h ago</span></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

window.BroadcastNew = BroadcastNew;
