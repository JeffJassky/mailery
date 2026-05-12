/* Send detail */

function SendDetail({ id="snd_8a2c", setRoute }) {
  const s = sample.sends.find(x=>x.id===id) || sample.sends[3];
  const timeline = [
    { at:"14:02:18.244", t:"queued", desc:"Enqueued via flow runner · attempt 1" },
    { at:"14:02:18.391", t:"sending", desc:"SendGrid POST /mail/send" },
    { at:"14:02:18.842", t:"sent", desc:"Provider 202 · messageId mlt-3f9e2c" },
    { at:"14:02:21.118", t:"delivered", desc:"Webhook · delivered" },
    { at:"14:08:12.402", t:"opened", desc:"Open · GMail · Chrome / macOS" },
    { at:"14:09:01.847", t:"clicked", desc:"Click · /storyboards/new" },
  ];
  return (
    <>
      <PageHead
        title={<span className="mono">{s.id}</span>}
        desc={<>Sent to <span className="mono">{s.to}</span></>}
        actions={
          <>
            <button className="btn"><Icons.Eye size={14}/>View as HTML</button>
            <button className="btn"><Icons.Send size={14}/>Resend</button>
          </>
        }
      />

      <div className="split split-asym">
        <div className="vstack" style={{gap:16}}>
          <div className="card">
            <div className="card-head"><span className="card-title">Status timeline</span><div className="card-actions"><StatusPill status="clicked"/></div></div>
            <div className="card-body">
              <div style={{position:"relative", paddingLeft:24}}>
                <div style={{position:"absolute", left:7, top:6, bottom:6, width:2, background:"var(--border)"}} />
                {timeline.map((e,i)=>(
                  <div key={i} style={{position:"relative", paddingBottom:14}}>
                    <div style={{position:"absolute", left:-21, top:4, width:12, height:12, borderRadius:"50%",
                      background: i===timeline.length-1?"var(--accent)":"var(--bg-elev)",
                      border:"2px solid "+(i===timeline.length-1?"var(--accent)":"var(--border-strong)")}}/>
                    <div className="hstack"><span className="text-sm f500" style={{textTransform:"capitalize"}}>{e.t}</span><span className="grow"/><span className="text-xs subtle mono">{e.at}</span></div>
                    <div className="text-xs subtle">{e.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Rendered HTML preview</span></div>
            <div className="email-preview" style={{borderRadius:0, borderLeft:0, borderRight:0, padding:24, minHeight:340}}>
              <div className="email-frame">
                <div style={{padding:"36px 32px 32px"}}>
                  <div style={{fontWeight:600, fontSize:18, color:"#1c1917"}}>Pick up where you left off, Mira</div>
                  <p style={{color:"#57534e", marginTop:8}}>Your "Q2 Brand Anthem" storyboard has 3 unfinished frames. Open it in one click.</p>
                  <a style={{display:"inline-block",background:"#f97316",color:"#fff",padding:"8px 14px",borderRadius:6,fontWeight:600,fontSize:13, marginTop:8}}>Resume storyboard →</a>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="vstack" style={{gap:16}}>
          <div className="card">
            <div className="card-head"><span className="card-title">Metadata</span></div>
            <div className="card-body" style={{display:"grid",gap:8, fontSize:13}}>
              {[
                ["Template", <span className="mono">{s.template}</span>],
                ["Kind", <span className="pill neutral">marketing</span>],
                ["Provider", <span className="mono">sendgrid</span>],
                ["Provider message ID", <span className="mono text-xs">mlt-3f9e2c</span>],
                ["Flow run", <span className="mono text-xs">fr_8c12a · step 3</span>],
                ["From", <span className="mono text-xs">jeff@storyfolder.com</span>],
                ["Subject", "Pick up where you left off"],
                ["Body hash", <span className="mono text-xs">sha256:8c12…2f</span>],
                ["dedupeKey", <span className="mono text-xs">flow:activation-rescue:step3:u_2018c</span>],
              ].map(([k,v])=>(
                <div key={k} className="hstack" style={{alignItems:"baseline"}}>
                  <span className="subtle" style={{width:140, flex:"0 0 auto"}}>{k}</span>
                  <span style={{textAlign:"right", flex:1}}>{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Webhook events</span><span className="card-sub">3 received</span></div>
            <div className="card-body" style={{display:"grid",gap:8}}>
              {[
                ["delivered","14:02:21","sg_event_id 7d2…"],
                ["open","14:08:12","sg_event_id 7d3…"],
                ["click","14:09:01","sg_event_id 7d4…"],
              ].map(([t,at,id])=>(
                <div key={id} className="hstack">
                  <StatusPill status={t}/>
                  <span className="grow"/>
                  <span className="text-xs subtle mono">{at}</span>
                  <span className="text-xs subtle mono">{id}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

window.SendDetail = SendDetail;
