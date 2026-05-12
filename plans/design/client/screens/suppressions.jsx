/* Suppressions list */

function Suppressions({ setRoute }) {
  return (
    <>
      <PageHead
        title="Suppressions"
        desc="Do-not-send list scoped by kind. Auto-added on hard bounce, complaint, or unsubscribe."
        actions={
          <>
            <button className="btn"><Icons.Download size={14}/>Export CSV</button>
            <button className="btn btn-primary"><Icons.Plus size={14}/>Add suppression</button>
          </>
        }
      />

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Total suppressed</div><div className="kpi-value">218</div><div className="kpi-meta subtle">All scopes</div></div>
        <div className="kpi"><div className="kpi-label">Hard bounce</div><div className="kpi-value">94</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Complaints</div><div className="kpi-value">12</div><div className="kpi-meta subtle">All-time</div></div>
        <div className="kpi"><div className="kpi-label">Unsubscribed</div><div className="kpi-value">98</div><div className="kpi-meta"><span className="kpi-delta up">▲ 4</span> last 24h</div></div>
      </div>

      <div className="filter-bar">
        <span className="filter-chip">Reason: any</span>
        <span className="filter-chip">Scope: any</span>
        <span className="filter-chip">Source: any</span>
        <span className="grow"/>
        <input className="input" style={{maxWidth:240}} placeholder="Search email…"/>
      </div>

      <div className="card card-pad-0">
        <table className="table">
          <thead>
            <tr><th>Email</th><th>Scope</th><th>Reason</th><th>Source</th><th>Added</th><th style={{width:32}}></th></tr>
          </thead>
          <tbody>
            {sample.suppressions.map((s,i)=>(
              <tr key={i}>
                <td className="mono text-xs">{s.email}</td>
                <td><span className={"pill "+(s.scope==="all"?"red":"amber")}>{s.scope}</span></td>
                <td><span className="tag">{s.reason}</span></td>
                <td className="text-xs subtle mono">{s.source}</td>
                <td className="text-xs subtle">{s.added}</td>
                <td><Icons.Dots size={14}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

window.Suppressions = Suppressions;
