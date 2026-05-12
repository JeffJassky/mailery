/* Audit log */
import { Icons } from '../components/icons'
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Audit(_: any) {
  const { data: rows, loading, error, refetch } = useLive(() => api.audit())
  const items = rows ?? []

  return (
    <>
      <PageHead
        title="Audit log"
        desc="Every mutating action. Append-only. Diffs available on click."
        actions={<button className="btn"><Icons.Download size={14} />Export</button>}
      />

      <div className="card card-pad-0">
        <LoadState loading={loading && !rows} error={error} empty={!!rows && items.length === 0} emptyLabel="No audit events yet." retry={refetch}>
          <table className="table">
            <thead>
              <tr><th>Actor</th><th>Action</th><th>Resource</th><th>Detail</th><th>Time</th><th style={{ width: 32 }}></th></tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <EmptyRow colSpan={6} label="No audit events yet." />
              ) : (
                items.map((e: any, i: number) => {
                  const actor = e.actor ?? 'system:unknown'
                  const isHuman = actor.startsWith('human:')
                  const isSys = actor.startsWith('system:')
                  return (
                    <tr key={String(e._id ?? i)}>
                      <td>
                        <div className="hstack">
                          <div style={{
                            width: 22, height: 22, borderRadius: 5,
                            background: isHuman ? 'var(--violet-soft)' : isSys ? 'var(--blue-soft)' : 'var(--accent-soft)',
                            color: isHuman ? 'var(--violet-fg)' : isSys ? 'var(--blue-fg)' : 'var(--accent-press)',
                            display: 'grid', placeItems: 'center',
                          }}>
                            {isHuman ? <Icons.Contacts size={11} /> : isSys ? <Icons.Settings size={11} /> : <Icons.Sparkles size={11} />}
                          </div>
                          <span className="text-xs mono">{actor}</span>
                        </div>
                      </td>
                      <td><span className="tag">{e.action}</span></td>
                      <td className="mono text-xs">{formatResource(e.resource)}</td>
                      <td className="text-xs subtle">{e.diffSummary ?? ''}</td>
                      <td className="text-xs subtle">{e.occurredAt ? new Date(e.occurredAt).toLocaleString() : ''}</td>
                      <td><Icons.Chevron size={12} /></td>
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

function formatResource(r: any): string {
  if (!r) return ''
  if (typeof r === 'string') return r
  if (r.slug) return `${(r.collection ?? '').replace('mailer_', '')}/${r.slug}`
  if (r.id) return `${(r.collection ?? '').replace('mailer_', '')}/${String(r.id).slice(-8)}`
  return r.collection ?? ''
}
