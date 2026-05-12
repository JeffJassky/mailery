# Broadcasts

A broadcast is a one-off campaign to a segment of your contacts — newsletters, product announcements, special offers.

## Authoring

### From the admin UI (recommended)

Visit `/admin/mailer/broadcasts`, click "New broadcast":

1. **Content** — pick a template, override the From / Subject if needed.
2. **Segment** — assemble filters. Live recipient count refreshes as you edit.
3. **Schedule** — send now, at a specific time, or save as draft.

Above the configured threshold (default 1000), the schedule button is disabled until you type the recipient count exactly. This is INVARIANT 11 — the "I clicked send instead of preview" gate.

### Programmatically

```ts
await mailer.scheduleBroadcast({
  templateSlug: 'monthly-newsletter',
  segmentDefinition: {
    filters: [
      { kind: 'subscriptionStatus', equals: 'subscribed' },
      { kind: 'hasTag', tag: 'Customer' },
      { kind: 'notFiredEvent', eventName: 'Cancelled', withinDays: 365 },
    ],
  },
  scheduledAt: new Date('2026-06-01T15:00:00Z'),
  name: 'June Newsletter',
  createdBy: 'script:operator',
})
```

The programmatic API bypasses the typed-count gate — the caller is responsible for the recipient count being right.

## Segments

Segments are arrays of filters AND-ed together. Two filter kinds:

**Host-side** (evaluated via your adapter):
- `fieldEquals` — `{ field: 'tier', value: 'Pro' }`
- `fieldIn` — `{ field: 'customerType', values: ['commercial', 'social'] }`
- `fieldExists`
- `hasTag` / `notHasTag`

**Mailer-side** (evaluated against mailer collections):
- `subscriptionStatus` — `{ equals: 'subscribed' }`
- `firedEvent` — `{ eventName: 'Created', withinDays: 90 }`
- `notFiredEvent`
- `subscribedAfter` / `subscribedBefore`
- `opened` / `notOpened` — `{ templateSlug: 'newsletter-may', withinDays: 14 }`

**Composition**:
- `any` — OR of nested filters
- `not` — negate

The runner evaluates host-side filters first via `adapter.query()` (cursor-based, paginated), then streams the results through mailer-side post-filters. Counts are computed at each stage; the admin UI shows all three (Stage A, Stage B, after suppression check).

## Suppression at send time

Every recipient is re-checked at send time. A contact who unsubscribes between scheduling and dispatch is skipped — INVARIANT 3.

## Cancelling

Cancel a scheduled broadcast from the admin UI before its `scheduledAt`. Once dispatch starts, you can pause new send-job enqueues, but emails already in the queue will go out (mailery stops feeding the queue; it doesn't mass-cancel jobs already enqueued).

## Send-rate shaping

The send worker is rate-limited per provider. A 100k-recipient broadcast won't burst — it streams out at `provider.sendRatePerSecond`. Tune this on your provider config:

```ts
new SendGridProvider({
  apiKey: '...',
  sendRatePerSecond: 50,   // shared IP default is 10
})
```

For dedicated IPs or large warmed-up SendGrid accounts, raise this to whatever your provider permits.

## Stats

Per-broadcast stats live on `mailer_broadcasts.stats`:

```ts
{
  sent: 11243,
  delivered: 11187,
  opened: 4831,
  clicked: 1018,
  bounced: 56,
  complained: 3,
  unsubscribed: 14,
}
```

These update asynchronously from provider webhooks. Live tracking of opens and clicks happens via the `/m/open/...` and `/m/click/...` endpoints.
