# Templates

Templates are MJML-source emails with a Handlebars rendering pass for variables. Stored in `mailer_templates`, edited via `draft`, promoted to live on publish.

## Why MJML?

MJML compiles to HTML that renders consistently across Outlook, Gmail, Apple Mail, Yahoo, mobile clients. Writing raw email HTML in 2026 is a waste — you spend more time fighting Outlook quirks than designing.

MJML is also legible. A developer can read MJML and reason about layout; the compiled HTML is unreadable.

## Authoring

### From the admin UI

Visit `/admin/mailer/templates`, click "New template". Three tabs:

- **Design** — Maily WYSIWYG editor. Drag blocks, edit inline, insert merge tags from the `{{ }}` menu. Outputs MJML on save.
- **MJML** — raw MJML source with syntax highlighting. For power authors and Handlebars-heavy templates.
- **Plain text** — auto-derived from compiled HTML; override here if the auto-derivation produces something awkward.

When you publish, mailery compiles MJML → HTML, derives plain text, snapshots into `mailer_template_versions`, and serves the new version to all flow runs that reference this slug.

### From a deploy script

```ts
import { compileTemplate } from 'mailery'

const mjml = `<mjml>...</mjml>`
const compiled = await compileTemplate(mjml)

await db.collection('mailer_templates').updateOne(
  { slug: 'welcome-1' },
  {
    $set: {
      name: 'Welcome · day 0',
      kind: 'marketing',
      subject: 'Welcome, {{contact.fields.firstName}}',
      preheader: 'Three things to try in your first 5 minutes.',
      body: { mjml, html: compiled.html, plainText: compiled.plainText, compiledAt: new Date() },
      // ...fromName, fromEmail, replyTo, trackOpens, trackClicks, tags
      publishedAt: new Date(),
      publishedBy: 'script:deploy',
    },
  },
  { upsert: true },
)
```

## Variables

Handlebars syntax. Two namespaces:

| Namespace | Source | Examples |
|---|---|---|
| `contact.*` | The `Contact` object from your adapter | `contact.email`, `contact.fields.firstName`, `contact.timezone` |
| `vars.*` | Per-send vars passed via flow step config, broadcast definition, or `sendOneOff` args | `vars.daysRemaining`, `vars.resetUrl` |

```mjml
<mj-section>
  <mj-column>
    <mj-text>Hi {{contact.fields.firstName}},</mj-text>
    <mj-text>Your supporter rate expires in {{vars.daysRemaining}} days.</mj-text>
    <mj-button href="{{vars.deepLinkUrl}}">Lock in 20% off</mj-button>
  </mj-column>
</mj-section>
```

### Built-in helpers

| Helper | Use | Example |
|---|---|---|
| `unsubscribeUrl` | One-click unsub link for this send | `<a href="{{unsubscribeUrl}}">Unsubscribe</a>` |
| `preferenceCenterUrl` | Per-contact preferences (when implemented) | `{{preferenceCenterUrl}}` |
| `senderAddress` | The CAN-SPAM postal address from config | `{{senderAddress}}` |
| `formatDate` | Locale-aware date | `{{formatDate vars.expiresAt 'long'}}` → "May 15, 2026" |
| `pluralize` | English-only pluralization | `{{pluralize vars.count 'shot' 'shots'}}` |
| `formatCurrency` | Currency from cents | `{{formatCurrency vars.amountCents 'usd'}}` |
| `formatNumber` | Comma-separated | `{{formatNumber vars.shotCount}}` |
| `eq`, `ne`, `gt`, `lt`, `and`, `or`, `not` | Comparison | `{{#if (gt vars.daysRemaining 3)}}...{{/if}}` |

### Custom helpers

Register at init:

```ts
await Mailer.init({
  // ...
  handlebarsHelpers: {
    truncate: (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s),
  },
})
```

## Transactional vs marketing

Every template has a `kind`:

| Aspect | `transactional` | `marketing` |
|---|---|---|
| Default sender | `transactionalFromDefaults` | `fromDefaults` |
| Suppression scope | `all` + `transactional` | `all` + `marketing` |
| Circuit breaker | bypass (sends even when tripped) | held while tripped |
| Subscription check at trigger time | skipped (user MAY be unsubscribed) | required |
| Mandatory unsubscribe link | no | yes (CAN-SPAM) |
| Default tracking | off | on |

Pick the kind based on whether the recipient took an explicit action that warrants the email. A monthly newsletter is `marketing` even if it goes only to opted-in users. A password reset is `transactional`.

## Lint

When you publish a template, mailery runs lint checks:

- **Unsubscribe link present** (marketing only) — fails if `{{unsubscribeUrl}}` isn't referenced.
- **Sender address present** (marketing only) — fails if the configured postal address isn't found.
- **No broken merge tags** — Handlebars compile must succeed.
- **Open tracking warning** — if `trackOpens` is on, flag it (Apple MPP inflates opens).

## Plain text

Auto-derived from compiled HTML on publish. To override:

```ts
{
  body: {
    mjml: '<mjml>...</mjml>',
    html: '...',
    plainText: 'Custom plain text content.',
    compiledAt: new Date(),
  }
}
```

## Tracking per template

```ts
{
  trackOpens: true,    // default; per-template override
  trackClicks: true,
}
```

For transactional receipts you usually want both `false` — no need to track opens on a password reset.
