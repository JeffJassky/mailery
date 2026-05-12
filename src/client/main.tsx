import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app'
// Order matters: load Maily's bundled Tailwind utilities BEFORE our overrides,
// so our scoped admin styles win on conflicting selectors. Maily's `exports`
// map doesn't include the CSS, so we reach in via a relative path.
import '../../node_modules/@maily-to/core/dist/index.css'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
