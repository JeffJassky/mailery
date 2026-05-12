/* Audit log */

function Audit({ setRoute }) {
  return (
    <>
      <PageHead
        title="Audit log"
        desc="Every mutating action. Append-only. Diffs available on click."
        actions={<button className="btn"><Icons.Download size={14}/>Export</button>}
      />

      <div className="filter-bar">
        <span className="filter-chip active">All actors</span>
        <span className="filter-chip">Action: any</span>
        <span className="filter-chip">Resource: any</span>
        <span className="filter-chip">Last 24h</span>
      </div>

      <div className="card card-pad-0">
        <table className="table">
          <thead>
            <tr><th>Actor</th><th>Action</th><th>Resource</th><th>Detail</th><th>Time</th><th style={{width:32}}></th></tr>
          </thead>
          <tbody>
            {sample.audit.map((e,i)=>{
              const isHuman = e.actor.startsWith("human:");
              const isSys = e.actor.startsWith("system:");
              return (
                <tr key={i}>
                  <td>
                    <div className="hstack">
                      <div style={{width:22,height:22,borderRadius:5,
                        background: isHuman?"var(--violet-soft)": isSys?"var(--blue-soft)":"var(--accent-soft)",
                        color: isHuman?"var(--violet-fg)": isSys?"var(--blue-fg)":"var(--accent-press)",
                        display:"grid",placeItems:"center"}}>
                        {isHuman ? <Icons.Contacts size={11}/> : isSys ? <Icons.Settings size={11}/> : <Icons.Sparkles size={11}/>}
                      </div>
                      <span className="text-xs mono">{e.actor}</span>
                    </div>
                  </td>
                  <td><span className="tag">{e.action}</span></td>
                  <td className="mono text-xs">{e.target}</td>
                  <td className="text-xs subtle">{e.note}</td>
                  <td className="text-xs subtle">{e.time}</td>
                  <td><Icons.Chevron size={12}/></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

window.Audit = Audit;
