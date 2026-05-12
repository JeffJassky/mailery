# Segments

```ts
import type { SegmentDefinition, SegmentFilter } from 'mailery'
```

Used by broadcasts and (future) segment-entry flow triggers.

## SegmentDefinition

```ts
interface SegmentDefinition {
  filters: SegmentFilter[]      // AND-ed together at the top level
}
```

## SegmentFilter

```ts
type SegmentFilter =
  // Host-side (evaluated via the adapter)
  | { kind: 'fieldEquals'; field: string; value: unknown }
  | { kind: 'fieldIn'; field: string; values: unknown[] }
  | { kind: 'fieldExists'; field: string }
  | { kind: 'hasTag'; tag: string }
  | { kind: 'notHasTag'; tag: string }
  // Mailer-side (evaluated against mailer collections)
  | { kind: 'subscriptionStatus'; equals: 'subscribed' | 'unsubscribed' | 'pending_doi' | 'bounced' | 'complained' }
  | { kind: 'firedEvent'; eventName: string; withinDays?: number }
  | { kind: 'notFiredEvent'; eventName: string; withinDays?: number }
  | { kind: 'subscribedAfter'; date: Date }
  | { kind: 'subscribedBefore'; date: Date }
  | { kind: 'opened'; templateSlug?: string; withinDays?: number }
  | { kind: 'notOpened'; templateSlug?: string; withinDays?: number }
  // Composition
  | { kind: 'any'; filters: SegmentFilter[] }          // OR
  | { kind: 'not'; filter: SegmentFilter }
```

## Evaluation order

Two-pass:

1. **Stage A — host filter**: mailery calls `adapter.query()` with the host-relevant filters (`fieldEquals`, `fieldIn`, `hasTag`, etc.). The adapter returns a cursor.
2. **Stage B — mailer post-filter**: mailery streams the cursor through its own filters (`firedEvent`, `subscriptionStatus`, `opened`, etc.), dropping contacts that fail.
3. **Suppression check**: at send time, every recipient is re-checked against `mailer_suppressions`. Suppressed contacts are skipped.

The admin UI broadcast composer shows recipient counts at each stage so you can see where the segment narrows.

## Example

"Subscribed Pro users who haven't fired the 'Cancelled' event in the last 90 days, excluding anyone with the 'do-not-email' tag":

```ts
const segment: SegmentDefinition = {
  filters: [
    { kind: 'subscriptionStatus', equals: 'subscribed' },
    { kind: 'fieldEquals', field: 'tier', value: 'Pro' },
    { kind: 'notHasTag', tag: 'do-not-email' },
    { kind: 'notFiredEvent', eventName: 'Cancelled', withinDays: 90 },
  ],
}
```

## OR / NOT composition

`filters: [...]` at the top level is AND. For OR within a slot, use `kind: 'any'`:

```ts
{
  filters: [
    { kind: 'subscriptionStatus', equals: 'subscribed' },
    {
      kind: 'any',
      filters: [
        { kind: 'hasTag', tag: 'beta' },
        { kind: 'fieldEquals', field: 'tier', value: 'Pro' },
      ],
    },
  ],
}
```

For NOT, wrap a sub-filter:

```ts
{ filters: [{ kind: 'not', filter: { kind: 'hasTag', tag: 'banned' } }] }
```

## Performance

- **Host-side filters first**: design the adapter to narrow aggressively at Stage A. A `fieldEquals` on an indexed Mongo field is cheap; a `firedEvent` post-filter on 100K contacts is not.
- **`withinDays` for event filters**: bound the lookup window. Without it, mailery scans all of `mailer_events` for that contact.
- **`opened` / `notOpened` are heavy**: they hit `mailer_sends` per contact. Use sparingly; prefer real product events for engagement.

## Where segments are used

- **Broadcasts**: `mailer_broadcasts.segmentDefinition` is evaluated at dispatch time.
- **Live count in admin UI**: the broadcast composer calls `POST /admin/mailer/api/broadcasts/:slug/segment/count` with the in-progress definition; mailery returns 3-stage counts (host, mailer-post-filter, after-suppression).
- **Future**: segment-entry flow triggers (`trigger.type: 'segment_enter'`) — periodic re-evaluation to enter newly-matching contacts.
