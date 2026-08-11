# Tracking

mailery tracks opens, clicks, deliveries, bounces, and complaints. All five converge on `mailer_sends` documents.

## Open tracking

A 1×1 transparent PNG is appended to every send with `trackOpens: true`:

```html
<img src="https://yourdomain.com/m/open/<sendId>.<sig>.png" width="1" height="1" alt="" style="display:block" />
```

When the recipient's mail client fetches it, mailery records `openedAt`, increments `openCount`, and appends `{ openedAt, userAgent }` to `mailer_sends.opens` (capped at the 50 most recent) so the bot filter has something to work with.

### Why opens are noisy

Apple Mail Privacy Protection (iOS 15+, 2021) prefetches all images on inbox arrival — every email to an Apple Mail recipient shows as "opened" within seconds of delivery. Corporate firewalls + spam filters also prefetch. Treat opens as a **deliverability signal**, not engagement.

For branching flows, use real product events (`Used Feature X`) or aggregated predicates (`openedAtLeastN: { count: 3, withinDays: 30 }`).

## Click tracking

At send time, every `<a href="X">` becomes `<a href="https://yourdomain.com/m/click/<sendId>/<linkId>/<sig>">` where `linkId` is a short hash of the URL within the send. The original-URL map is stored on `mailer_sends.links` for lookup.

When the recipient clicks, mailery records `firstClickAt` + appends to `clickedLinks` (with the requesting user agent) + 302-redirects to the original URL.

### Links NOT rewritten

- Anything that isn't an absolute `http:` / `https:` URL. That covers `mailto:` and `tel:`, and also means a template variable that lands a `javascript:` or `data:` URL in an href position is left as authored rather than being handed a tracking redirect. A malformed href is skipped, never thrown on — one bad variable must not fail the render and block the send.
- Anchors (`#section`)
- The send's own unsubscribe URL (passed to `applyTracking` as `preserveUrls`)
- Any `<a data-mailer-notrack="true" href="...">` link

The click endpoint validates the stored target's scheme *again* at redirect time and answers 400 without counting the click. Both checks stay: the render-time skip cannot help links written directly to a send document, and the redirect-time check cannot help links that were already rewritten.

## Signed tracking URLs

The `<sig>` in both URLs is a 12-character truncated HMAC over the URL's own path components, keyed with `unsubscribeSecret`. Without it, the only secret in a tracking URL is a Mongo ObjectId — a timestamp plus a per-process-constant random plus a sequential counter — so one received email largely gives up the ids of its neighbours, and anyone can forge opens and clicks for mail they never received.

That is not only a reporting problem. `hasOpened`, `hasClicked` and `openedAtLeastN` are flow inputs, so forged opens advance recipients through automation, fire follow-up sends, and corrupt the numbers you make decisions from.

Signing is automatic — nothing to configure. What *is* configurable is how the endpoints treat unsigned URLs still sitting in mail you sent before upgrading, and whether URLs expire at all:

```ts
await Mailer.init({
  // ...
  requireSignedTrackingUrls: false,  // default — still count legacy unsigned URLs
  trackingUrlLifetimeDays: 0,        // default — never expire
})
```

Full format, status codes, and the migration procedure: [Tracking URL signatures](/reference/public-endpoints#tracking-url-signatures).

## Filtering bots out of predicates

`hasOpenedExcludingBots`, `hasClickedExcludingBots`, `openedAtLeastN` and `clickedAtLeastN` drop opens and clicks whose recorded user agent matches a scanner pattern. A send counts if *any* one of its opens (or clicks) looks human, so a scanner that prefetches ahead of the recipient does not disqualify the recipient.

An open or click with **no** user agent counts as human. Image fetches frequently carry none and Apple's privacy proxy strips identifying headers, so treating unknown as bot would silently discard a large share of real engagement — and would retroactively empty flows branching on sends recorded before user agents were stored. The cost is that a scanner sending no UA still counts.

Tune with [`botFilter`](/guide/configuration#bot-filtering). These predicates remain a noisy signal with a filter on top (INVARIANT 7); where a product event exists, prefer it.

## Provider webhooks

Your provider POSTs delivery / open / click / bounce events to:

```
POST /m/webhooks/:provider
```

(e.g. `/m/webhooks/sendgrid`). mailery:

1. Verifies the provider's signature (HMAC for SendGrid).
2. Deduplicates against `mailer_webhook_events` by `(provider, providerEventId)`.
3. Returns 200 fast — INVARIANT 5.
4. Asynchronously applies each event to the matching `mailer_sends` row.

### Cascade effects

- **`delivered`** → `status: 'delivered'`, `deliveredAt: timestamp`
- **`open`** → `openedAt: first-seen`, `openCount: ++`
- **`click`** → `firstClickAt: first-seen`, `clickCount: ++`
- **`bounce` (hard)** → `status: 'bounced'`, suppress contact (scope `all`), subscription → `bounced`
- **`bounce` (soft)** → `status: 'bounced'`, no suppression (provider retries internally)
- **`complaint`** → suppress contact (scope `all`), subscription → `complained`
- **`unsubscribe`** → suppress contact (scope `marketing`), subscription → `unsubscribed`

## SendGrid setup

In SendGrid dashboard:

1. **Authenticate sender domain** — SPF, DKIM, DMARC. Single biggest deliverability lever.
2. **Configure event webhook** — POST to `https://yourdomain.com/m/webhooks/sendgrid`.
3. **Enable event types** — delivered, open, click, bounce, dropped, spamreport, unsubscribe.
4. **Generate Signed Event Webhook public key** — store as `SENDGRID_WEBHOOK_KEY` env var.

mailery disables SendGrid's own click + open tracking in favor of doing it itself — letting both rewrite produces double-rewriting and breaks counts.

## Per-template control

```ts
{
  trackOpens: false,    // disable for transactional receipts
  trackClicks: false,
}
```

Or globally:

```ts
await Mailer.init({
  // ...
  trackOpens: false,
  trackClicks: false,
})
```

Templates with `bodyFormat: 'text_only'` track nothing regardless of these
flags — no HTML part means nowhere for the open pixel, and click rewriting is
skipped so the text keeps readable URLs. See
[Plain-text-only templates](./templates.md#plain-text-only-templates).

## IPs

Mailery does **not** store recipient IPs by default. Only User-Agent and timestamp — user agents are recorded on `opens[]` and `clickedLinks[]` for bot classification, truncated to 256 characters. To opt in to IPs as well (for compliance investigations):

```ts
await Mailer.init({
  // ...
  storeTrackingIp: true,
})
```
