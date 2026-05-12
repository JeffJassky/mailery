/* Contact detail */

function ContactDetail({ id="u_2018f", setRoute }) {
  const c = sample.contacts.find(x=>x.id===id) || sample.contacts[0];
  const events = [
    { name:"Exported", time:"2 h ago", props:"{ format: 'pdf' }" },
    { name:"Viewed Storyboard", time:"3 h ago", props:"{ id: 'sb_82a' }" },
    { name:"Uploaded", time:"5 h ago", props:"{ size: 14.2MB }" },
    { name:"Activated app", time:"2 d ago" },
    { name:"Downloaded app", time:"3 d ago" },
    { name:"Created", time:"3 d ago" },
  ];
  const sends = sample.sends.filter(s=>s.to===c.email).concat(sample.sends.slice(0,4));
  return (
    <>
      <PageHead
        title={c.name}
        desc={<><span className="mono">{c.email}</span> · {c.tier} · <span className="mono">{c.id}</span></>}
        actions={
          <>
            <button className="btn"><Icons.Send size={14}/>Resend last</button>
            <button className="btn"><Icons.Tag size={14}/>Add tag</button>
            <button className="btn btn-danger"><Icons.Shield size={14}/>Unsubscribe</button>
          </>
        }
      />

      <div className="split split-asym">
        <div className="vstack" style={{gap:16}}>
          <div className="card">
            <div className="card-head"><span className="card-title">Active flow runs</span></div>
            <div className="card-body" style={{padding:0}}>
              <table className="table">
                <thead><tr><th>Flow</th><th>Current step</th><th>Next action</th><th>Entered</th></tr></thead>
                <tbody>
                  <tr><td className="mono">activation-rescue</td><td>Step 3 · Send</td><td>in 11h 24m</td><td className="subtle text-xs">2 d ago</td></tr>
                  <tr><td className="mono">welcome</td><td>Step 5 · Wait</td><td>in 2d 4h</td><td className="subtle text-xs">3 d ago</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card card-pad-0">
            <div className="card-head"><span className="card-title">Events</span><span className="card-sub">Last 50 · append-only</span></div>
            <div style={{padding:"4px 16px 12px"}}>
              {events.map((e,i)=>(
                <div key={i} className="hstack" style={{padding:"10px 0",borderBottom:i<events.length-1?"1px solid var(--border)":""}}>
                  <div style={{width:24,height:24,borderRadius:6,background:"var(--accent-soft)",color:"var(--accent-press)",display:"grid",placeItems:"center"}}>
                    <Icons.Activity size={12}/>
                  </div>
                  <div>
                    <div className="text-sm f500">{e.name}</div>
                    {e.props && <div className="mono text-xs subtle">{e.props}</div>}
                  </div>
                  <span className="grow"/>
                  <span className="text-xs subtle">{e.time}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card card-pad-0">
            <div className="card-head"><span className="card-title">Recent sends</span></div>
            <table className="table">
              <thead><tr><th>Template</th><th>Status</th><th>Opens</th><th>Clicks</th><th>When</th></tr></thead>
              <tbody>
                {sends.slice(0,6).map((s,i)=>(
                  <tr key={i}>
                    <td className="mono text-xs">{s.template}</td>
                    <td><StatusPill status={s.status}/></td>
                    <td className="tabular">{s.opens}</td>
                    <td className="tabular">{s.clicks}</td>
                    <td className="text-xs subtle">{s.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="vstack" style={{gap:16}}>
          <div className="card">
            <div className="card-head"><span className="card-title">Subscription</span></div>
            <div className="card-body" style={{display:"grid",gap:8}}>
              <div className="hstack"><span className="text-sm subtle">Status</span><span className="grow"/><StatusPill status={c.status==="pending_doi"?"queued":c.status}/></div>
              <div className="hstack"><span className="text-sm subtle">Source</span><span className="grow"/><span className="mono text-xs">signup</span></div>
              <div className="hstack"><span className="text-sm subtle">Subscribed</span><span className="grow"/><span className="text-xs">3 d ago</span></div>
              <div className="hstack"><span className="text-sm subtle">Email at subscribe</span><span className="grow"/><span className="mono text-xs">{c.email}</span></div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Adapter fields</span><span className="card-sub">From host users.find</span></div>
            <div className="card-body">
              <pre className="code" style={{margin:0,padding:12}}>{`{`}
{`  `}<span className="k">"externalId"</span>: <span className="s">"{c.id}"</span>,
{`  `}<span className="k">"email"</span>: <span className="s">"{c.email}"</span>,
{`  `}<span className="k">"tags"</span>: [{c.tags.map((t,i)=>(<span key={t}><span className="s">"{t}"</span>{i<c.tags.length-1?", ":""}</span>))}],
{`  `}<span className="k">"timezone"</span>: <span className="s">"America/New_York"</span>,
{`  `}<span className="k">"fields"</span>: {`{`}
{`    `}<span className="k">"firstName"</span>: <span className="s">"{c.name.split(" ")[0]}"</span>,
{`    `}<span className="k">"customerType"</span>: <span className="s">"{c.tier}"</span>
{`  }`}
{`}`}</pre>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Suppression check</span></div>
            <div className="card-body" style={{display:"grid",gap:8}}>
              <div className="hstack"><Icons.Check size={14} style={{color:"var(--green-fg)"}}/><span className="text-sm">Not suppressed (marketing)</span></div>
              <div className="hstack"><Icons.Check size={14} style={{color:"var(--green-fg)"}}/><span className="text-sm">Not suppressed (transactional)</span></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

window.ContactDetail = ContactDetail;
