/* Templates list */
import React from 'react'
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Templates({ setRoute }: any) {
  const [tab, setTab] = React.useState('all')
  const { data: templates, loading, error, refetch } = useLive(() => api.templates())
  const rows = templates ?? []
  const filtered = rows.filter((t: any) => (tab === 'all' ? true : t.kind === tab))

  const [creating, setCreating] = React.useState(false)
  const [createForm, setCreateForm] = React.useState({ slug: '', name: '', kind: 'marketing' as 'marketing' | 'transactional', subject: '' })
  const [createError, setCreateError] = React.useState<string | null>(null)

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreateError(null)
    try {
      await api.createTemplate({
        slug: createForm.slug.trim(),
        name: createForm.name.trim(),
        kind: createForm.kind,
        subject: createForm.subject.trim(),
      })
      setCreating(false)
      setCreateForm({ slug: '', name: '', kind: 'marketing', subject: '' })
      refetch()
      setRoute({ screen: 'template-editor', slug: createForm.slug.trim() })
    } catch (err: any) {
      setCreateError(String(err?.message ?? err))
    }
  }

  return (
    <>
      <PageHead
        title="Templates"
        desc="Email content · MJML source or Maily WYSIWYG."
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Icons.Plus size={14} />New template</button>
        }
      />

      {creating && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <div className="card-head" style={{ padding: 0, marginBottom: 12 }}>
            <span className="card-title">New template</span>
            <span className="grow" />
            <button className="icon-btn" onClick={() => setCreating(false)}><Icons.X size={14} /></button>
          </div>
          <form onSubmit={submitCreate} className="vstack" style={{ gap: 12 }}>
            <div className="hstack" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="field-label">Slug</label>
                <input className="input" placeholder="welcome-day-1" value={createForm.slug} onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value })} required />
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="field-label">Name</label>
                <input className="input" placeholder="Welcome · day 1" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} required />
              </div>
            </div>
            <div className="hstack" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label className="field-label">Kind</label>
                <select className="select" value={createForm.kind} onChange={(e) => setCreateForm({ ...createForm, kind: e.target.value as 'marketing' | 'transactional' })}>
                  <option value="marketing">Marketing</option>
                  <option value="transactional">Transactional</option>
                </select>
              </div>
              <div className="field" style={{ flex: 2, marginBottom: 0 }}>
                <label className="field-label">Subject</label>
                <input className="input" placeholder="Welcome to Mailery" value={createForm.subject} onChange={(e) => setCreateForm({ ...createForm, subject: e.target.value })} />
              </div>
            </div>
            {createError && <div className="text-xs" style={{ color: 'var(--red-fg)' }}>{createError}</div>}
            <div className="hstack" style={{ gap: 8 }}>
              <button type="submit" className="btn btn-primary">Create + open editor</button>
              <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="tabs">
        <div className={'tab' + (tab === 'all' ? ' active' : '')} onClick={() => setTab('all')}>All<span className="tab-count">{rows.length}</span></div>
        <div className={'tab' + (tab === 'marketing' ? ' active' : '')} onClick={() => setTab('marketing')}>Marketing<span className="tab-count">{rows.filter((t: any) => t.kind === 'marketing').length}</span></div>
        <div className={'tab' + (tab === 'transactional' ? ' active' : '')} onClick={() => setTab('transactional')}>Transactional<span className="tab-count">{rows.filter((t: any) => t.kind === 'transactional').length}</span></div>
      </div>

      <div className="card card-pad-0">
        <LoadState loading={loading && !templates} error={error} empty={!!templates && filtered.length === 0} emptyLabel="No templates yet." retry={refetch}>
          <table className="table">
            <thead>
              <tr>
                <th>Template</th>
                <th>Kind</th>
                <th>Last sent</th>
                <th className="num">Sent 7d</th>
                <th className="num">Open rate</th>
                <th className="num">Click rate</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={7} label="No templates yet." />
              ) : (
                filtered.map((t: any) => {
                  const sent = t.stats?.sent ?? 0
                  const sentLast7 = t.stats?.sentLast7Days ?? 0
                  const openRate = sent ? (t.stats?.opened ?? 0) / sent : null
                  const clickRate = sent ? (t.stats?.clicked ?? 0) / sent : null
                  return (
                    <tr key={t.slug} onClick={() => setRoute({ screen: 'template-editor', slug: t.slug })}>
                      <td>
                        <div className="hstack">
                          <div style={{ width: 32, height: 32, borderRadius: 6, background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center', color: 'var(--fg-muted)' }}>
                            <Icons.Mail size={14} />
                          </div>
                          <div>
                            <div className="f500">{t.name}</div>
                            <div className="text-xs subtle mono">{t.slug}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className={'pill ' + (t.kind === 'transactional' ? 'blue' : 'neutral')}>{t.kind}</span></td>
                      <td className="text-xs subtle">{t.stats?.lastSentAt ? new Date(t.stats.lastSentAt).toLocaleString() : '—'}</td>
                      <td className="num tabular">{sentLast7.toLocaleString()}</td>
                      <td className="num tabular">{openRate != null ? (openRate * 100).toFixed(1) + '%' : '—'}</td>
                      <td className="num tabular">{clickRate != null ? (clickRate * 100).toFixed(1) + '%' : '—'}</td>
                      <td><Icons.Dots size={14} /></td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </LoadState>
      </div>
    </>
  )
}
