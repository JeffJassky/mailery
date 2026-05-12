/**
 * MongoContactAdapter — reads contacts directly from the host's `users`
 * collection (read-mostly; optional narrow tag writes). Mailer never
 * duplicates identity data — the host is the source of truth.
 */

import type { Collection, Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'

import type {
  AdapterFilter,
  Contact,
  ContactAdapter,
} from '../../shared/types.js'

export interface MongoContactAdapterOptions {
  db: Db
  collection: string
  emailField?: string
  idField?: string
  /** Path to the tags array on the user document. */
  tagsField?: string
  /** When true, mailer writes tags via `$addToSet` / `$pull` on the user doc. */
  tagsWritable?: boolean
  /** 'strings' = ['vip','beta'], 'objects' = [{ name: 'vip' }]. */
  tagsArrayShape?: 'strings' | 'objects'
  /** Customize the projection mailer sees. Defaults pick up email + tags + a few common fields. */
  toContact?: (userDoc: any) => Contact
  /** Customize how AdapterFilter becomes a Mongo query. */
  translateFilter?: (filter: AdapterFilter) => Filter<any>
  /** Per-call default for query() limit. */
  batchSize?: number
}

export class MongoContactAdapter implements ContactAdapter {
  private readonly col: Collection<any>
  private readonly emailField: string
  private readonly idField: string
  private readonly tagsField: string | null
  private readonly tagsWritable: boolean
  private readonly tagsArrayShape: 'strings' | 'objects'
  private readonly toContactFn: (doc: any) => Contact
  private readonly translateFilterFn: (filter: AdapterFilter) => Filter<any>
  private readonly batchSize: number

  constructor(opts: MongoContactAdapterOptions) {
    this.col = opts.db.collection(opts.collection)
    this.emailField = opts.emailField ?? 'email'
    this.idField = opts.idField ?? '_id'
    this.tagsField = opts.tagsField ?? null
    this.tagsWritable = !!opts.tagsWritable
    this.tagsArrayShape = opts.tagsArrayShape ?? 'strings'
    this.toContactFn = opts.toContact ?? this.defaultToContact.bind(this)
    this.translateFilterFn = opts.translateFilter ?? this.defaultTranslateFilter.bind(this)
    this.batchSize = opts.batchSize ?? 500

    // Only expose tag write methods if the host opted in.
    if (this.tagsWritable && this.tagsField) {
      this.addTags = this.addTagsImpl.bind(this)
      this.removeTags = this.removeTagsImpl.bind(this)
    }
  }

  async getById(externalId: string): Promise<Contact | null> {
    const filter = this.idFilter(externalId)
    const doc = await this.col.findOne(filter)
    return doc ? this.toContactFn(doc) : null
  }

  async getByEmail(email: string): Promise<Contact | null> {
    const doc = await this.col.findOne({ [this.emailField]: email.toLowerCase() })
    return doc ? this.toContactFn(doc) : null
  }

  async getBatch(externalIds: string[]): Promise<Map<string, Contact>> {
    if (externalIds.length === 0) return new Map()
    const tryObjectId = externalIds.every(canBeObjectId)
    const ids: any[] = tryObjectId ? externalIds.map((s) => new ObjectId(s)) : externalIds
    const docs = await this.col.find({ [this.idField]: { $in: ids } }).toArray()
    const out = new Map<string, Contact>()
    for (const doc of docs) {
      const c = this.toContactFn(doc)
      out.set(c.externalId, c)
    }
    return out
  }

  async query(
    filter: AdapterFilter,
    opts: { limit: number; cursor?: string },
  ): Promise<{ contacts: Contact[]; nextCursor?: string }> {
    const query = this.translateFilterFn(filter)
    const limit = Math.min(opts.limit, this.batchSize)

    // Cursor is an ObjectId-or-externalId encoded as a string; we use it as a >
    // bound on the idField for stable pagination ordered by id.
    if (opts.cursor) {
      const cursorVal = canBeObjectId(opts.cursor) ? new ObjectId(opts.cursor) : opts.cursor
      ;(query as any)[this.idField] = { ...((query as any)[this.idField] ?? {}), $gt: cursorVal }
    }

    const docs = await this.col
      .find(query)
      .sort({ [this.idField]: 1 })
      .limit(limit + 1)
      .toArray()

    const hasMore = docs.length > limit
    const slice = hasMore ? docs.slice(0, limit) : docs
    const contacts = slice.map((d) => this.toContactFn(d))
    const last = slice[slice.length - 1]
    const nextCursor = hasMore && last ? String((last as any)[this.idField]) : undefined
    return { contacts, nextCursor }
  }

  async count(filter: AdapterFilter): Promise<number> {
    const query = this.translateFilterFn(filter)
    return await this.col.countDocuments(query)
  }

  addTags?: (externalId: string, tags: string[]) => Promise<void>
  removeTags?: (externalId: string, tags: string[]) => Promise<void>

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private idFilter(externalId: string): Filter<any> {
    if (this.idField === '_id' && canBeObjectId(externalId)) {
      return { _id: new ObjectId(externalId) } as Filter<any>
    }
    return { [this.idField]: externalId }
  }

  private defaultToContact(doc: any): Contact {
    const tagsRaw = this.tagsField ? doc[this.tagsField] ?? [] : []
    const tags: string[] =
      this.tagsArrayShape === 'objects'
        ? (Array.isArray(tagsRaw) ? tagsRaw : []).map((t: any) => String(t.name ?? t))
        : (Array.isArray(tagsRaw) ? tagsRaw : []).map((t: any) => String(t))

    const externalId = String(doc[this.idField] ?? '')
    const email = String(doc[this.emailField] ?? '').toLowerCase()

    // Default projection: everything that's not _id / email / tags becomes a field.
    const fields: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(doc)) {
      if (k === this.idField || k === this.emailField || k === this.tagsField) continue
      fields[k] = v
    }

    return {
      externalId,
      email,
      tags,
      fields,
      timezone: typeof doc.timezone === 'string' ? doc.timezone : undefined,
      locale: typeof doc.locale === 'string' ? doc.locale : undefined,
    }
  }

  private defaultTranslateFilter(filter: AdapterFilter): Filter<any> {
    const q: Record<string, unknown> = {}

    if (filter.emailIn && filter.emailIn.length > 0) {
      q[this.emailField] = { $in: filter.emailIn.map((e) => e.toLowerCase()) }
    }
    if (filter.externalIdIn && filter.externalIdIn.length > 0) {
      const tryObjectId = filter.externalIdIn.every(canBeObjectId)
      q[this.idField] = {
        $in: tryObjectId ? filter.externalIdIn.map((s) => new ObjectId(s)) : filter.externalIdIn,
      }
    }
    if (filter.fieldEquals) {
      q[filter.fieldEquals.field] = filter.fieldEquals.value
    }
    if (filter.fieldIn) {
      q[filter.fieldIn.field] = { $in: filter.fieldIn.values }
    }
    if (filter.fieldExists) {
      q[filter.fieldExists] = { $exists: true }
    }
    if (filter.createdAfter || filter.createdBefore) {
      const r: any = {}
      if (filter.createdAfter) r.$gte = filter.createdAfter
      if (filter.createdBefore) r.$lte = filter.createdBefore
      q.createdAt = r
    }
    if (this.tagsField) {
      if (filter.hasTag) {
        q[this.tagsField] = filter.hasTag
      }
      if (filter.hasTagIn && filter.hasTagIn.length > 0) {
        q[this.tagsField] = { $in: filter.hasTagIn }
      }
    }
    return q
  }

  private async addTagsImpl(externalId: string, tags: string[]): Promise<void> {
    if (!this.tagsField || tags.length === 0) return
    const value =
      this.tagsArrayShape === 'objects'
        ? tags.map((name) => ({ name }))
        : tags
    await this.col.updateOne(this.idFilter(externalId), {
      $addToSet: { [this.tagsField]: { $each: value } } as any,
    })
  }

  private async removeTagsImpl(externalId: string, tags: string[]): Promise<void> {
    if (!this.tagsField || tags.length === 0) return
    const value =
      this.tagsArrayShape === 'objects'
        ? { $in: tags.map((name) => ({ name })) }
        : { $in: tags }
    await this.col.updateOne(this.idFilter(externalId), {
      $pull: { [this.tagsField]: value } as any,
    })
  }
}

function canBeObjectId(s: string): boolean {
  return typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s)
}
