# Tracking

mailery tracks opens, clicks, deliveries, bounces, and complaints. All five converge on `mailer_sends` documents.

## Open tracking

A 1×1 transparent PNG is appended to every send with `trackOpens: true`:

```html
<img src="https://yourdomain.com/m/open/<sendId>.png" width="1" height="1" alt="" style="display:block" />
```

When the recipient's mail client fetches it, mailery records `openedAt` + increments `openCount` on the Send row.

### Why opens are noisy

Apple Mail Privacy Protection (iOS 15+, 2021) prefetches all images on inbox arrival — every email to an Apple Mail recipient shows as "opened" within seconds of delivery. Corporate firewalls + spam filters also prefetch. Treat opens as a **deliverability signal**, not engagement.

For branching flows, use real product events (`Used Feature X`) or aggregated predicates (`openedAtLeastN: { count: 3, withinDays: 30 }`).

## Click tracking

At send time, every `<a href="X">` becomes `<a href="https://yourdomain.com/m/click/<sendId>/<linkId>">` where `linkId` is a short hash of the URL within the send. The original-URL map is stored on `mailer_sends.links` for lookup.

When the recipient clicks, mailery records `firstClickAt` + appends to `clickedLinks` + 302-redirects to the original URL.

### Links NOT rewritten

- `mailto:` and `tel:` links
- Anchors (`#section`)
- The send's own unsubscribe URL (passed to `applyTracking` as `preserveUrls`)
- Any `<a data-mailer-notrack="true" href="...">` link

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

## IPs

Mailery does **not** store recipient IPs by default. Only User-Agent and timestamp. To opt in (for compliance investigations):

```ts
await Mailer.init({
  // ...
  storeTrackingIp: true,
})
```
