# MongoContactAdapter

Default `ContactAdapter` for Mongo-backed hosts. Reads contacts from your existing user collection — read-mostly with optional narrow tag writes. mailery never duplicates identity data.

```ts
import { MongoContactAdapter } from 'mailery'
```

## Constructor

```ts
new MongoContactAdapter({
  db,                                  // mongodb.Db (your host's database)
  collection: 'users',
  emailField: 'email',
  idField: '_id',

  // Tags integration (optional)
  tagsField: 'tags',
  tagsWritable: true,
  tagsArrayShape: 'strings',            // or 'objects' for [{ name: 'vip' }]

  // Customize what mailer sees as fields (optional)
  toContact: (user) => ({
    externalId: user._id.toString(),
    email: user.email,
    tags: user.tags ?? [],
    timezone: user.timezone,
    locale: user.locale,
    fields: {
      firstName: user.name,
      lastName: user.lastName,
      jobTitle: user.jobTitle,
    },
  }),

  // Customize how AdapterFilter becomes a Mongo query (optional)
  translateFilter: (filter) => ({ /* ... */ }),

  batchSize: 500,
})
```

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `db` | `Db` | — | Required. Your host's MongoDB. |
| `collection` | `string` | — | Required. The collection name (e.g. `'users'`). |
| `emailField` | `string` | `'email'` | Path to the email on each document. |
| `idField` | `string` | `'_id'` | Path to the id. mailery uses `String(doc[idField])` as the externalId. |
| `tagsField` | `string \| undefined` | none | Path to the tags array. Without this, mailery uses `mailer_contact_tags` for tag storage. |
| `tagsWritable` | `boolean` | `false` | If true, `addTags` / `removeTags` mutate `tagsField` directly via `$addToSet` / `$pull`. |
| `tagsArrayShape` | `'strings' \| 'objects'` | `'strings'` | `'objects'` means tags are `[{ name: 'vip' }]` rather than `['vip']`. |
| `toContact` | `(doc) => Contact` | builtin | Project a user document into mailer's `Contact` shape. The default exposes every field except `_id` / email / tags as `fields`. |
| `translateFilter` | `(filter) => MongoFilter` | builtin | How `AdapterFilter` becomes a Mongo query. Default handles all standard filters. |
| `batchSize` | `number` | `500` | Max docs per `query()` call. |

## Default projection

If you don't pass `toContact`, the adapter exposes:

```ts
{
  externalId: String(doc._id),
  email: doc.email.toLowerCase(),
  tags: doc.tags ?? [],
  timezone: doc.timezone,
  locale: doc.locale,
  fields: {
    // every doc property EXCEPT _id, email, tags
    ...rest
  }
}
```

So if your user collection has `firstName`, `jobTitle`, `customerType` fields, all three appear under `contact.fields.*` automatically.

## Custom `toContact`

If you want a controlled subset:

```ts
new MongoContactAdapter({
  db,
  collection: 'users',
  toContact: (user) => ({
    externalId: user._id.toString(),
    email: user.email,
    tags: user.tags ?? [],
    fields: {
      firstName: user.firstName,
      tier: user.subscription?.tier,        // computed
      activeForDays: Math.floor((Date.now() - user.createdAt) / 86400000),
    },
  }),
})
```

Only fields returned by `toContact` are visible to templates and segment filters. Anything not exposed is "invisible" to mailery.

## Implementing `ContactAdapter` for non-Mongo hosts

If your user store is Postgres / MySQL / a custom service, implement the [`ContactAdapter` interface](/reference/types-contact) directly — it's a six-method protocol. See the [Custom adapters guide](/guide/configuration#custom-adapter) for an example.

## Tag storage decision

| Your setup | Recommendation |
|---|---|
| You already have `user.tags: ['vip', 'beta']` and use it for in-app features | `tagsField: 'tags', tagsWritable: true`. mailery reads + writes the host's tag array directly. |
| Your user model doesn't have a tags field, or you don't want mailery touching it | Omit `tagsField`. mailery uses `mailer_contact_tags` (a per-externalId collection) instead. |
| You have `user.tags: [{ name: 'vip' }, { name: 'beta' }]` | `tagsField: 'tags', tagsWritable: true, tagsArrayShape: 'objects'`. |

Either way, application code uses `mailer.tag(externalId, tag)` / `mailer.untag(...)` — the storage is swappable.
