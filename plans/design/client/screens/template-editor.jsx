/* Template editor — WYSIWYG-style two-pane */

function TemplateEditor({ slug = "welcome-1", setRoute }) {
  const tpl = sample.templates.find(t => t.slug === slug) || sample.templates[0];
  const [view, setView] = React.useState("design"); // design | source | plaintext

  return (
    <>
      <PageHead
        title={tpl.name}
        desc={<><span className="mono">templates/{tpl.slug}</span> · <span className={"pill "+(tpl.kind==="transactional"?"blue":"neutral")} style={{marginLeft:4}}>{tpl.kind}</span></>}
        actions={
          <>
            <button className="btn"><Icons.Eye size={14}/>Preview</button>
            <button className="btn"><Icons.Send size={14}/>Test send</button>
            <button className="btn"><Icons.Copy size={14}/>Duplicate</button>
            <button className="btn btn-primary"><Icons.Rocket size={14}/>Publish</button>
          </>
        }
      />

      <div className="split split-asym" style={{gap:16}}>
        <div className="card">
          <div className="card-head">
            <div className="seg">
              <span className={"seg-item"+(view==="design"?" active":"")} onClick={()=>setView("design")}>Design</span>
              <span className={"seg-item"+(view==="source"?" active":"")} onClick={()=>setView("source")}>MJML</span>
              <span className={"seg-item"+(view==="plaintext"?" active":"")} onClick={()=>setView("plaintext")}>Plain text</span>
            </div>
            <div className="card-actions">
              <span className="text-xs subtle">Auto-saved 12s ago</span>
              <button className="icon-btn"><Icons.Help size={14}/></button>
            </div>
          </div>

          <div style={{padding:16}}>
            <div className="field">
              <label className="field-label">Subject</label>
              <input className="input" defaultValue="Welcome to StoryFolder, {{firstName}} 👋" />
            </div>
            <div className="field">
              <label className="field-label">Preheader</label>
              <input className="input" defaultValue="Three things to try in your first 5 minutes." />
            </div>
          </div>

          {view === "design" && (
            <div className="email-preview" style={{borderRadius:0, borderLeft:0, borderRight:0}}>
              <div className="email-frame">
                <div style={{height:8, background:"var(--accent)"}} />
                <div style={{padding:"40px 32px 16px", textAlign:"center"}}>
                  <div style={{width:40,height:40,margin:"0 auto",borderRadius:10,background:"linear-gradient(135deg,#f97316,#fdba74)",display:"grid",placeItems:"center",color:"#fff",fontWeight:700}}>S</div>
                </div>
                <div style={{padding:"8px 40px 32px", color:"#1c1917"}}>
                  <h1 style={{fontSize:24, margin:"16px 0 12px", fontWeight:600}}>Welcome to StoryFolder, <span style={{background:"#fff4e6",padding:"0 4px",borderRadius:4}}>{"{{firstName}}"}</span></h1>
                  <p style={{color:"#57534e", margin:"0 0 20px", fontSize:15, lineHeight:1.6}}>You're in. Here are three things to try in your first 5 minutes — most teams pick one and run with it.</p>
                  <div style={{display:"grid", gap:12, marginBottom:24}}>
                    {[
                      ["1.","Import an existing storyboard","Drop a PDF or Figma file."],
                      ["2.","Pick a starter template","Production, brand, or short-form."],
                      ["3.","Invite a teammate","StoryFolder is better collaborative."],
                    ].map(([n,h,p])=>(
                      <div key={n} style={{display:"flex",gap:12,padding:14,border:"1px solid #ebe9e4",borderRadius:10}}>
                        <div style={{width:24,height:24,borderRadius:6,background:"#fff4e6",color:"#ea580c",fontWeight:700,display:"grid",placeItems:"center",flex:"0 0 auto"}}>{n}</div>
                        <div>
                          <div style={{fontWeight:600,fontSize:14}}>{h}</div>
                          <div style={{fontSize:13,color:"#57534e"}}>{p}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <a style={{display:"inline-block",background:"#f97316",color:"#fff",padding:"10px 18px",borderRadius:8,fontWeight:600,fontSize:14,textDecoration:"none"}}>Open StoryFolder</a>
                </div>
                <div style={{padding:"24px 40px", borderTop:"1px solid #ebe9e4", fontSize:11, color:"#8a857d", textAlign:"center"}}>
                  StoryFolder · 12 Main Street, Brooklyn NY 11201 · <a style={{color:"#8a857d", textDecoration:"underline"}}>Unsubscribe</a>
                </div>
              </div>
            </div>
          )}

          {view === "source" && (
            <pre className="code" style={{margin:16,padding:16,maxHeight:520,overflow:"auto"}}>
{`<mjml>
  <mj-head>
    <mj-attributes>
      <mj-all font-family="Inter, sans-serif" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#fafaf9">
    <mj-section padding="40px 0 16px">
      <mj-column>
        <mj-image src="{{logoUrl}}" width="40px" />
      </mj-column>
    </mj-section>
    <mj-section>
      <mj-column>
        <mj-text font-size="24px" font-weight="600">
          Welcome to StoryFolder, `}<span className="k">{"{{firstName}}"}</span>{`
        </mj-text>
        <mj-text color="#57534e" line-height="1.6">
          You're in. Here are three things to try…
        </mj-text>
        <mj-button background-color="#f97316" href="{{appUrl}}" border-radius="8px">
          Open StoryFolder
        </mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`}
            </pre>
          )}

          {view === "plaintext" && (
            <pre className="code" style={{margin:16,padding:16}}>
{`Welcome to StoryFolder, {{firstName}}

You're in. Here are three things to try in your first 5 minutes:

  1. Import an existing storyboard — drop a PDF or Figma file.
  2. Pick a starter template — production, brand, or short-form.
  3. Invite a teammate — StoryFolder is better collaborative.

Open StoryFolder: {{appUrl}}

—
StoryFolder · 12 Main Street, Brooklyn NY 11201
Unsubscribe: {{unsubscribeUrl}}`}
            </pre>
          )}
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div className="card">
            <div className="card-head"><span className="card-title">Sender</span></div>
            <div className="card-body">
              <div className="field">
                <label className="field-label">From name</label>
                <input className="input" defaultValue="Jeff at StoryFolder" />
              </div>
              <div className="field">
                <label className="field-label">From email</label>
                <input className="input" defaultValue="jeff@storyfolder.com" />
              </div>
              <div className="field" style={{marginBottom:0}}>
                <label className="field-label">Reply-to</label>
                <input className="input" defaultValue="hello@storyfolder.com" />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Variables</span><span className="card-sub">Used in subject/body</span></div>
            <div className="card-body">
              {[
                ["firstName","string","required"],
                ["appUrl","url","required"],
                ["logoUrl","url","optional · default"],
                ["unsubscribeUrl","url","auto-injected"],
              ].map(([n,t,r])=>(
                <div key={n} className="hstack" style={{padding:"6px 0",borderBottom:"1px solid var(--border)"}}>
                  <span className="mono text-sm">{n}</span>
                  <span className="grow" />
                  <span className="tag">{t}</span>
                  <span className="text-xs subtle">{r}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Tracking & lint</span></div>
            <div className="card-body" style={{display:"grid",gap:8}}>
              <div className="hstack"><Icons.Check size={14} style={{color:"var(--green-fg)"}}/><span className="text-sm">Unsubscribe link present</span></div>
              <div className="hstack"><Icons.Check size={14} style={{color:"var(--green-fg)"}}/><span className="text-sm">Postal address present</span></div>
              <div className="hstack"><Icons.Check size={14} style={{color:"var(--green-fg)"}}/><span className="text-sm">No broken merge tags</span></div>
              <div className="hstack"><Icons.Warn size={14} style={{color:"var(--amber-fg)"}}/><span className="text-sm">Open tracking enabled — beware Apple MPP</span></div>
              <div className="divider" style={{margin:"4px 0"}}/>
              <div className="hstack"><span className="text-sm">Track opens</span><span className="grow"/><div className="toggle on"><div className="track"><div className="knob"/></div></div></div>
              <div className="hstack"><span className="text-sm">Track clicks</span><span className="grow"/><div className="toggle on"><div className="track"><div className="knob"/></div></div></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

window.TemplateEditor = TemplateEditor;
