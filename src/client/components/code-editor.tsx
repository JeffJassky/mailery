/* Thin React wrapper around Monaco.
 *
 * Monaco is bundled here rather than pulled from a CDN because the admin SPA
 * has no server-side rendering step and no network guarantees at build time
 * — everything it ships has to be self-hosted, the same reason
 * `@maily-to/core` is a devDependency instead of a runtime one. This module
 * is loaded lazily (`React.lazy`) by the template editor, since most screens
 * never open a template and most templates aren't HTML-authored — no reason
 * to pay Monaco's ~1MB in the initial bundle.
 */
import React from 'react'
// Import the editor API plus only the HTML language, rather than the
// `monaco-editor` barrel: the barrel drags in every language Monaco ships
// (TypeScript, JSON, CSS, ~90 grammars) and their workers, which is several
// megabytes of chunk for a tab that only ever edits HTML.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/language/html/monaco.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

// Monaco runs its language services off-thread. Vite's `?worker` imports give
// us real bundled worker chunks, so the admin UI stays self-hosted — no CDN.
;(self as any).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    return new EditorWorker()
  },
}

function currentTheme(): string {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs'
}

export interface CodeEditorProps {
  value: string
  language: string // 'html' for our use
  readOnly?: boolean
  onChange?: (value: string) => void
  height?: number // default 520
}

export default function CodeEditor(props: CodeEditorProps): JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const editorRef = React.useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // Keep the latest onChange in a ref so the Monaco listener (attached once,
  // at creation) always calls the current callback without needing the
  // editor to be torn down and recreated when the parent passes a fresh
  // inline arrow function on every render.
  const onChangeRef = React.useRef(props.onChange)
  onChangeRef.current = props.onChange

  // Create the editor once and dispose it on unmount — never recreate it on
  // every render, which would blow away cursor position and undo history.
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const editor = monaco.editor.create(container, {
      value: props.value,
      language: props.language,
      readOnly: props.readOnly,
      theme: currentTheme(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderLineHighlight: 'line',
    })
    editorRef.current = editor

    const sub = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue())
    })

    const themeObserver = new MutationObserver(() => monaco.editor.setTheme(currentTheme()))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      themeObserver.disconnect()
      sub.dispose()
      editor.getModel()?.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Controlled-value sync. The `!==` guard prevents feedback loops: without
  // it, typing would fire onChange -> parent state update -> this effect ->
  // setValue, resetting the cursor mid-keystroke.
  React.useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (editor.getValue() !== props.value) editor.setValue(props.value)
  }, [props.value])

  // readOnly is applied via updateOptions so toggling it doesn't force a
  // recreate of the editor instance.
  React.useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: props.readOnly })
  }, [props.readOnly])

  return (
    <div
      ref={containerRef}
      style={{ height: props.height ?? 520, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}
    />
  )
}
