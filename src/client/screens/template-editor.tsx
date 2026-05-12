/* Template editor — Design (Maily WYSIWYG) / MJML / Plain text */
import React from 'react'
import { Editor as MailyEditor } from '@maily-to/core'
import type { Editor as TiptapEditor, JSONContent } from '@tiptap/core'

import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { sample } from '../lib/mock'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'

const DEFAULT_CONTENT: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { textAlign: 'left' },
      content: [
        { type: 'text', text: 'Hey ' },
        {
          type: 'variable',
          attrs: { id: 'firstName', label: null, fallback: null, showIfKey: null, each: null },
        },
        { type: 'text', text: ',' },
      ],
    },
    {
      type: 'paragraph',
      attrs: { textAlign: 'left' },
      content: [
        {
          type: 'text',
          text: "Welcome — start by clicking around the admin UI, or drop a feature flag on for your team.",
        },
      ],
    },
    {
      type: 'button',
      attrs: {
        text: 'Open the app',
        url: 'https://yourdomain.com',
        alignment: 'left',
        variant: 'filled',
        borderRadius: 'smooth',
        buttonColor: '#f97316',
        textColor: '#ffffff',
        showIfKey: null,
      },
    },
  ],
}

export function TemplateEditor({ slug = 'welcome-1' }: any) {
  const fallback = sample.templates.find((t) => t.slug === slug) ?? sample.templates[0]
  const { data: tpl, refetch } = useLive(() => api.template(slug), fallback as any)

  const [view, setView] = React.useState<'design' | 'source' | 'plaintext'>('design')
  const [editorJson, setEditorJson] = React.useState<JSONContent>(DEFAULT_CONTENT)
  const [subject, setSubject] = React.useState<string>('')
  const [preheader, setPreheader] = React.useState<string>('')
  const [dirty, setDirty] = React.useState(false)
  const [status, setStatus] = React.useState<string>('')
  const [busy, setBusy] = React.useState(false)
  const editorRef = React.useRef<TiptapEditor | null>(null)
  const hydratedRef = React.useRef(false)

  const tplKind = (tpl as any)?.kind ?? 'marketing'
  const tplName = (tpl as any)?.name ?? slug
  const tplSlug = (tpl as any)?.slug ?? slug
  const initialSubject = (tpl as any)?.draft?.subject ?? (tpl as any)?.subject ?? `Welcome to Mailery, {{contact.fields.firstName}} 👋`
  const initialPreheader = (tpl as any)?.draft?.preheader ?? (tpl as any)?.preheader ?? 'Three things to try in your first 5 minutes.'
  const initialEditorJson = (tpl as any)?.draft?.editorJson ?? (tpl as any)?.body?.editorJson ?? null
  const mjmlSource = (tpl as any)?.body?.mjml ?? (tpl as any)?.draft?.mjml ?? ''
  const plainText = (tpl as any)?.body?.plainText ?? ''

  React.useEffect(() => {
    if (hydratedRef.current) return
    if (!tpl) return
    hydratedRef.current = true
    setSubject(initialSubject)
    setPreheader(initialPreheader)
    if (initialEditorJson) setEditorJson(initialEditorJson)
  }, [tpl, initialSubject, initialPreheader, initialEditorJson])

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
              <button className="icon-btn"><Icons.Help size={14} /></button>
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
                onCreate={(editor) => {
                  editorRef.current = editor
                }}
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
                <input className="input" defaultValue={(tpl as any)?.fromName ?? 'Jeff at Mailery'} />
              </div>
              <div className="field">
                <label className="field-label">From email</label>
                <input className="input" defaultValue={(tpl as any)?.fromEmail ?? 'hello@example.com'} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">Reply-to</label>
                <input className="input" defaultValue={(tpl as any)?.replyTo ?? ''} placeholder="(same as From)" />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Variables</span><span className="card-sub">Used in subject/body</span></div>
            <div className="card-body">
              {[
                ['firstName', 'string', 'required'],
                ['appUrl', 'url', 'required'],
                ['logoUrl', 'url', 'optional · default'],
                ['unsubscribeUrl', 'url', 'auto-injected'],
              ].map(([n, t, r]) => (
                <div key={n} className="hstack" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className="mono text-sm">{n}</span>
                  <span className="grow" />
                  <span className="tag">{t}</span>
                  <span className="text-xs subtle">{r}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">Tracking & lint</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 8 }}>
              <div className="hstack"><Icons.Check size={14} style={{ color: 'var(--green-fg)' }} /><span className="text-sm">Unsubscribe link present</span></div>
              <div className="hstack"><Icons.Check size={14} style={{ color: 'var(--green-fg)' }} /><span className="text-sm">Postal address present</span></div>
              <div className="hstack"><Icons.Check size={14} style={{ color: 'var(--green-fg)' }} /><span className="text-sm">No broken merge tags</span></div>
              <div className="hstack"><Icons.Warn size={14} style={{ color: 'var(--amber-fg)' }} /><span className="text-sm">Open tracking enabled — beware Apple MPP</span></div>
              <div className="divider" style={{ margin: '4px 0' }} />
              <div className="hstack"><span className="text-sm">Track opens</span><span className="grow" /><div className="toggle on"><div className="track"><div className="knob" /></div></div></div>
              <div className="hstack"><span className="text-sm">Track clicks</span><span className="grow" /><div className="toggle on"><div className="track"><div className="knob" /></div></div></div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
