# Contact & adapter types

```ts
import type { Contact, ContactAdapter, AdapterFilter } from 'mailery'
```

## Contact

What mailery sees of a host user. Returned by the adapter.

```ts
interface Contact {
  externalId: string                              // host user id, as a string
  email: string                                   // current address, lowercase
  tags: string[]                                  // first-class
  fields: Record<string, unknown>                 // arbitrary; whatever the host exposes
  timezone?: string                               // IANA, e.g. 'America/New_York'
  locale?: string                                 // BCP 47, e.g. 'en-US'
}
```

- `externalId` and `email` are the contact's identity. mailery uses `externalId` as the foreign key across all its collections.
- `tags` are accessed in flow predicates (`hasTag`) and in segment filters (`{ kind: 'hasTag' }`).
- `fields` is anything the host wants to expose to templates and predicates. Render via `{{contact.fields.firstName}}`.

## AdapterFilter

What mailery passes to `adapter.query()` and `adapter.count()`.

```ts
interface AdapterFilter {
  emailIn?: string[]
  externalIdIn?: string[]
  fieldEquals?: { field: string; value: unknown }
  fieldIn?: { field: string; values: unknown[] }
  fieldExists?: string
  hasTag?: string
  hasTagIn?: string[]                              // OR semantics
  createdAfter?: Date
  createdBefore?: Date
}
```

Tiny on purpose — richer filtering happens via mailer-side post-filters on the returned cursor. Implement the most efficient translation for your host's storage; mailery will still work if the adapter applies an over-broad filter and lets mailer post-filter, but performance suffers on large segments.

## ContactAdapter

The interface mailery calls into for all contact reads + optional tag writes.

```ts
interface ContactAdapter {
  getById(externalId: string): Promise<Contact | null>
  getByEmail(email: string): Promise<Contact | null>
  getBatch(externalIds: string[]): Promise<Map<string, Contact>>
  query(
    filter: AdapterFilter,
    opts: { limit: number; cursor?: string },
  ): Promise<{ contacts: Contact[]; nextCursor?: string }>
  count(filter: AdapterFilter): Promise<number>

  // Optional: present only if the host stores tags and wants mailery to write.
  addTags?(externalId: string, tags: string[]): Promise<void>
  removeTags?(externalId: string, tags: string[]): Promise<void>
}
```

### When `addTags` / `removeTags` are absent

mailery falls back to its own `mailer_contact_tags` collection. Behavior from app code is identical — `mailer.tag('u1', 'vip')` works either way.

### Implementation tips

- **Cursor stability**: pagination should be deterministic. mailery uses cursors as `>` bounds; if your underlying store doesn't have a natural ordering, sort by primary key.
- **`getByEmail` may be missing**: some stores don't index email. If your `getByEmail` is a full scan, mailery still works but webhook event correlation (matching a bounce email back to a `subscription`) will be slow.
- **Hot-path caching**: mailery calls `getById` heavily during a broadcast. Consider caching at the adapter level with a short TTL.

## Built-in adapters

- [`MongoContactAdapter`](/reference/mongo-contact-adapter) — for Mongo-backed hosts
- `MemoryContactAdapter` (from `mailery/testing`) — in-process for tests

For non-Mongo hosts, implement the interface yourself. Usually 100-200 lines.
