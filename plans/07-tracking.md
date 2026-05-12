# 07 — Tracking

Three tracking mechanisms cooperate to measure email engagement: the **open pixel**, **click rewriting**, and **inbound provider webhooks**. They all converge on `mailer_sends` rows.

## Open pixel

A 1×1 transparent PNG appended to the bottom of every marketing email (and to transactional emails with `trackOpens: true`).

```html
<img src="https://yourdomain.com/m/open/<sendId>.png" width="1" height="1" alt="" style="display:block;" />
```

Endpoint behavior:

```
GET /m/open/:sendId.png
  → returns 1×1 PNG (cached: forever; no-cache headers OK either way)
  → fires async: mailer.recordOpen(sendId, { ua, ip, at })
```

The recorded open updates `mailer_sends`:

```ts
{
  openedAt: <first open>,    // never decreases
  openCount: <incremented>,
  status: 'delivered',        // if it was 'sent', promote to 'delivered'
}
```

Tracking is async — the pixel returns 200 immediately even if Mongo writes are slow. Any failure is logged but never blocks the response.

### Why we don't trust opens for decision-making

Apple Mail Privacy Protection (MPP), shipped on iOS 15+ in 2021, pre-fetches all images on inbox arrival regardless of whether the user actually opens the email. That means **every send to an Apple Mail user records an "open" within seconds of delivery, whether they looked at it or not**. Most B2C audiences are 30–60% Apple Mail. For B2B with iPhone-heavy decision-makers, it's higher.

Bot prefetchers (corporate firewalls, link checkers) compound the noise.

**Net result**: open rate is a deliverability signal, not an engagement signal. Treat it as such:

- ✅ Useful for: "did this email get through to inboxes?" (gross delivery + display check)
- ✅ Useful for: A/B subject line tests at scale (relative comparison)
- ❌ Don't use for: branching individual contact flows ("if they opened, send X; otherwise Y")
- ❌ Don't use for: "engaged user" segmentation as a sole signal

Per `INVARIANTS.md` rule 7, the library deliberately does not ship `hasOpened` as a flow predicate. If you need engagement-based branching, fire an explicit behavioral event from the app when the user does something in-product.

## Click rewriting

At send time, after Handlebars rendering and MJML compilation, every `<a href="X">` in the email body becomes a tracked URL:

```html
<!-- Author wrote: -->
<a href="https://storyfolder.com/help/getting-started">Read the guide</a>

<!-- Rendered as: -->
<a href="https://yourdomain.com/m/click/<sendId>/<linkId>">Read the guide</a>
```

Each link gets a stable `linkId` (a short hash of the URL within the send) so multiple distinct destinations are tracked independently.

Endpoint:

```
GET /m/click/:sendId/:linkId
  → look up original URL in mailer_sends.clickedLinks[linkId].url
  → fires async: mailer.recordClick(sendId, linkId, { ua, ip, at })
  → 302 → original URL
```

Recorded click updates `mailer_sends`:

```ts
{
  firstClickAt: <first click>,
  clickCount: <incremented>,
  clickedLinks: [{ url, linkId, clickedAt }, ...],
  status: 'delivered',        // promote
}
```

### Exceptions to rewriting

The following links are NOT rewritten (always go direct):

- `{{unsubscribeUrl}}` (must work even if tracking infra is down)
- `mailto:` links
- `tel:` links
- Anchors (`#section`)
- Links flagged in MJML with `data-mailer-notrack="true"` (e.g. legal links you don't want to track for privacy reasons)

### Click signal quality

Like opens, clicks are noisier than people assume. Some corporate email gateways and link-protection services (Microsoft Safe Links, Mimecast, Proofpoint URL Defense) pre-fetch every link to scan for malware. A "click" in your stats may have been a security bot, not a human.

Mitigation: when the User-Agent on a click clearly identifies as a bot (look for `Mimecast`, `SafeLinks`, `proofpoint`, common headless browser strings), tag the click with `isBot: true`. Stats UI surfaces both raw and human-estimated counts.

Still: per the invariants, don't branch a flow on a single click. Use accumulated signal or, better, real product events.

## Provider webhooks

The third tracking channel — events sent by the provider after the email leaves their system.

### Endpoint

```
POST /m/webhooks/:provider
```

Where `:provider` is `'sendgrid'`, `'postmark'`, etc. — matches the keys passed to `Mailer.init({ providers: {...} })`.

Handler flow:

```ts
async function handleWebhook(req, res) {
  const provider = providers[req.params.provider]
  if (!provider) return res.status(404).end()

  // 1. Verify signature
  const valid = await provider.verifyWebhook(req)
  if (!valid) return res.status(401).end()

  // 2. Parse + normalize
  const events = provider.parseWebhookEvents(req.body, req.headers as any)

  // 3. Dedupe + enqueue for async processing
  for (const evt of events) {
    await WebhookEvents.updateOne(
      { provider: provider.name, providerEventId: evt.providerEventId },
      {
        $setOnInsert: {
          ...evt,
          provider: provider.name,
          receivedAt: new Date(),
          processed: false,
          raw: req.body,
        },
      },
      { upsert: true },
    )
  }

  // Always 200 — fail-open. We don't want providers retrying because of our slowness.
  res.status(200).end()

  // 4. Async: process new events
  queue.enqueue('mailer:webhook', { provider: provider.name })
}
```

The dedupe step is critical. Providers retry webhook deliveries on 5xx responses, and some (SendGrid in particular) will deliver the same event twice. `unique(provider, providerEventId)` enforces idempotency.

### Async processing

The `mailer:webhook` worker picks up unprocessed events and applies them:

```ts
async function processWebhookEvents() {
  const events = await WebhookEvents.find({ processed: false }).limit(500)
  for (const evt of events) {
    await applyEvent(evt)
    await WebhookEvents.updateOne({ _id: evt._id }, { $set: { processed: true } })
  }
}

async function applyEvent(evt) {
  const send = await Sends.findOne({
    $or: [
      { providerMessageId: evt.providerMessageId },
      { 'metadata.sendId': evt.metadata?.sendId },   // SendGrid customArgs roundtrip
    ],
  })
  if (!send) return  // unmatched event, log

  switch (evt.normalizedType) {
    case 'delivered':
      await Sends.updateOne({ _id: send._id }, { $set: { status: 'delivered', deliveredAt: evt.occurredAt } })
      break
    case 'open':
      await Sends.updateOne({ _id: send._id }, {
        $set: { status: 'delivered', openedAt: send.openedAt ?? evt.occurredAt },
        $inc: { openCount: 1 },
      })
      break
    case 'click':
      // ... similar
      break
    case 'bounce':
      await Sends.updateOne({ _id: send._id }, {
        $set: {
          status: 'bounced',
          bounceType: evt.details.bounceType,
          bounceReason: evt.details.bounceReason,
        },
      })
      if (evt.details.bounceType === 'hard') {
        await Suppressions.upsert({ email: send.emailAtSend, scope: 'all', reason: 'hard_bounce', source: `send:${send._id}` })
        // mark host-side subscription too
        await Subscriptions.updateOne({ externalId: send.externalId }, { $set: { status: 'bounced' } })
      }
      await Health.recordBounce(evt.details.bounceType)
      break
    case 'complaint':
      // suppress, mark subscription complained, record on health
      break
    case 'unsubscribe':
      // unsubscribe contact
      break
  }
}
```

### Daily reconciliation

Webhook delivery is unreliable. Even with retries, ~1% of events are lost in normal operation. Once a day, the `mailer:tick` runs a reconciliation pass:

```ts
async function reconcileEvents() {
  for (const provider of Object.values(providers)) {
    if (!provider.fetchRecentEvents) continue   // optional capability

    const since = await getLastReconciliationCheckpoint(provider.name)
    const events = await provider.fetchRecentEvents({ since })

    for (const evt of events) {
      // Same dedupe + apply pipeline as webhook handler
      const seen = await WebhookEvents.findOne({ provider: provider.name, providerEventId: evt.providerEventId })
      if (seen) continue
      // Insert + apply
    }

    await setLastReconciliationCheckpoint(provider.name, new Date())
  }
}
```

The `fetchRecentEvents` method on providers calls their Activity / Events API. Implemented for SendGrid (Activity API). Optional for other providers.

This catches dropped webhooks without making them critical-path.

### What can't be reconciled

- **Opens** are pixel-based on our infrastructure, not via provider webhook → no reconciliation needed (we own the data path)
- **Clicks** same — our infrastructure, our data
- **Bounces/complaints/deliveries/unsubscribes** come from the provider — these are what reconciliation catches

## Mailer signal vs. provider signal

Two parallel data streams for opens and clicks:

| Source | When | Reliability |
|---|---|---|
| Provider webhook `open` event | When provider's open-tracking pixel fires | Lower (we disable provider tracking) |
| Our `/m/open/:id.png` pixel fetch | When inbox-side renders our pixel | Primary signal |

Same for clicks: provider's click tracking is disabled (`trackingSettings.clickTracking.enable: false` on SendGrid). Our `/m/click/:id/:linkId` is the source of truth.

This means our tracking infrastructure must be highly available. If it goes down for hours, opens/clicks for that window are lost — provider reconciliation won't recover them.

Mitigation: tracking endpoints are intentionally small, stateless on the request path (writes are async), and cacheable. They can be served by edge workers / CDN in production for resilience.

## Privacy and tracking

For privacy-sensitive use cases:

- Per-template `trackOpens: false` and `trackClicks: false` disable the rewriting and pixel injection
- Per-contact opt-out (admin UI or a contact-scoped preference) suppresses tracking globally for that email
- The library never reads the contact's IP from the tracking endpoint into long-term storage by default — only User-Agent and timestamp. IP can be opted into via config (`storeTrackingIp: true`) for compliance investigations.

GDPR considerations:
- Tracking pixels in marketing email require lawful basis (legitimate interest typically suffices, but consent is cleaner). Document your basis in your privacy policy.
- Right-to-erasure removes tracking events for the contact along with their other data.

## Stats rollup

The library periodically rolls per-send stats into per-template and per-flow stats (denormalized for fast dashboard queries):

```ts
mailer_templates.stats = { sent, delivered, opened, clicked, bounced, complained, unsubscribed }
mailer_flows.stats = { activeRuns, completedRuns, sendsTotal, sendsLast7Days }
```

Rollup runs every 15 minutes in the `mailer:tick` worker. Source of truth remains the raw `mailer_sends` rows; rollups are convenience.
