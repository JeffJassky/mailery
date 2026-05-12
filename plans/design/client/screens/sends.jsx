/* Sends log */

function Sends({ setRoute }) {
  return (
    <>
      <PageHead
        title="Sends"
        desc="Every send. Live status from provider webhooks."
        actions={<button className="btn"><Icons.Download size={14}/>Export CSV</button>}
      />

      <div className="filter-bar">
        <span className="filter-chip active">Last 1h</span>
        <span className="filter-chip">Template: any</span>
        <span className="filter-chip">Status: any</span>
        <span className="filter-chip">Flow: any</span>
        <span className="grow"/>
        <span className="text-xs subtle tabular">12 of 1,284 in window</span>
      </div>

      <div className="card card-pad-0">
        <table className="table">
          <thead>
            <tr>
              <th>id</th><th>Template</th><th>To</th><th>Status</th><th>Flow</th>
              <th className="num">Opens</th><th className="num">Clicks</th><th>Time</th>
            </tr>
          </thead>
          <tbody>
            {sample.sends.map(s=>(
              <tr key={s.id} onClick={()=>setRoute({screen:"send-detail", id:s.id})}>
                <td className="mono text-xs">{s.id}</td>
                <td className="mono">{s.template}</td>
                <td className="text-xs">{s.to}</td>
                <td>
                  <StatusPill status={s.status}/>
                  {s.bounce && <span className="text-xs subtle" style={{marginLeft:6}}>· {s.bounce}</span>}
                </td>
                <td>{s.flow ? <span className="tag">{s.flow}</span> : <span className="subtle text-xs">—</span>}</td>
                <td className="num tabular">{s.opens}</td>
                <td className="num tabular">{s.clicks}</td>
                <td className="text-xs subtle">{s.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

window.Sends = Sends;
