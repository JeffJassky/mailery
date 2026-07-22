/* Template editor — Design (Maily WYSIWYG) / MJML / Plain text */
import React from 'react'
import { Editor as MailyEditor } from '@maily-to/core'
import type { Editor as TiptapEditor, JSONContent } from '@tiptap/core'

import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { VarInput } from '../components/var-input'
import {
  api,
  type LintIssue,
  type LintResponse,
  type MailTesterFeedback,
  type MailTesterScore,
  type MailTesterStatusResponse,
  type PreviewResponse,
} from '../lib/api'
import { BUILTIN_VAR_PATHS, flattenVarPaths, type VarPathEntry } from '../lib/vars-schema'
import { useLive } from '../lib/use-live'
import { LoadState } from '../lib/load-state'

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

export function TemplateEditor({ slug }: any) {
  const { data: tpl, loading, error, refetch } = useLive(() => api.template(slug), [slug])

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
  // True only when the template has a real Maily doc (hydrated or user-edited
  // in Design). MJML/script-seeded templates must NOT send the editor's
  // placeholder EMPTY_DOC — the server would compile it (empty) instead of
  // falling back to the MJML / stored body, breaking lint and, worse,
  // clobbering the body on publish.
  const [isMailyAuthored, setIsMailyAuthored] = React.useState(false)

  // Vars schema — drives subject/preheader autocomplete + the Variables card.
  const { data: varsData } = useLive(() => api.varsSchema(), [])
  const varPaths = React.useMemo<VarPathEntry[]>(
    () => [...flattenVarPaths(varsData?.schema ?? null), ...BUILTIN_VAR_PATHS],
    [varsData],
  )

  // Preview modal state. `previewContacts` is the pageable list of real
  // contacts the operator can cycle through with ←/→.
  const [previewing, setPreviewing] = React.useState<PreviewResponse | null>(null)
  const [previewErr, setPreviewErr] = React.useState<string | null>(null)
  const [previewContacts, setPreviewContacts] = React.useState<any[]>([])
  const [previewCursor, setPreviewCursor] = React.useState<string | undefined>(undefined)
  const [previewIdx, setPreviewIdx] = React.useState<number | null>(null)
  const [previewBusy, setPreviewBusy] = React.useState(false)
  // Test-send dialog state.
  const [testDialog, setTestDialog] = React.useState(false)
  const [testTo, setTestTo] = React.useState('')
  const [testStatus, setTestStatus] = React.useState<string | null>(null)
  const [testBusy, setTestBusy] = React.useState(false)

  async function renderPreview(contactId?: string) {
    setPreviewBusy(true)
    try {
      const out = await api.previewTemplate(slug, { useDraft: true, contactId })
      setPreviewing(out)
      setPreviewErr(null)
    } catch (e: any) {
      setPreviewErr(String(e?.message ?? e))
    } finally {
      setPreviewBusy(false)
    }
  }

  async function openPreview() {
    setPreviewErr(null)
    setStatus('Generating preview…')
    try {
      // Load real contacts so the preview shows actual resolved variables;
      // fall back to the sample contact when the adapter has none.
      let contacts = previewContacts
      if (contacts.length === 0) {
        const page = await api.contacts()
        contacts = page.contacts
        setPreviewContacts(page.contacts)
        setPreviewCursor(page.nextCursor)
      }
      if (contacts.length > 0) {
        setPreviewIdx(0)
        await renderPreview(String(contacts[0].externalId))
      } else {
        setPreviewIdx(null)
        await renderPreview()
      }
      setStatus('')
    } catch (e: any) {
      setPreviewErr(String(e?.message ?? e))
      setStatus('')
    }
  }

  const cycleTo = React.useCallback(
    async (nextIdx: number) => {
      if (previewBusy || nextIdx < 0) return
      let contacts = previewContacts
      // Reached the end of loaded pages — pull the next page if there is one.
      if (nextIdx >= contacts.length) {
        if (!previewCursor) return
        const page = await api.contacts(previewCursor)
        contacts = [...contacts, ...page.contacts]
        setPreviewContacts(contacts)
        setPreviewCursor(page.nextCursor)
        if (nextIdx >= contacts.length) return
      }
      setPreviewIdx(nextIdx)
      await renderPreview(String(contacts[nextIdx].externalId))
    },
    [previewBusy, previewContacts, previewCursor, slug],
  )

  // ←/→ cycles the previewed contact while the modal is open.
  React.useEffect(() => {
    if (!previewing || previewIdx == null) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        void cycleTo(previewIdx! + 1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        void cycleTo(previewIdx! - 1)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [previewing, previewIdx, cycleTo])

  async function submitTestSend() {
    if (!testTo.trim() || testBusy) return
    setTestBusy(true)
    setTestStatus('Sending…')
    try {
      // Render as the contact currently selected in the preview (if any), so
      // the test email carries real resolved variables.
      const contactId = previewIdx != null && previewContacts[previewIdx]
        ? String(previewContacts[previewIdx].externalId)
        : undefined
      await api.sendTestTemplate(slug, { to: testTo.trim(), contactId })
      setTestStatus(`Sent test to ${testTo.trim()}`)
    } catch (e: any) {
      setTestStatus(`Failed: ${e?.message ?? e}`)
    } finally {
      setTestBusy(false)
    }
  }

  const tplKind = tpl.kind ?? 'marketing'
  const tplName = tpl.name ?? slug
  const tplSlug = tpl.slug ?? slug
  const mjmlSource = tpl.body?.mjml ?? tpl.draft?.mjml ?? ''
  const plainText = tpl.body?.plainText ?? ''

  const lint = useLiveLint(slug, {
    subject,
    preheader,
    editorJson: isMailyAuthored ? (editorJson as Record<string, unknown>) : null,
    fromEmail: fromEmail || tpl.fromEmail,
    kind: tplKind,
  })
  const hasErrors = (lint.data?.errors.length ?? 0) > 0

  React.useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    const incoming = tpl.draft?.editorJson ?? tpl.body?.editorJson
    if (incoming) {
      setEditorJson(incoming)
      setIsMailyAuthored(true)
    }
  }, [tpl])

  async function saveDraft() {
    setStatus('Saving draft…')
    await api.updateTemplateDraft(slug, {
      subject,
      preheader,
      // Maily templates save the doc; MJML/seeded templates carry their MJML
      // source forward instead so publish recompiles the real content.
      ...(isMailyAuthored ? { editorJson } : mjmlSource ? { mjml: mjmlSource } : {}),
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
            <button
              className="btn btn-primary"
              disabled={busy || hasErrors}
              onClick={publish}
              title={hasErrors ? 'Resolve content-lint errors before publishing.' : undefined}
            >
              <Icons.Rocket size={14} />Publish
            </button>
            {lint.data && (
              <span className="text-xs subtle" style={{ marginLeft: 8 }}>
                <LintBadge data={lint.data} />
              </span>
            )}
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
              <VarInput value={subject} paths={varPaths} onChange={(v) => { setSubject(v); setDirty(true) }} />
            </div>
            <div className="field">
              <label className="field-label">Preheader</label>
              <VarInput value={preheader} paths={varPaths} onChange={(v) => { setPreheader(v); setDirty(true) }} />
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
                  setIsMailyAuthored(true)
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
          <LintCard lint={lint} />
          <VariablesCard paths={varPaths} hasSchema={!!varsData?.schema} />
          <MailTesterCard slug={slug} refetchTemplate={refetch} />
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
        <Modal onClose={() => { setPreviewing(null); setPreviewIdx(null) }} title="Preview">
          {previewIdx != null && previewContacts.length > 0 && (
            <div className="hstack" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <button className="btn btn-xs" disabled={previewBusy || previewIdx === 0} onClick={() => cycleTo(previewIdx - 1)} title="Previous contact (←)">←</button>
              <span className="text-xs mono">
                {previewing.contact?.email ?? previewContacts[previewIdx]?.email}
              </span>
              <span className="text-xs subtle">
                {previewIdx + 1} / {previewContacts.length}{previewCursor ? '+' : ''}
              </span>
              <button className="btn btn-xs" disabled={previewBusy} onClick={() => cycleTo(previewIdx + 1)} title="Next contact (→)">→</button>
              {previewBusy && <span className="text-xs subtle">Rendering…</span>}
            </div>
          )}
          <div className="text-sm f500">{previewing.subject}</div>
          <div className="text-xs subtle" style={{ marginBottom: 8 }}>{previewing.preheader}</div>
          <iframe
            title="preview"
            sandbox=""
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
              <button className="btn btn-primary" onClick={submitTestSend} disabled={!testTo.trim() || testBusy}>{testBusy ? 'Sending…' : 'Send'}</button>
              <button className="btn" onClick={() => setTestDialog(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

interface LiveLintState {
  data: LintResponse | null
  loading: boolean
  error: string | null
}

interface LiveLintInput {
  subject: string
  preheader: string
  editorJson: Record<string, unknown> | null
  fromEmail: string
  kind: 'marketing' | 'transactional'
}

/**
 * Debounced live lint against /templates/:slug/lint. Cancels in-flight
 * requests when the input changes — typing fast doesn't pile up requests.
 */
function useLiveLint(slug: string, input: LiveLintInput): LiveLintState {
  const [state, setState] = React.useState<LiveLintState>({ data: null, loading: false, error: null })

  // editorJson is a fresh object reference on every keystroke even when the
  // logical contents are unchanged — useMemo would always invalidate, so
  // serialize directly and use the string as the effect key.
  const key = JSON.stringify(input)
  // Keep a ref to the latest input so the effect closure picks it up
  // without participating in deps.
  const inputRef = React.useRef(input)
  inputRef.current = input

  React.useEffect(() => {
    const controller = new AbortController()
    setState((s) => ({ ...s, loading: true }))

    const t = setTimeout(async () => {
      try {
        const data = await api.lintTemplate(slug, inputRef.current, controller.signal)
        setState({ data, loading: false, error: null })
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        setState((s) => ({ data: s.data, loading: false, error: String(err?.message ?? err) }))
      }
    }, 500)

    return () => {
      controller.abort()
      clearTimeout(t)
    }
  }, [key, slug])

  return state
}

function VariablesCard({ paths, hasSchema }: { paths: VarPathEntry[]; hasSchema: boolean }) {
  const [copied, setCopied] = React.useState<string | null>(null)

  function copy(path: string) {
    void navigator.clipboard?.writeText(`{{${path}}}`)
    setCopied(path)
    setTimeout(() => setCopied((c) => (c === path ? null : c)), 1200)
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Variables</span>
        <span className="card-sub">{hasSchema ? 'Click to copy' : 'Built-ins only'}</span>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {!hasSchema && (
          <div className="text-xs subtle" style={{ padding: 12 }}>
            No <code>varsAdapter</code> configured — define one with <code>defineVars()</code> in <code>Mailer.init</code> to expose host data ({'{{user.name}}'}, …) to templates.
          </div>
        )}
        <div style={{ maxHeight: 280, overflow: 'auto' }}>
          {paths.map((p) => (
            <div
              key={p.path}
              onClick={() => copy(p.path)}
              title={p.description ?? `{{${p.path}}}`}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 12, cursor: 'pointer',
                padding: '6px 12px', borderTop: '1px solid var(--border)',
              }}
            >
              <span className="mono text-xs">{copied === p.path ? 'Copied!' : `{{${p.path}}}`}</span>
              <span className="text-xs subtle">{p.type}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function LintBadge({ data }: { data: LintResponse }) {
  const { errors, warnings, infos } = data
  const total = errors.length + warnings.length + infos.length
  if (total === 0) {
    return <span style={{ color: 'var(--green-fg)' }}><span className="dot" />Lint: clean</span>
  }
  return (
    <span className="hstack" style={{ gap: 6 }}>
      {errors.length > 0 && <span style={{ color: 'var(--red-fg)' }}>{errors.length} error{errors.length === 1 ? '' : 's'}</span>}
      {warnings.length > 0 && <span style={{ color: 'var(--amber-fg)' }}>{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
      {infos.length > 0 && <span style={{ color: 'var(--fg-muted)' }}>{infos.length} info</span>}
    </span>
  )
}

function LintCard({ lint }: { lint: LiveLintState }) {
  const data = lint.data
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Issues</span>
        <span className="card-sub">
          {lint.loading && !data ? 'Checking…' : data ? <LintBadge data={data} /> : '—'}
        </span>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {lint.error && (
          <div className="text-xs" style={{ padding: 12, color: 'var(--red-fg)' }}>
            {lint.error}
          </div>
        )}
        {data && data.compileFailed && (
          <div className="text-xs" style={{ padding: 12, color: 'var(--red-fg)' }}>
            Template compile failed — see error below.
          </div>
        )}
        {data && (
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            {data.errors.map((i) => <LintRow key={`e-${i.rule}`} issue={i} />)}
            {data.warnings.map((i) => <LintRow key={`w-${i.rule}`} issue={i} />)}
            {data.infos.map((i) => <LintRow key={`n-${i.rule}`} issue={i} />)}
            {data.errors.length === 0 && data.warnings.length === 0 && data.infos.length === 0 && (
              <div className="text-xs subtle" style={{ padding: 12 }}>No issues.</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function LintRow({ issue }: { issue: LintIssue }) {
  const color = issue.severity === 'error' ? 'var(--red-fg)' : issue.severity === 'warning' ? 'var(--amber-fg)' : 'var(--fg-muted)'
  return (
    <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'grid', gap: 4 }}>
      <div className="text-xs" style={{ color, fontWeight: 500 }}>
        {issue.severity.toUpperCase()} · {issue.rule}
      </div>
      <div className="text-xs">{issue.message}</div>
      {issue.hint && <div className="text-xs subtle">{issue.hint}</div>}
    </div>
  )
}

function MailTesterCard({ slug, refetchTemplate }: { slug: string; refetchTemplate: () => void }) {
  const { data: status, refetch } = useLive<MailTesterStatusResponse>(() => api.mailTesterStatus(slug), [slug])
  const [running, setRunning] = React.useState(false)
  const [polling, setPolling] = React.useState<{ checkId: string; contentKey: string } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pendingScore, setPendingScore] = React.useState<MailTesterScore | null>(null)

  // Stash callbacks in refs so the polling effect only re-runs when
  // `polling` (the actual check we're waiting on) changes — `refetch` and
  // `refetchTemplate` have unstable identity and would otherwise restart
  // the interval and reset `attempts` to 0 every parent re-render, so the
  // timeout never fired.
  const refetchRef = React.useRef(refetch)
  const refetchTemplateRef = React.useRef(refetchTemplate)
  refetchRef.current = refetch
  refetchTemplateRef.current = refetchTemplate

  React.useEffect(() => {
    if (!polling) return
    let cancelled = false
    let attempts = 0
    const maxAttempts = 30 // 30 * 3s = 90 seconds
    const t = setInterval(async () => {
      attempts++
      try {
        const r = await api.fetchMailTesterResult(slug, polling.checkId)
        if (cancelled) return
        if (r.status === 'ready' && r.score) {
          setPendingScore(r.score)
          setPolling(null)
          setRunning(false)
          refetchRef.current()
          refetchTemplateRef.current()
        } else if (attempts >= maxAttempts) {
          setError('Timed out waiting for Mail-Tester to score the message. It may still be processing — refresh to check.')
          setPolling(null)
          setRunning(false)
        }
      } catch (err: any) {
        if (cancelled) return
        setError(String(err?.message ?? err))
        setPolling(null)
        setRunning(false)
      }
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [polling, slug])

  async function run() {
    setRunning(true)
    setError(null)
    setPendingScore(null)
    try {
      const start = await api.startMailTesterCheck(slug)
      if (start.status === 'ready' && start.score) {
        setPendingScore(start.score)
        setRunning(false)
        refetch()
        return
      }
      if (start.checkId && start.contentKey) {
        setPolling({ checkId: start.checkId, contentKey: start.contentKey })
      } else {
        setError('Unexpected response from server.')
        setRunning(false)
      }
    } catch (err: any) {
      setError(String(err?.message ?? err))
      setRunning(false)
    }
  }

  const currentScore = pendingScore ?? status?.score ?? null
  const minScore = status?.minScore ?? 8.0
  const belowMin = currentScore != null && currentScore.score < minScore

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Deliverability check</span>
        <span className="card-sub">
          {!status
            ? 'Loading…'
            : !status.configured
            ? 'Mail-Tester not configured'
            : currentScore
            ? `Cached for ${status.cacheHours}h after each check`
            : 'Run a Mail-Tester check before publishing'}
        </span>
        {status?.configured && (
          <div className="card-actions">
            <button className="btn btn-xs" disabled={running} onClick={run}>
              {running ? (polling ? 'Waiting for score…' : 'Sending…') : currentScore ? 'Re-run check' : 'Run check'}
            </button>
          </div>
        )}
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 10 }}>
        {!status?.configured && (
          <div className="text-xs subtle">
            Set <code>mailer.config.mailTester.apiKey</code> to enable. Mail-Tester runs SpamAssassin + DNS auth checks + content red-flag scoring against a real receipt of this template.
          </div>
        )}
        {error && (
          <div className="text-xs" style={{ color: 'var(--red-fg)' }}>{error}</div>
        )}
        {status?.configured && status.requireScore && !currentScore && (
          <div className="text-xs" style={{ color: 'var(--amber-fg)' }}>
            <code>requireScore</code> is on — publish is blocked until this exact content has a
            score. Editing the subject or body after a check invalidates it.
          </div>
        )}
        {currentScore && (
          <>
            <div className="hstack" style={{ gap: 16, alignItems: 'baseline' }}>
              <div>
                <div className="text-xs subtle">Score</div>
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 600,
                    color: belowMin ? 'var(--red-fg)' : currentScore.score >= 9 ? 'var(--green-fg)' : 'var(--amber-fg)',
                  }}
                >
                  {currentScore.score.toFixed(1)} <span className="text-xs subtle">/ 10</span>
                </div>
              </div>
              <div>
                <div className="text-xs subtle">Threshold</div>
                <div className="text-sm mono">{minScore.toFixed(1)}</div>
              </div>
              <div>
                <div className="text-xs subtle">Checked</div>
                <div className="text-xs">{new Date(currentScore.fetchedAt).toLocaleString()}</div>
              </div>
            </div>
            {belowMin && (
              <div className="text-xs" style={{ color: 'var(--red-fg)' }}>
                Score below threshold — publish will be blocked. Address the feedback below or override with <code>bypassMailTester: true</code> on the publish call.
              </div>
            )}
            {currentScore.feedback.length > 0 && (
              <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
                {currentScore.feedback.slice(0, 12).map((f: MailTesterFeedback, i: number) => (
                  <div key={i} className="text-xs" style={{ display: 'grid', gap: 2 }}>
                    <div style={{ color: f.severity === 'error' ? 'var(--red-fg)' : f.severity === 'warning' ? 'var(--amber-fg)' : 'var(--fg-muted)', fontWeight: 500 }}>
                      {f.severity.toUpperCase()} · {f.category}
                    </div>
                    <div>{f.message}</div>
                  </div>
                ))}
                {currentScore.feedback.length > 12 && (
                  <div className="text-xs subtle">+ {currentScore.feedback.length - 12} more items in raw report</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = React.useId()
  const cardRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const card = cardRef.current
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !card) return
      // Focus trap: cycle Tab between first/last tabbable in the modal.
      const tabbables = card.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (tabbables.length === 0) return
      const first = tabbables[0]!
      const last = tabbables[tabbables.length - 1]!
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && (active === first || !card.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    cardRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'grid', placeItems: 'center', zIndex: 50,
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 'min(680px, 90vw)', maxHeight: '85vh', overflow: 'auto', padding: 0 }}
      >
        <div className="card-head">
          <span className="card-title" id={titleId}>{title}</span>
          <span className="grow" />
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icons.X size={14} /></button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  )
}
