/**
 * Flatten the /vars-schema JSON Schema into dotted paths for editor
 * autocomplete and the Variables sidebar card.
 */

export interface VarPathEntry {
  /** Dotted path as typed in templates, e.g. `user.name`. */
  path: string
  /** Human-ish type label, e.g. `string`, `number | null`, `array`. */
  type: string
  description?: string
}

/** Built-in render-context paths mailery provides for every template. */
export const BUILTIN_VAR_PATHS: VarPathEntry[] = [
  { path: 'unsubscribeUrl', type: 'string', description: 'One-click unsubscribe link (required in marketing templates)' },
  { path: 'event', type: 'object', description: 'Properties of the event that triggered the flow run, e.g. event.accountId' },
  { path: 'senderAddress', type: 'string', description: 'Configured postal address (CAN-SPAM)' },
  { path: 'contact.email', type: 'string' },
  { path: 'contact.externalId', type: 'string' },
  { path: 'contact.timezone', type: 'string' },
  { path: 'contact.locale', type: 'string' },
]

const MAX_DEPTH = 5

export function flattenVarPaths(schema: Record<string, unknown> | null): VarPathEntry[] {
  if (!schema) return []
  const out: VarPathEntry[] = []
  walk(schema, '', out, 0)
  return out
}

function walk(node: unknown, prefix: string, out: VarPathEntry[], depth: number): void {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return
  const n = node as Record<string, any>

  // Unions (nullable/optional): merge branches, label includes null when present.
  const branches: unknown[] | undefined = n.anyOf ?? n.oneOf
  if (Array.isArray(branches)) {
    const nullable = branches.some((b: any) => b && (b.type === 'null'))
    const objectBranch = branches.find((b: any) => b && (b.type === 'object' || b.properties))
    if (objectBranch) {
      if (prefix) out.push({ path: prefix, type: nullable ? 'object | null' : 'object', description: n.description })
      walk(objectBranch, prefix, out, depth)
      return
    }
    const types = branches.map((b: any) => typeLabel(b)).filter(Boolean)
    if (prefix) out.push({ path: prefix, type: Array.from(new Set(types)).join(' | '), description: n.description })
    return
  }

  if (n.type === 'object' || n.properties) {
    if (prefix && !n.properties) {
      out.push({ path: prefix, type: 'object', description: n.description })
      return
    }
    for (const [key, child] of Object.entries(n.properties ?? {})) {
      const childPath = prefix ? `${prefix}.${key}` : key
      const c = child as Record<string, any>
      if (c && (c.type === 'object' || c.properties || Array.isArray(c.anyOf ?? c.oneOf))) {
        walk(c, childPath, out, depth + 1)
      } else {
        out.push({ path: childPath, type: typeLabel(c), description: c?.description })
      }
    }
    return
  }

  if (prefix) out.push({ path: prefix, type: typeLabel(n), description: n.description })
}

function typeLabel(node: any): string {
  if (!node || typeof node !== 'object') return 'unknown'
  if (node.type === 'array') {
    const inner = typeLabel(node.items)
    return inner === 'unknown' ? 'array' : `${inner}[]`
  }
  if (Array.isArray(node.type)) return node.type.join(' | ')
  if (node.enum) return (node.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ')
  return typeof node.type === 'string' ? node.type : 'unknown'
}
