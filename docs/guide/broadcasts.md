# Broadcasts

A broadcast is a one-off campaign to a segment of your contacts — newsletters, product announcements, special offers. It is bulk mail: it needs a **marketing** template, so every send carries `List-Unsubscribe`, honours marketing opt-outs and is held by the circuit breaker.

## Lifecycle

```
draft ──schedule──▶ scheduled ──tick at scheduledAt──▶ sending ──▶ sent
  │                    │                                  │
  └──────cancel────────┴──────────────cancel──────────────┤
                                                          ▼
                                   paused ◀── cap reached / stop rule / circuit breaker / operator
                                     │
                                     └──resume──▶ sending
```

`failed` means dispatch could not run (template missing or not marketing, an adapter error) — `failureReason` says which. `paused` carries a `pauseReason` (`cap_reached`, `stop_rule`, `circuit_breaker`, `manual`) and only an explicit resume re-opens it.

## Authoring

### From the admin UI

Visit `/admin/mailer/broadcasts`, click "New broadcast":

1. **Content** — pick a template.
2. **Segment** — assemble filters. The live recipient count refreshes as you edit.
3. **Schedule** — send now, at a specific time, or save as draft.

Above the configured threshold (default 1000), scheduling requires typing the recipient count exactly — INVARIANT 11, the "I clicked send instead of preview" gate. Since 0.18 the count the composer shows is exact (see [Recipient count](#recipient-count)); it used to be the host filter alone.

The admin UI has no controls for waves, stop-rule overrides, pause or resume yet. Use the agent API for those.

### From the agent API

Everything the admin UI does, plus waves, stop rules, pause/resume and test sends, is on the [agent API](/reference/agent-api#broadcasts) under a bearer token. The agent path is stricter than the admin path: it refuses a segment that is not limited to `subscriptionStatus: subscribed`, validates segments strictly on every write, and schedules or resumes only when `confirmedCount` equals the true count.

There is no `mailer.scheduleBroadcast()`; earlier versions of this page described one that never existed. A broadcast written straight into `mailer_broadcasts` skips every gate on this page.

## Segments

Segments are arrays of filters AND-ed together.

**Host-side** (your adapter's query):
- `fieldEquals` — `{ field: 'tier', value: 'Pro' }`
- `fieldIn` — `{ field: 'customerType', values: ['commercial', 'social'] }`
- `fieldExists`
- `hasTag` / `notHasTag`

**Mailer-side** (mailery's own collections):
- `subscriptionStatus` — `{ equals: 'subscribed' }`
- `firedEvent` / `notFiredEvent` — `{ eventName: 'Created', withinDays: 90 }`
- `subscribedAfter` / `subscribedBefore` — compares `mailer_subscriptions.subscribedAt`; a contact without one matches neither
- `opened` / `notOpened` — `{ templateSlug: 'newsletter-may', withinDays: 14 }`, from `mailer_sends.openedAt`. Directional only: Apple Mail Privacy Protection opens everything, and text-only templates never record an open.

**Composition**: `any` (OR of nested filters), `not` (negate).

Evaluation is two-pass. **Stage A**: `adapter.query()` takes at most one condition per adapter slot, from the top level only (one `hasTag`, one condition per field). **Stage B**: every other filter runs over each streamed page, with one batched lookup per distinct filter per page — mailer-side kinds, a second `hasTag`, and anything nested in `any`/`not`. Host-side kinds evaluated in stage B read the adapter's `Contact` projection (`tags`, and `fields` by dotted path), which a custom `toContact` decides.

Values are primitives only (an object such as `{ $ne: null }` would reach a Mongo-backed adapter as an operator), field names may not start with `$`, and an unknown filter kind is refused rather than treated as a match. Before 0.18 stage B treated `opened`, `notOpened`, `subscribedAfter`, `subscribedBefore` and nested host-side filters as "matches everyone", and a second `hasTag` replaced the first.

## Recipient count

The count is the dispatch stream itself, counted instead of enqueued: host filter, stage B, a sendable address, and not suppressed for the template's kind — minus contacts that already have a send row for this broadcast, within the cap. `POST /broadcasts/:slug/count` on the agent API returns every stage (`hostMatched`, `eligible`, `alreadySent`, `sendsSoFar`, `uncappedRecipientCount`, `recipientCount`, `heldSends`). It costs one pass over the host filter's matches.

## Waves

A staged send — test contacts, seed inboxes, 200 most recently active, 1,500, the rest — is one broadcast with a cap and an order:

```json
{
  "recipientCap": 200,
  "order": { "field": "updatedAt", "direction": "desc" }
}
```

- `recipientCap` bounds the broadcast's **total send rows** (every status, earlier waves included). Dispatch walks the eligible stream in `order`, skips anyone who already has a row, and enqueues until the rows reach the cap. If eligible contacts remain, the broadcast parks in `paused` with `pauseReason.code: 'cap_reached'`; a cap that exactly covers the audience ends as `sent`.
- The next wave is `POST /broadcasts/:slug/resume { recipientCap: <higher>, confirmedCount }` (`null` removes the cap). It sends only to eligible contacts, in order, who have no row yet. Anyone who unsubscribed or bounced since is skipped without shrinking the wave. A parked wave's queued sends go out normally; parking is not a hold.
- `order.field` is a field on the host's contact record (for `MongoContactAdapter`, a document path), not a key of `Contact`. Ties break on the contact id. Adapters opt in with `supportsSort: true`; an order on an adapter without it is refused, not silently ignored. `MongoContactAdapter` pages the sort with a keyset cursor on `(field, id)` and puts contacts without the field last in `desc`. Keep the field to one BSON type, and index `{ <field>: -1, _id: 1 }` on a large collection. A value that changes while a pass is paging can be seen twice (the dedupe key stops a second send) or skipped (a later wave picks it up).
- One dispatcher holds a lease per broadcast, so a stalled-dispatch rescue racing a slow worker cannot overshoot the cap.

## Time zones

With `respectRecipientTimezone: true`, each recipient gets the mail when their local wall clock reads what `scheduledAt` reads **in UTC**. `scheduledAt: 2026-09-17T10:00:00Z` means 10:00 local everywhere: 14:00Z for New York, 08:00Z the next day for Berlin (a slot already past becomes tomorrow's). A contact with no `timezone` gets it at `scheduledAt`. A wave dispatched later than `scheduledAt` rolls each recipient forward to their next local slot rather than sending to everyone at once. Each send records the moment in `notBefore`.

This only does anything if your adapter's contacts carry `timezone`.

## Stop rules

Every broadcast watches its own delivery. Defaults, set in `MailerConfig.broadcastStopRules` and overridable per broadcast (`stopRules` on create, patch or resume):

| Rule | Default |
|---|---|
| `hardBounceRatePct` | 2 |
| `complaintRatePct` | 0.1 |
| `unsubscribeRatePct` | 1 |
| `minSample` | 100 |
| `enabled` | true |

Rates are measured over the broadcast's sends with a known outcome (delivered or bounced). Nothing fires until `minSample` of them are in, and a breach is `rate > threshold`. Rules are evaluated on every bounce, complaint or unsubscribe webhook for a broadcast send, on a one-click unsubscribe from the email itself (the unsubscribe token names the send), and on every tick.

A breach pauses the broadcast with `pauseReason: { code: 'stop_rule', breaches, sample, rules }`. Nothing more is enqueued, and its queued sends move to `held`; a held send is never dispatched. A breach after everything already went out is recorded as `stopRuleBreach` instead. A stop-rule pause outranks a parked wave, so raising the cap alone cannot re-open it.

Resume refuses (`409 stop_rule_still_breached`) while the rules, as they would stand, still fire. Investigate first, then override in the same call, for example `{ "stopRules": { "hardBounceRatePct": 5 }, "confirmedCount": … }`. `confirmedCount` is new recipients plus held sends; held sends are re-queued with the delay left until their `notBefore`. `onBroadcastPaused` in `MailerConfig` is the hook for alerting.

## Circuit breaker

The breaker is per (sender domain × kind), so a broadcast shares its bucket with every triggered **marketing** flow sent from the same domain. A bad wave that trips it holds those flows too, until someone resumes the bucket (`POST /api/health/resume`). When the bucket trips, the broadcast pauses (`pauseReason.code: 'circuit_breaker'`) and its sends are held. It no longer requeues every send every 60 seconds. Dispatch also checks the bucket before each page. Resume is refused until the bucket is reset.

## Pause, resume, cancel

- **Pause** (`POST /broadcasts/:slug/pause`, agent API): holds queued sends; `pauseReason.code: 'manual'`.
- **Resume**: see above; the only way out of `paused`.
- **Cancel**: stops dispatch and cancels the broadcast's queued and held sends. A send already handed to the provider has gone. A `sent` broadcast with nothing left to send cannot be cancelled.

## Test sends

`POST /broadcasts/:slug/test-send { contactIds }` sends the broadcast's template, rendered as each contact, through the real pipeline (tracking, unsubscribe link, provider) without scheduling anything. Test contacts only (`testContacts` on the agent router). The sends carry no `broadcastId`, so they never count in the broadcast's stats, cap or stop rules. Seed inboxes you want to test with must match your `testContacts` pattern.

## Suppression at send time

Every recipient is re-checked at send time. A contact who unsubscribes between scheduling and dispatch is skipped — INVARIANT 3.

## Send-rate shaping

The send worker is rate-limited per provider. A 100k-recipient broadcast won't burst — it streams out at `provider.sendRatePerSecond`. Tune this on your provider config:

```ts
new SendGridProvider({
  apiKey: '...',
  sendRatePerSecond: 50,   // shared IP default is 10
})
```

## Stats

Stats are computed from `mailer_sends` when read. The `stats` sub-document stored on a broadcast is never updated; ignore it. `GET /broadcasts/:slug` on the agent API returns:

```ts
{
  total, accepted, delivered, bounced, hardBounced, softBounced,
  complained, unsubscribed, opened, clicked,
  outcomes,            // delivered or bounced: the denominator below
  rates: {
    deliveryRatePct,   // delivered / accepted
    bounceRatePct, hardBounceRatePct, complaintRatePct, unsubscribeRatePct,  // / outcomes
    openRatePct, clickRatePct,                                               // / delivered
  },
}
```

…plus a per-status count of the send rows, the pause reason, cap progress and the stop-rule evaluation. Counts read the sticky fields (`deliveredAt`, `bounceType`, `complainedAt`, `unsubscribedAt`) rather than `status`, which later events overwrite.
