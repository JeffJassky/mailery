/* Templates list */

function Templates({ setRoute }) {
  const [tab, setTab] = React.useState("all");
  const filtered = sample.templates.filter(t => tab==="all" ? true : t.kind===tab);
  return (
    <>
      <PageHead
        title="Templates"
        desc="Email content · MJML source, auto-derived plain text."
        actions={
          <>
            <button className="btn"><Icons.Code size={14} />Import MJML</button>
            <button className="btn btn-primary"><Icons.Plus size={14} />New template</button>
          </>
        }
      />

      <div className="tabs">
        <div className={"tab"+(tab==="all"?" active":"")} onClick={()=>setTab("all")}>All<span className="tab-count">{sample.templates.length}</span></div>
        <div className={"tab"+(tab==="marketing"?" active":"")} onClick={()=>setTab("marketing")}>Marketing<span className="tab-count">{sample.templates.filter(t=>t.kind==="marketing").length}</span></div>
        <div className={"tab"+(tab==="transactional"?" active":"")} onClick={()=>setTab("transactional")}>Transactional<span className="tab-count">{sample.templates.filter(t=>t.kind==="transactional").length}</span></div>
      </div>

      <div className="filter-bar">
        <span className="filter-chip"><Icons.Filter size={12}/>Tag: any</span>
        <span className="filter-chip">Sort: recent</span>
        <span className="grow" />
        <span className="text-xs subtle">Compiled MJML cached · last rebuild 4 min ago</span>
      </div>

      <div className="card card-pad-0">
        <table className="table">
          <thead>
            <tr>
              <th>Template</th>
              <th>Kind</th>
              <th>Last sent</th>
              <th className="num">Sent 7d</th>
              <th className="num">Open rate</th>
              <th className="num">Click rate</th>
              <th style={{width:32}}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <tr key={t.slug} onClick={()=>setRoute({screen:"template-editor", slug:t.slug})}>
                <td>
                  <div className="hstack">
                    <div style={{width:32,height:32,borderRadius:6,background:"var(--bg-sunken)",display:"grid",placeItems:"center",color:"var(--fg-muted)"}}>
                      <Icons.Mail size={14}/>
                    </div>
                    <div>
                      <div className="f500">{t.name}</div>
                      <div className="text-xs subtle mono">{t.slug}</div>
                    </div>
                  </div>
                </td>
                <td><span className={"pill "+(t.kind==="transactional"?"blue":"neutral")}>{t.kind}</span></td>
                <td className="text-xs subtle">{t.lastSent}</td>
                <td className="num tabular">{t.sent7d.toLocaleString()}</td>
                <td className="num tabular">{(t.openRate*100).toFixed(1)}%</td>
                <td className="num tabular">{(t.clickRate*100).toFixed(1)}%</td>
                <td><Icons.Dots size={14}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

window.Templates = Templates;
