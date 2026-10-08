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

It reports marketing templates with no category, unknown suppression scopes, expired Program run leases, missing 0.21 indexes (a warning until you use Programs), and structural problems in enabled Programs.

## `mailery backfill-categories`

```sh
npx mailery backfill-categories --map welcome-1=lifecycle.onboarding,tips=product.updates [--dry-run] [--overwrite] [--prefix p_]
```

Sets `category` on existing marketing templates. Run with `--dry-run` first. Templates that already have a category are left alone unless you pass `--overwrite`. Each change is written to the audit log. Afterwards run `doctor --categories ...` to confirm.

Giving a template a category changes its unsubscribe link from "all marketing" to "this category".
