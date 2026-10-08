# Upgrading to 0.21

0.21 is additive: no forced data migration. Two CLI commands help you check and finish the upgrade. Both read `MAILER_MONGODB_URI` (required) and `MAILER_MONGODB_DB` (optional, defaults to the database in the URI).

## `mailery doctor`

```sh
npx mailery doctor [--categories a,b] [--prefix p_] [--json]
```

Read-only. Exits 1 only on problems that would make an enabled Program fail to tick.

- `--categories a,b` compares the categories your templates use with the set you declare in `MailerConfig.categories`. The CLI cannot read host code, so you pass them. A bare `--categories` with no value is ignored (the report says so) rather than treating every category as undeclared.
- `--prefix` is the collection prefix when you changed it from the default `mailer_`.
- `--json` prints the report as JSON.

`doctor` reads the database only. `contactPolicy`, `factsAdapter` and `categories` live in your host config and cannot be checked from here; the report says so. Verify them in code.

It reports marketing templates with no category, unknown suppression scopes, expired Program run leases, missing 0.21 indexes (a warning until you use Programs), and structural problems in enabled Programs (including templates a Program uses that are not published). The stale-lease message names the threshold in use.

## `mailery backfill-categories`

```sh
npx mailery backfill-categories --map welcome-1=lifecycle.onboarding,tips=product.updates [--dry-run] [--overwrite] [--prefix p_]
```

Sets `category` on existing marketing templates. Run with `--dry-run` first. Templates that already have a category are left alone unless you pass `--overwrite`. Each change is written to the audit log. Afterwards run `doctor --categories ...` to confirm.

Giving a template a category changes its unsubscribe link from "all marketing" to "this category".

## Pre-build indexes on large hosts

`Mailer.init` builds the 0.21 indexes on `mailer_sends` in the background (it does not wait for them, and logs once if a build fails), so a large collection no longer delays startup. Until they exist, contact-policy history lookups and deferred-send release are slow. To build them before you deploy, run in `mongosh` (prefix `mailer_` shown; use yours):

```js
db.mailer_sends.createIndex({ emailAtSend: 1, kind: 1, sentAt: -1 })
db.mailer_sends.createIndex({ status: 1, notBefore: 1 }, { partialFilterExpression: { status: 'deferred' } })
db.mailer_sends.createIndex({ 'program.runId': 1 }, { partialFilterExpression: { 'program.runId': { $exists: true } } })
db.mailer_sends.createIndex(
  { 'program.slug': 1, 'program.holdout': 1, 'program.actionId': 1, status: 1 },
  { partialFilterExpression: { 'program.slug': { $exists: true } } },
)
```

`mailery doctor` lists any of these that are missing, with the collection's estimated document count and the command. A missing index is a warning, or a failure when a Program is enabled and a Program index is missing.

### Data shape — new statuses

- `SendStatus` gains `deferred` (the contact policy held the send; `notBefore` and `policyDeferral` say until when) and `holdout` (a Program send to a holdout subject: logged like any send, no provider call).
- `SendDoc.exitReason` (set with `status: 'cancelled'`) gains `policy_expired`, `satisfied_before_send`, `ineligible_before_send` and `run_inactive`. Code that switches on `status` or `exitReason` must tolerate the new values.

## Rolling back to 0.20

0.21 changes no existing data, but 0.20 does not know the new rows. Before you roll back:

1. **Disable Programs.** Disable each in the admin, or `mailer.setProgramEnabled(slug, false)`. 0.20 does not run them.
2. **Handle `deferred` sends.** 0.20 never releases them. Cancel them:
   ```js
   db.mailer_sends.updateMany({ status: 'deferred' }, { $set: { status: 'cancelled', exitReason: 'policy_expired', updatedAt: new Date() } })
   ```
   or re-queue them, and 0.20's stranded-send sweep dispatches them:
   ```js
   db.mailer_sends.updateMany({ status: 'deferred' }, { $set: { status: 'queued', updatedAt: new Date() }, $unset: { policyDeferral: '' } })
   ```
3. **Cancel queued Program sends.** 0.20 would send them without the dispatch-time re-check (satisfied, ineligible, run exited):
   ```js
   db.mailer_sends.updateMany({ 'program.runId': { $exists: true }, status: 'queued' }, { $set: { status: 'cancelled', exitReason: 'run_inactive', updatedAt: new Date() } })
   ```
   `holdout` rows are inert and can stay.
4. **Category opt-outs.** 0.20 ignores `category:*` suppressions, so a person who opted out of one category would be mailed again. Don't roll back once categorised templates have sent, or first convert those opt-outs to marketing opt-outs:
   ```js
   db.mailer_suppressions.find({ scope: /^category:/ }).forEach((s) => {
     db.mailer_suppressions.updateOne(
       { email: s.email, scope: 'marketing' },
       { $setOnInsert: { email: s.email, emailHash: s.emailHash, scope: 'marketing', reason: s.reason, source: 'rollback:' + s.scope, notes: s.notes ?? null, addedAt: new Date(), expiresAt: null } },
       { upsert: true },
     )
   })
   ```
   This opts those people out of all marketing, which is the safe direction.
