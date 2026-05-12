# Events

Events are the trigger surface mailery exposes to your app. You fire them from your business logic; flows pick them up and run.

## Register events at startup

```ts
mailer.registerEvent({ name: 'Created',         dedupePolicy: 'once-per-contact' })
mailer.registerEvent({ name: 'Activated app',   dedupePolicy: 'once-per-contact' })
mailer.registerEvent({ name: 'Hit Free Limit',  dedupePolicy: 'once-per-day' })
mailer.registerEvent({ name: 'Viewed Storyboard', dedupePolicy: 'once-per-day' })
mailer.registerEvent({ name: 'Imported',        dedupePolicy: 'every-time' })
```

Registration is optional — without it, every `fire()` for that name must pass an explicit `dedupeKey`. But registering makes calls in your code cleaner.

## Dedupe policies

Every event row in `mailer_events` has a unique `dedupeKey`. When you `fire()`, mailery derives one based on the policy. Calls with a colliding key are silent no-ops at the unique index.

| Policy | Derived key | Use when |
|---|---|---|
| `once-per-contact` | `${externalId}:${eventName}` | Lifecycle markers ("Created", "Activated app"). A flow with `trigger.once: true` enters at most once per contact. |
| `once-per-day` | `${externalId}:${eventName}:${YYYY-MM-DD}` | Behaviors that recur but shouldn't burn a flow every time ("Viewed Storyboard"). |
| `every-time` | `${externalId}:${eventName}:${UUIDv4}` | True every-occurrence ("Imported a video"). |

## Firing events

```ts
// With a registered policy — no key needed:
await mailer.fire('Created', user._id.toString())
await mailer.fire('Viewed Storyboard', user._id.toString(), { id: 'sb_82a' })

// With an explicit key (e.g. from an upstream webhook source):
await mailer.fire('Stripe Webhook', user._id.toString(), { type: e.type }, e.id)
```

`fire()` returns immediately after a single insert. The flow runner picks up new events on its next tick (within 60s by default) and creates `flow_runs` for any matching flow triggers.

## Firing inside a Mongo transaction

If you fire an event as part of a multi-document write, use `fireFromSession` — it writes to `mailer_outbox` inside the transaction. A separate drain promotes outbox rows to `mailer_events` after the transaction commits. If your transaction rolls back, the event never fires.

```ts
const session = client.startSession()
await session.withTransaction(async () => {
  await users.updateOne({ _id }, { $addToSet: { tags: 'Imported' } }, { session })
  await mailer.fireFromSession(session, 'Imported', _id.toString())
})
```

Calling plain `mailer.fire()` inside a transaction is a bug — the event will dispatch even if the transaction aborts.

## Event payload

`mailer_events` documents look like:

```ts
{
  _id: ObjectId,
  externalId: string,         // your user._id, as a string
  name: string,               // 'Created' etc.
  properties: object,         // arbitrary; available in predicates as `event.properties.*`
  dedupeKey: string,          // unique
  occurredAt: Date,
  createdAt: Date,
}
```

Properties are passed via the third arg to `fire()`. They're stored as-is and can be used in flow predicates (e.g. `hasFiredEvent: 'Created'` could check property values in a future version).

## Naming conventions

Event names are case-sensitive strings, free-form. The convention is title-case with spaces: `'Created'`, `'Hit Free Limit'`, `'Viewed Storyboard'`. Pick a vocabulary and stick to it — flows and segments reference these names verbatim.

Common shapes:

- **Lifecycle**: `Created`, `Activated app`, `Customer`, `Cancelled`, `Refunded`, `Reactivated`
- **Behavior**: `Imported`, `Exported`, `Viewed Storyboard`, `Downloaded app`
- **Threshold**: `Hit Free Limit`, `Approached Quota`, `Trial Ending`

## Why no events for opens/clicks?

Opens and clicks are NOT events. They live on `mailer_sends` directly (`openedAt`, `firstClickAt`, etc.) and are queryable via predicates like `hasOpenedExcludingBots` or `clickedAtLeastN`.

The single-open / single-click predicates exist but are labeled noisy in the admin UI — Apple Mail Privacy Protection prefetches all images on inbox arrival, and corporate firewalls prefetch links. Prefer real product events (`Used Feature X`) for engagement-based branching, or aggregate predicates (`openedAtLeastN: { count: 3, withinDays: 30 }`).
