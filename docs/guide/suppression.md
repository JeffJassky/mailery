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

| Template kind | Blocked by scope |
|---|---|
| `marketing` | `all` or `marketing` |
| `transactional` | `all` or `transactional` |

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

## Programmatic unsubscribe

```ts
await mailer.unsubscribe('user@example.com', {
  scope: 'marketing',
  reason: 'manual',
  source: 'support:ticket-1234',
})
```

Same path as the public `/m/unsub/:token` endpoint. Idempotent — calling repeatedly is safe.

## The one-click unsubscribe endpoint

Every marketing email includes both headers:

```
List-Unsubscribe: <https://yourdomain.com/m/unsub/abc123...>, <mailto:unsub@yourdomain.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Gmail and modern clients show a one-click button in the inbox UI. Clicking POSTs to the URL. mailery:

1. Verifies the HMAC token (signed with `unsubscribeSecret`).
2. Returns 200 immediately — INVARIANT 8.
3. Writes the suppression + updates the subscription asynchronously.
4. Falls back to disk (`/tmp/mailery-pending-unsubs.jsonl`) if Mongo is degraded.

A GET to the same URL renders a confirmation page so browser visits show a friendly "click to unsubscribe" page.

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
