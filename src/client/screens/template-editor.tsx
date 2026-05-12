/* Template editor — Design (Maily WYSIWYG) / MJML / Plain text */
import React from 'react'
import { Editor as MailyEditor } from '@maily-to/core'
import type { Editor as TiptapEditor, JSONContent } from '@tiptap/core'

import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState } from '../lib/load-state'

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

export function TemplateEditor({ slug }: any) {
  const { data: tpl, loading, error, refetch } = useLive(() => api.template(slug))

  return (
    <LoadState loading={loading && !tpl} error={error} empty={!tpl} emptyLabel="Template not found." retry={refetch}>
      {tpl && <Body tpl={tpl} slug={slug} refetch={refetch} />}
    </LoadState>
  )
}

function Body({ tpl, slug, refetch }: { tpl: any; slug: string; refetch: () => void }) {
  const [view, setView] = React.useState<'design' | 'source' | 'plaintext'>('design')
  const [editorJson, setEditorJson] = React.useState<JSONContent>(EMPTY_DOC)
  const [subject, setSubject] = React.useState<string>(tpl.draft?.subject ?? tpl.subject ?? '')
  const [preheader, setPreheader] = React.useState<string>(tpl.draft?.preheader ?? tpl.preheader ?? '')
  const [dirty, setDirty] = React.useState(false)
  const [status, setStatus] = React.useState<string>('')
  const [busy, setBusy] = React.useState(false)
  const editorRef = React.useRef<TiptapEditor | null>(null)
  const hydratedRef = React.useRef(false)

  const tplKind = tpl.kind ?? 'marketing'
  const tplName = tpl.name ?? slug
  const tplSlug = tpl.slug ?? slug
  const mjmlSource = tpl.body?.mjml ?? tpl.draft?.mjml ?? ''
  const plainText = tpl.body?.plainText ?? ''

  React.useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    const incoming = tpl.draft?.editorJson ?? tpl.body?.editorJson
    if (incoming) setEditorJson(incoming)
  }, [tpl])

  async function publish() {
    setBusy(true)
    setStatus('Saving draft…')
    try {
      await api.updateTemplateDraft(slug, { subject, preheader, editorJson })
      setStatus('Publishing…')
      const out = await api.publishTemplate(slug)
      setStatus(`Published v${out.version}`)
      setDirty(false)
      refetch()
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead
        title={tplName}
        desc={<><span className="mono">templates/{tplSlug}</span> · <span className={'pill ' + (tplKind === 'transactional' ? 'blue' : 'neutral')} style={{ marginLeft: 4 }}>{tplKind}</span></>}
        actions={
          <>
            <button className="btn"><Icons.Eye size={14} />Preview</button>
            <button className="btn"><Icons.Send size={14} />Test send</button>
            <button className="btn"><Icons.Copy size={14} />Duplicate</button>
            <button className="btn btn-primary" disabled={busy} onClick={publish}><Icons.Rocket size={14} />Publish</button>
            {status && <span className="text-xs subtle" style={{ marginLeft: 8 }}>{status}</span>}
          </>
        }
      />

      <div className="split split-asym" style={{ gap: 16 }}>
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head">
            <div className="seg">
              <span className={'seg-item' + (view === 'design' ? ' active' : '')} onClick={() => setView('design')}>Design</span>
              <span className={'seg-item' + (view === 'source' ? ' active' : '')} onClick={() => setView('source')}>MJML</span>
              <span className={'seg-item' + (view === 'plaintext' ? ' active' : '')} onClick={() => setView('plaintext')}>Plain text</span>
            </div>
            <div className="card-actions">
              <span className="text-xs subtle">{dirty ? 'Unsaved changes' : 'Saved'}</span>
            </div>
          </div>

          <div style={{ padding: 16 }}>
            <div className="field">
              <label className="field-label">Subject</label>
              <input className="input" value={subject} onChange={(e) => { setSubject(e.target.value); setDirty(true) }} />
            </div>
            <div className="field">
              <label className="field-label">Preheader</label>
              <input className="input" value={preheader} onChange={(e) => { setPreheader(e.target.value); setDirty(true) }} />
            </div>
          </div>

          {view === 'design' && (
            <div className="maily-host" style={{ padding: 16, background: 'var(--bg-sunken)', minHeight: 480 }}>
              <MailyEditor
                contentJson={editorJson}
                onCreate={(editor) => { editorRef.current = editor }}
                onUpdate={(editor) => {
                  editorRef.current = editor
                  setEditorJson(editor.getJSON())
                  setDirty(true)
                }}
                config={{
                  hasMenuBar: true,
                  contentClassName: 'mly-content',
                  wrapClassName: 'mly-wrap',
                  bodyClassName: 'mly-body',
                  spellCheck: true,
                }}
              />
            </div>
          )}

          {view === 'source' && (
            <pre className="code" style={{ margin: 16, padding: 16, maxHeight: 520, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {mjmlSource || '/* No MJML stored for this template (Maily-authored). Switch to Design to edit. */'}
            </pre>
          )}

          {view === 'plaintext' && (
            <pre className="code" style={{ margin: 16, padding: 16, maxHeight: 520, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {plainText || '/* Plain text is auto-derived on publish. */'}
            </pre>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head"><span className="card-title">Sender</span></div>
            <div className="card-body">
              <div className="field">
                <label className="field-label">From name</label>
                <input className="input" defaultValue={tpl.fromName ?? ''} placeholder="(default from mailer config)" />
              </div>
              <div className="field">
                <label className="field-label">From email</label>
                <input className="input" defaultValue={tpl.fromEmail ?? ''} placeholder="(default from mailer config)" />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">Reply-to</label>
                <input className="input" defaultValue={tpl.replyTo ?? ''} placeholder="(same as From)" />
              </div>
            </div>
          </div>

          {Array.isArray(tpl.requiredVariables) && tpl.requiredVariables.length > 0 && (
            <div className="card">
              <div className="card-head"><span className="card-title">Variables</span><span className="card-sub">Used in subject/body</span></div>
              <div className="card-body">
                {tpl.requiredVariables.map((v: any) => (
                  <div key={v.name ?? v} className="hstack" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <span className="mono text-sm">{v.name ?? v}</span>
                    <span className="grow" />
                    {v.type && <span className="tag">{v.type}</span>}
                    {v.required != null && <span className="text-xs subtle">{v.required ? 'required' : 'optional'}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {Array.isArray(tpl.lintWarnings) && tpl.lintWarnings.length > 0 && (
            <div className="card">
              <div className="card-head"><span className="card-title">Lint warnings</span></div>
              <div className="card-body" style={{ display: 'grid', gap: 8 }}>
                {tpl.lintWarnings.map((w: any, i: number) => (
                  <div key={i} className="hstack"><Icons.Warn size={14} style={{ color: 'var(--amber-fg)' }} /><span className="text-sm">{w.message ?? String(w)}</span></div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
