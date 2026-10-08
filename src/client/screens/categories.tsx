/* Categories — read-only; the source of truth is MailerConfig.categories */
import { PageHead } from '../components/shell'
import { api } from '../lib/api'
import { useLive } from '../lib/use-live'
import { LoadState, EmptyRow } from '../lib/load-state'

export function Categories(_: any) {
  const { data: categories, loading, error, refetch } = useLive(() => api.categories())
  const { data: templates } = useLive(() => api.templates())
  const rows = categories ?? []
  const used = (id: string) => (templates ?? []).filter((t: any) => t.category === id).length

  return (
    <>
      <PageHead
        title="Categories"
        desc="Email categories recipients can opt out of individually. Declared in MailerConfig.categories; edit them in code."
      />
      <div className="card card-pad-0">
        <LoadState loading={loading && !categories} error={error} empty={!!categories && rows.length === 0} emptyLabel="No categories declared." retry={refetch}>
          <table className="table">
            <thead>
              <tr><th>Category</th><th>Label</th><th>Description</th><th className="num">Templates</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={4} label="No categories declared." />
              ) : (
                rows.map((c: any) => (
                  <tr key={c.id}>
                    <td className="mono text-xs">{c.id}</td>
                    <td className="f500">{c.label}</td>
                    <td className="text-xs subtle">{c.description ?? '—'}</td>
                    <td className="num tabular">{templates ? used(c.id) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </LoadState>
      </div>
    </>
  )
}
