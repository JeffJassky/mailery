/* App — routing */
import React from 'react'
import { Sidebar, Topbar } from './components/shell'
import { api, type MePayload } from './lib/api'
import { useLive } from './lib/use-live'
import { Dashboard } from './screens/dashboard'
import { Flows } from './screens/flows'
import { FlowDetail } from './screens/flow-detail'
import { Templates } from './screens/templates'
// Maily editor is heavy (~1MB before split). Lazy-load it so the rest of the
// SPA stays fast — the Maily chunk only loads when a user opens a template.
const TemplateEditor = React.lazy(() =>
  import('./screens/template-editor').then((m) => ({ default: m.TemplateEditor })),
)
import { Broadcasts } from './screens/broadcasts'
import { BroadcastNew } from './screens/broadcast-new'
import { Contacts } from './screens/contacts'
import { ContactDetail } from './screens/contact-detail'
import { Sends } from './screens/sends'
import { SendDetail } from './screens/send-detail'
import { Suppressions } from './screens/suppressions'
import { Audit } from './screens/audit'
import { Health } from './screens/health'
import { ListHygiene } from './screens/hygiene'

type Route = { screen: string; slug?: string; id?: string }
type SetRoute = (r: Route) => void

const SCREENS: Record<string, { Comp: (r: Route, setRoute: SetRoute) => React.ReactNode; crumbs: (r: Route) => string[] }> = {
  dashboard:         { Comp: (_r, setRoute) => <Dashboard setRoute={setRoute} />,                       crumbs: () => ['Mailery', 'Dashboard'] },
  flows:             { Comp: (_r, setRoute) => <Flows setRoute={setRoute} />,                           crumbs: () => ['Mailery', 'Flows'] },
  'flow-detail':     { Comp: (r, setRoute) => <FlowDetail slug={r.slug} setRoute={setRoute} />,         crumbs: (r) => ['Mailery', 'Flows', r.slug ?? ''] },
  templates:         { Comp: (_r, setRoute) => <Templates setRoute={setRoute} />,                       crumbs: () => ['Mailery', 'Templates'] },
  'template-editor': {
    Comp: (r, setRoute) => (
      <React.Suspense fallback={<div style={{ padding: 32, color: 'var(--fg-subtle)' }}>Loading editor…</div>}>
        <TemplateEditor slug={r.slug} setRoute={setRoute} />
      </React.Suspense>
    ),
    crumbs: (r) => ['Mailery', 'Templates', r.slug ?? ''],
  },
  broadcasts:        { Comp: (_r, setRoute) => <Broadcasts setRoute={setRoute} />,                      crumbs: () => ['Mailery', 'Broadcasts'] },
  'broadcast-new':   { Comp: (r, setRoute) => <BroadcastNew setRoute={setRoute} slug={r.slug} />,       crumbs: (r) => ['Mailery', 'Broadcasts', r.slug ?? 'New'] },
  contacts:          { Comp: (_r, setRoute) => <Contacts setRoute={setRoute} />,                        crumbs: () => ['Mailery', 'Contacts'] },
  'contact-detail':  { Comp: (r, setRoute) => <ContactDetail id={r.id} setRoute={setRoute} />,          crumbs: (r) => ['Mailery', 'Contacts', r.id ?? ''] },
  sends:             { Comp: (_r, setRoute) => <Sends setRoute={setRoute} />,                           crumbs: () => ['Mailery', 'Sends'] },
  'send-detail':     { Comp: (r, setRoute) => <SendDetail id={r.id} setRoute={setRoute} />,             crumbs: (r) => ['Mailery', 'Sends', r.id ?? ''] },
  suppressions:      { Comp: (_r, setRoute) => <Suppressions setRoute={setRoute} />,                    crumbs: () => ['Mailery', 'Suppressions'] },
  audit:             { Comp: (_r, setRoute) => <Audit setRoute={setRoute} />,                           crumbs: () => ['Mailery', 'Audit log'] },
  health:            { Comp: (_r, setRoute) => <Health setRoute={setRoute} />,                          crumbs: () => ['Mailery', 'Health'] },
  hygiene:           { Comp: (_r, _setRoute) => <ListHygiene />,                                        crumbs: () => ['Mailery', 'List hygiene'] },
}

export function App() {
  const [route, setRoute] = React.useState<Route>({ screen: 'dashboard' })
  const [theme, setTheme] = React.useState('light')
  const { data: me } = useLive<MePayload>(() => api.me())

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const cur = SCREENS[route.screen] || SCREENS.dashboard
  const crumbs = cur.crumbs(route)

  return (
    <div className="app">
      <Sidebar route={route} setRoute={setRoute} me={me} />
      <div className="main">
        <Topbar crumbs={crumbs} theme={theme} setTheme={setTheme} />
        <div className="content" data-screen-label={route.screen}>
          <div className="content-inner">{cur.Comp(route, setRoute)}</div>
        </div>
      </div>
    </div>
  )
}
