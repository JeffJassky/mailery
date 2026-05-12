/* App — routing */

const SCREENS = {
  dashboard:        { Comp: (r) => <Dashboard setRoute={setRouteGlobal}/>,                     crumbs: () => ["Mailery", "Dashboard"] },
  flows:            { Comp: (r) => <Flows setRoute={setRouteGlobal}/>,                         crumbs: () => ["Mailery", "Flows"] },
  "flow-detail":    { Comp: (r) => <FlowDetail slug={r.slug} setRoute={setRouteGlobal}/>,     crumbs: (r) => ["Mailery", "Flows", r.slug || "activation-rescue"] },
  templates:        { Comp: (r) => <Templates setRoute={setRouteGlobal}/>,                     crumbs: () => ["Mailery", "Templates"] },
  "template-editor":{ Comp: (r) => <TemplateEditor slug={r.slug} setRoute={setRouteGlobal}/>, crumbs: (r) => ["Mailery", "Templates", r.slug || "welcome-1"] },
  broadcasts:       { Comp: (r) => <Broadcasts setRoute={setRouteGlobal}/>,                    crumbs: () => ["Mailery", "Broadcasts"] },
  "broadcast-new":  { Comp: (r) => <BroadcastNew setRoute={setRouteGlobal}/>,                  crumbs: () => ["Mailery", "Broadcasts", "New"] },
  contacts:         { Comp: (r) => <Contacts setRoute={setRouteGlobal}/>,                      crumbs: () => ["Mailery", "Contacts"] },
  "contact-detail": { Comp: (r) => <ContactDetail id={r.id} setRoute={setRouteGlobal}/>,      crumbs: (r) => ["Mailery", "Contacts", r.id || "u_2018f"] },
  sends:            { Comp: (r) => <Sends setRoute={setRouteGlobal}/>,                         crumbs: () => ["Mailery", "Sends"] },
  "send-detail":    { Comp: (r) => <SendDetail id={r.id} setRoute={setRouteGlobal}/>,         crumbs: (r) => ["Mailery", "Sends", r.id || "snd_8a2c"] },
  suppressions:     { Comp: (r) => <Suppressions setRoute={setRouteGlobal}/>,                  crumbs: () => ["Mailery", "Suppressions"] },
  audit:            { Comp: (r) => <Audit setRoute={setRouteGlobal}/>,                         crumbs: () => ["Mailery", "Audit log"] },
  health:           { Comp: (r) => <Health setRoute={setRouteGlobal}/>,                        crumbs: () => ["Mailery", "Health"] },
};

let setRouteGlobal = () => {};

function App() {
  const [route, setRoute] = React.useState({ screen: "dashboard" });
  const [theme, setTheme] = React.useState("light");

  setRouteGlobal = setRoute;

  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const cur = SCREENS[route.screen] || SCREENS.dashboard;
  const crumbs = cur.crumbs(route);

  const counts = { flows: sample.flows.length, templates: sample.templates.length, broadcasts: sample.broadcasts.length };

  return (
    <div className="app">
      <Sidebar route={route} setRoute={setRoute} counts={counts}/>
      <div className="main">
        <Topbar crumbs={crumbs} theme={theme} setTheme={setTheme}/>
        <div className="content" data-screen-label={route.screen}>
          <div className="content-inner">
            {cur.Comp(route)}
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
