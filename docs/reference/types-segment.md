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

1. **Stage A — host filter**: mailery calls `adapter.query()` with at most one condition per adapter slot, taken from the top level (the first `hasTag`, one condition per field). The adapter returns a cursor.
2. **Stage B — mailer post-filter**: every other filter runs over each streamed page with one batched lookup per distinct filter: mailer-side kinds (`subscriptionStatus`, `firedEvent`, `opened`, `subscribedAfter`, …), extra host-side filters, and everything nested in `any` / `not`. Host-side kinds evaluated here read the `Contact` projection (`tags`, `fields` by dotted path).
3. **Suppression check**: recipients suppressed for the template's kind are skipped at dispatch, and every send is re-checked at send time.

`POST /broadcasts/:slug/count` on the agent API reports the count after each stage, and the admin composer's count is the final one.

Segments are validated when saved and strictly when scheduled: values are primitives, field names may not start with `$`, and an unknown kind is refused — never evaluated as "matches everyone".

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
