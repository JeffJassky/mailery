# Suppression & unsubscribe

Suppression is the do-not-send list. Every send is re-checked against it at dispatch time — INVARIANT 3.

## How email gets onto the list

| Trigger | What's added |
|---|---|
| Provider webhook reports a hard bounce | scope `all`, reason `hard_bounce` |
| Provider webhook reports a complaint / spam report | scope `all`, reason `complaint` |
| Provider webhook reports an unsubscribe | scope `marketing`, reason `unsubscribed` |
| Recipient clicks one-click unsub | scope from the token, reason `user_request` |
| You call `mailer.suppress(email, ...)` | whatever scope/reason you pass |
| You call `mailer.unsubscribe(email, { scope })` | the same scope, reason `user_request` |
| GDPR forget (`mailer.forget(externalId)`) | scope `all`, reason `gdpr_forget`, **emailHash only** (no plaintext) |

## Scope-aware checks

Suppression rows have a `scope`:

| Template | Blocked by scope |
|---|---|
| `transactional` | `all`, `transactional` |
| `marketing`, no category | `all`, `marketing` |
| `marketing`, category `C` | `all`, `marketing`, `category:C` |

A user unsubscribing from your newsletter (scope `marketing`) **still receives** their password reset (kind `transactional`). This is INVARIANT 4.

To suppress someone from absolutely everything, including transactional:

```ts
await mailer.suppress('user@example.com', {
  scope: 'all',
  reason: 'manual',
  source: 'support:they-emailed-saying-stop-everything',
})
```

Use sparingly — `scope: 'all'` blocks password resets and other security-critical messages.

## Categories and the preference page

Declare categories in [`categories`](./configuration#categories) and give a marketing template a `category`. Recipients can then stop one stream and keep the rest:

```ts
categories: [
  { id: 'lifecycle.onboarding', label: 'Getting-started tips', description: 'Help setting up your account' },
  { id: 'product.updates', label: 'Product updates' },
]
```

- **Suppression rows** gain category scopes, `category:lifecycle.onboarding`. A category row blocks only marketing mail carrying that category; every existing scope blocks exactly what it blocked before.
- **The unsubscribe token** carries the template's category. The one-click button in Gmail (RFC 8058) opts the recipient out of that category only, which is what the click meant. Tokens minted before categories existed carry none and still mean all marketing until they expire. The token's signed scope stays `marketing`, so rolling back to an older mailery opts the recipient out of all marketing, the safe direction.
- **The preference page.** With categories declared, `GET /m/unsub/:token` renders one checkbox per category showing the current state, a Save button, and a separate "Unsubscribe from all marketing email" button. Saving writes or deletes category rows with `source: 'preferences'` and never touches a marketing-wide opt-out. When the address is unsubscribed from all marketing, the page says so, shows the topics unticked, and offers a **Resubscribe to the topics below** button instead; only that explicit action clears the `marketing`/`all` opt-out, so pressing Save can never silently undo an unsubscribe. Transactional mail is never mentioned: it is outside preferences. Without categories the page is the plain confirmation page.
- **Pausing.** The preference page also offers a "Take a break" section, one button per length in `MailerConfig.preferences.pauseDays` (default `[7, 14, 30]`; `[]` hides it). A pause is a `marketing_pause` suppression row (reason `paused`) with an `expiresAt`, so every marketing path honours it, categorised or not, and it lifts itself when it expires. Transactional mail is never paused. A pause is not an unsubscribe: the address stays opted in (`getPreferences().marketing` is still true, `pausedUntil` reports the end), it is never journaled, and a pause that cannot be written answers 503 with `Retry-After: 60` rather than a 200. While paused the page shows "Paused until `<date>`" and a **Resume now** button. Pausing again replaces the row. Use `mailer.pauseMarketing` / `mailer.resumeMarketing` from a host settings screen. Flow and broadcast sends that reach dispatch during a pause are skipped, not deferred; a Program with no other recipient wakes when the pause ends if that is sooner than its `minGapDays`.
- **`List-ID`.** Categorised marketing mail carries `List-ID: <category.sender-domain>` so clients can group it. Uncategorised mail and transactional mail carry no `List-ID`.
- **A category opt-out never changes the subscription status.** The recipient is still subscribed to the rest of marketing.
- **Opt-outs are never refused.** A token whose category has since been removed from config, and `mailer.unsubscribe(email, { scope: 'category:old.id' })`, still record the opt-out.
- **Publish rules.** A template's `category` must be declared in config, and a transactional template cannot have one. The admin API, the agent API and the editor all reject a violation with 400.

Read and write a recipient's choices from your own settings screen:

```ts
await mailer.getPreferences('user@example.com')
// → { marketing: true, categories: { 'lifecycle.onboarding': true, 'product.updates': false } }

await mailer.setPreferences('user@example.com', { categories: { 'product.updates': true } }, { source: 'settings' })
```

`marketing: false` writes a `marketing` opt-out and ignores `categories`; `marketing: true` clears `marketing` and `all` opt-outs the recipient wrote. Turning something on deletes only `reason: 'unsubscribed'` rows, never a bounce, complaint, manual or GDPR row. An undeclared category id throws before anything is written. Each call is audit-logged as `contact.preferences`.

## Programmatic unsubscribe

```ts
await mailer.unsubscribe('user@example.com', {
  scope: 'marketing',
  reason: 'manual',
  source: 'support:ticket-1234',
})
```

`scope` also accepts `category:<id>`. Same path as the public `/m/unsub/:token` endpoint. Idempotent — calling repeatedly is safe.

## Opting back in

An unsubscribe writes two things: the subscription status and a suppression row. `upsertSubscription` only reverses the first, and the suppression check runs at enqueue time regardless of status — so a contact who opts back in through `upsertSubscription` reads as subscribed while every send is suppressed. Use `resubscribe` for an explicit opt-in:

```ts
const { removedSuppressions } = await mailer.resubscribe({
  externalId: user.id,
  source: 'preferences:opt-in',
  consentIp: req.ip,
})
```

It deletes only `reason: 'unsubscribed'` rows (a bounce or complaint is not the contact's to reverse) and then upserts the subscription, double opt-in included. Keep it behind a real click: a migration that re-subscribes every account should keep calling `upsertSubscription`, which cannot resurrect an opted-out address.

## The one-click unsubscribe endpoint

Every marketing email includes both headers:

```
List-Unsubscribe: <https://yourdomain.com/m/unsub/abc123...>, <mailto:unsub@yourdomain.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Gmail and modern clients show a one-click button in the inbox UI. Clicking POSTs to the URL. mailery:

1. Verifies the HMAC token (signed with `unsubscribeSecret`).
2. Writes the suppression (scope `category:<id>` for categorised mail, else the token's scope) and, for non-category scopes, updates the subscription, waiting up to `unsubscribeWriteTimeoutMs` (default 5s).
3. Returns 200 — INVARIANT 8: **never a 200 for an unsubscribe that was not durably recorded.**
4. If that write fails or times out, appends the opt-out to [`pendingUnsubsPath`](./configuration#pendingunsubspath-the-unsubscribe-journal) and still returns 200; the tick drain replays it when Mongo is back.
5. If there is nowhere to journal it either, returns **503** rather than confirm an unsubscribe it did not record.

A GET to the same URL renders a confirmation page (or, with categories declared, the preference page) so browser visits show a friendly page.

## GDPR forget

```ts
// In your delete-user route:
await users.deleteOne({ _id })
await mailer.forget(_id.toString())
```

This hard-deletes all PII for the contact across `mailer_subscriptions`, `mailer_events`, `mailer_flow_runs`, `mailer_sends`, `mailer_contact_tags`, `mailer_leads`.

Then it inserts a `mailer_suppressions` row with `email: null` and just the `emailHash`. Future sends to that email get blocked at the hash level — INVARIANT 9. The plaintext email is gone forever, but anyone who somehow re-imports the same email through a side channel will hit the suppression and bounce.

## Data export

```ts
const data = await mailer.exportContactData(externalId)
```

Returns a JSON-serializable object with the contact's subscription, events, flow runs, sends, suppressions, and tags. Pipe this into your host's GDPR export.

## Removing from the suppression list

Admin UI: `/admin/mailer/suppressions`, find the row, click delete. Or:

```ts
await db.collection('mailer_suppressions').deleteOne({ email, scope })
```

The admin UI version is audit-logged automatically; direct deletes should be paired with a `mailer.audit()` call.

Removing a `gdpr_forget` entry is allowed but strongly discouraged — by design, the email is no longer in your possession.
