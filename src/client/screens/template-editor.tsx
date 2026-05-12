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
  const [fromName, setFromName] = React.useState<string>(tpl.draft?.fromName ?? tpl.fromName ?? '')
  const [fromEmail, setFromEmail] = React.useState<string>(tpl.draft?.fromEmail ?? tpl.fromEmail ?? '')
  const [replyTo, setReplyTo] = React.useState<string>(tpl.draft?.replyTo ?? tpl.replyTo ?? '')
  const [dirty, setDirty] = React.useState(false)
  const [status, setStatus] = React.useState<string>('')
  const [busy, setBusy] = React.useState(false)
  const editorRef = React.useRef<TiptapEditor | null>(null)
  const hydratedRef = React.useRef(false)

  // Preview modal state.
  const [previewing, setPreviewing] = React.useState<null | { subject: string; preheader: string; html: string; plainText: string }>(null)
  const [previewErr, setPreviewErr] = React.useState<string | null>(null)
  // Test-send dialog state.
  const [testDialog, setTestDialog] = React.useState(false)
  const [testTo, setTestTo] = React.useState('')
  const [testStatus, setTestStatus] = React.useState<string | null>(null)

  async function openPreview() {
    setPreviewErr(null)
    setStatus('Generating preview…')
    try {
      const out = await api.previewTemplate(slug, { useDraft: true })
      setPreviewing(out)
      setStatus('')
    } catch (e: any) {
      setPreviewErr(String(e?.message ?? e))
      setStatus('')
    }
  }

  async function submitTestSend() {
    if (!testTo.trim()) return
    setTestStatus('Sending…')
    try {
      await api.sendTestTemplate(slug, { to: testTo.trim() })
      setTestStatus(`Sent test to ${testTo.trim()}`)
    } catch (e: any) {
      setTestStatus(`Failed: ${e?.message ?? e}`)
    }
  }

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

  async function saveDraft() {
    setStatus('Saving draft…')
    await api.updateTemplateDraft(slug, {
      subject,
      preheader,
      editorJson,
      fromName: fromName || undefined,
      fromEmail: fromEmail || undefined,
      replyTo: replyTo || undefined,
    })
  }

  async function publish() {
    setBusy(true)
    try {
      await saveDraft()
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
            <button className="btn" onClick={openPreview}><Icons.Eye size={14} />Preview</button>
            <button className="btn" onClick={() => { setTestDialog(true); setTestStatus(null) }}><Icons.Send size={14} />Test send</button>
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
              <span className="text-xs subtle">{dirty ? 'Unsaved changes' : status.startsWith('Published') || status === 'Saved' ? status : ''}</span>
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
                <input
                  className="input"
                  value={fromName}
                  placeholder="(default from mailer config)"
                  onChange={(e) => { setFromName(e.target.value); setDirty(true) }}
                />
              </div>
              <div className="field">
                <label className="field-label">From email</label>
                <input
                  className="input"
                  value={fromEmail}
                  placeholder="(default from mailer config)"
                  onChange={(e) => { setFromEmail(e.target.value); setDirty(true) }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">Reply-to</label>
                <input
                  className="input"
                  value={replyTo}
                  placeholder="(same as From)"
                  onChange={(e) => { setReplyTo(e.target.value); setDirty(true) }}
                />
              </div>
            </div>
          </div>

        </div>
      </div>

      {previewing && (
        <Modal onClose={() => setPreviewing(null)} title="Preview">
          <div className="text-sm f500">{previewing.subject}</div>
          <div className="text-xs subtle" style={{ marginBottom: 8 }}>{previewing.preheader}</div>
          <iframe
            title="preview"
            srcDoc={previewing.html}
            style={{ width: '100%', minHeight: 480, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
          />
        </Modal>
      )}

      {previewErr && (
        <Modal onClose={() => setPreviewErr(null)} title="Preview failed">
          <div className="text-sm" style={{ color: 'var(--red-fg)' }}>{previewErr}</div>
        </Modal>
      )}

      {testDialog && (
        <Modal onClose={() => setTestDialog(false)} title="Send test email">
          <div className="vstack" style={{ gap: 12 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label">To</label>
              <input className="input" type="email" placeholder="you@example.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              <div className="field-hint">Uses the published version (publish first if you want to test recent edits).</div>
            </div>
            {testStatus && <div className="text-xs">{testStatus}</div>}
            <div className="hstack" style={{ gap: 8 }}>
              <button className="btn btn-primary" onClick={submitTestSend} disabled={!testTo.trim()}>Send</button>
              <button className="btn" onClick={() => setTestDialog(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'grid', placeItems: 'center', zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 'min(680px, 90vw)', maxHeight: '85vh', overflow: 'auto', padding: 0 }}
      >
        <div className="card-head">
          <span className="card-title">{title}</span>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose}><Icons.X size={14} /></button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  )
}
