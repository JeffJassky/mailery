/** Facts panel helpers: control values ⇄ fact values. Pure. */
import type { FactDecl } from '../../../shared/types'

export type FactOverrides = Record<string, string | number | boolean>

const pad = (n: number) => String(n).padStart(2, '0')

/** ISO instant → value for `<input type="datetime-local">` (local time). */
export function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string' && !(iso instanceof Date)) return ''
  const d = new Date(iso as string)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `datetime-local` value → ISO instant, or null when empty/invalid. */
export function fromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Next overrides after the user changed one control. `raw` is the control's
 * value as a string ('' = empty); booleans use 'yes' / 'no' / ''.
 */
export function setOverride(prev: FactOverrides, name: string, decl: FactDecl, raw: string): FactOverrides {
  const next = { ...prev }
  delete next[name]
  if (raw === '') return next
  switch (decl.type) {
    case 'boolean':
      next[name] = raw === 'yes'
      break
    case 'number': {
      const n = Number(raw)
      if (!Number.isFinite(n)) return next
      next[name] = n
      break
    }
    case 'date': {
      const iso = fromLocalInput(raw)
      if (iso) next[name] = iso
      break
    }
    default:
      next[name] = raw
  }
  return next
}

/** Control value for a fact: the override if set, else the simulation's resolved fact. */
export function controlValue(decl: FactDecl, override: unknown, resolved: unknown): string {
  const v = override !== undefined ? override : resolved
  if (v === undefined || v === null) return ''
  switch (decl.type) {
    case 'boolean':
      return v === true ? 'yes' : v === false ? 'no' : ''
    case 'date':
      return toLocalInput(v)
    default:
      return String(v)
  }
}

export const hasOverrides = (o: FactOverrides): boolean => Object.keys(o).length > 0
