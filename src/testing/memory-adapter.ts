/**
 * MemoryContactAdapter — drop-in in-process ContactAdapter for tests.
 * Hold contacts in a Map; everything operates synchronously over RAM.
 */

import type {
  AdapterFilter,
  Contact,
  ContactAdapter,
} from '../shared/types.js'

export class MemoryContactAdapter implements ContactAdapter {
  private readonly byId = new Map<string, Contact>()

  constructor(initial: Contact[] = []) {
    for (const c of initial) this.byId.set(c.externalId, c)
  }

  upsert(contact: Contact): void {
    this.byId.set(contact.externalId, {
      ...contact,
      email: contact.email.toLowerCase(),
      tags: [...contact.tags],
      fields: { ...contact.fields },
    })
  }

  delete(externalId: string): void {
    this.byId.delete(externalId)
  }

  async getById(externalId: string): Promise<Contact | null> {
    return this.byId.get(externalId) ?? null
  }

  async getByEmail(email: string): Promise<Contact | null> {
    const lower = email.toLowerCase()
    for (const c of this.byId.values()) {
      if (c.email === lower) return c
    }
    return null
  }

  async getBatch(externalIds: string[]): Promise<Map<string, Contact>> {
    const out = new Map<string, Contact>()
    for (const id of externalIds) {
      const c = this.byId.get(id)
      if (c) out.set(id, c)
    }
    return out
  }

  async query(
    filter: AdapterFilter,
    opts: { limit: number; cursor?: string },
  ): Promise<{ contacts: Contact[]; nextCursor?: string }> {
    const all = Array.from(this.byId.values())
      .filter((c) => matches(c, filter))
      .sort((a, b) => (a.externalId < b.externalId ? -1 : 1))

    const startIndex = opts.cursor
      ? all.findIndex((c) => c.externalId > opts.cursor!)
      : 0
    const slice = all.slice(startIndex === -1 ? all.length : startIndex, (startIndex === -1 ? all.length : startIndex) + opts.limit)
    const hasMore = startIndex !== -1 && startIndex + opts.limit < all.length

    return {
      contacts: slice,
      nextCursor: hasMore ? slice[slice.length - 1]?.externalId : undefined,
    }
  }

  async count(filter: AdapterFilter): Promise<number> {
    let n = 0
    for (const c of this.byId.values()) if (matches(c, filter)) n++
    return n
  }

  async addTags(externalId: string, tags: string[]): Promise<void> {
    const c = this.byId.get(externalId)
    if (!c) return
    const set = new Set(c.tags)
    for (const t of tags) set.add(t)
    c.tags = Array.from(set)
  }

  async removeTags(externalId: string, tags: string[]): Promise<void> {
    const c = this.byId.get(externalId)
    if (!c) return
    const remove = new Set(tags)
    c.tags = c.tags.filter((t) => !remove.has(t))
  }
}

function matches(c: Contact, f: AdapterFilter): boolean {
  if (f.emailIn && !f.emailIn.map((e) => e.toLowerCase()).includes(c.email)) return false
  if (f.externalIdIn && !f.externalIdIn.includes(c.externalId)) return false
  if (f.fieldEquals && c.fields[f.fieldEquals.field] !== f.fieldEquals.value) return false
  if (f.fieldIn && !f.fieldIn.values.includes(c.fields[f.fieldIn.field])) return false
  if (f.fieldExists && c.fields[f.fieldExists] === undefined) return false
  if (f.hasTag && !c.tags.includes(f.hasTag)) return false
  if (f.hasTagIn && !f.hasTagIn.some((t) => c.tags.includes(t))) return false
  return true
}
