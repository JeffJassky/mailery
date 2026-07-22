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

Handlebars syntax. Three sources:

| Namespace | Source | Examples |
|---|---|---|
| `contact.*` | The `Contact` object from your adapter | `contact.email`, `contact.fields.firstName`, `contact.timezone` |
| `vars.*` | Per-send vars passed via flow step config, broadcast definition, or `sendOneOff` args | `vars.daysRemaining`, `vars.resetUrl` |
| `event.*` | Properties of the event that triggered the flow run (empty outside flow sends) | `event.accountId`, `event.topicId` |
| *(root)* | Host variables resolved by your [`varsAdapter`](#host-variables-varsadapter) at send time | `user.name`, `account.plan.name`, `firstActiveTopic.title` |

```mjml
<mj-section>
  <mj-column>
    <mj-text>Hi {{contact.fields.firstName}},</mj-text>
    <mj-text>Your supporter rate expires in {{vars.daysRemaining}} days.</mj-text>
    <mj-button href="{{vars.deepLinkUrl}}">Lock in 20% off</mj-button>
  </mj-column>
</mj-section>
```

### Host variables (varsAdapter)

Static `vars` cover per-send values, but most product data lives in your own
database — the user's name, their plan, the first topic they created. Declare
those once with `defineVars` and every template can use them:

```ts
import { defineVars, Mailer } from 'mailery'
import { z } from 'zod'

const varsAdapter = defineVars({
  schema: z.object({
    user: z.object({ name: z.string(), email: z.string() }),
    account: z.object({
      name: z.string(),
      plan: z.object({ name: z.string(), interval: z.enum(['monthly', 'annual']) }),
    }),
    firstActiveTopic: z.object({ title: z.string(), url: z.string() }).nullable(),
  }),
  async resolve(contact, info) {
    // info.reason is 'send' | 'preview' | 'test' — keep this side-effect free.
    const user = await users.findOne({ _id: new ObjectId(contact.externalId) })
    const account = await accounts.findOne({ _id: user.accountId })
    const topic = await topics.find({ accountId: account._id, active: true }).sort({ createdAt: 1 }).limit(1).next()
    return {
      user: { name: user.name, email: user.email },
      account: { name: account.name, plan: { name: account.plan, interval: account.interval } },
      firstActiveTopic: topic ? { title: topic.title, url: `https://app.example.com/t/${topic._id}` } : null,
    }
  },
})

await Mailer.init({ /* ... */, varsAdapter })
```

Templates then reference the schema's root keys directly:

```mjml
<mj-text>Hi {{user.name}} — your {{account.plan.interval}} plan is active.</mj-text>
{{#if firstActiveTopic}}<mj-button href="{{firstActiveTopic.url}}">{{firstActiveTopic.title}}</mj-button>{{/if}}
```

How it behaves:

- **Resolved at dispatch time**, per send, with the contact as it exists at that
  moment. A `resolve` throw marks the send `failed` and lets the queue retry —
  a half-rendered email never goes out.
- **The schema is the contract.** The admin editor fetches it (as JSON Schema
  via `GET /api/vars-schema`) to power `{{` autocomplete in subject/preheader
  and the Variables sidebar card; the linter flags `{{paths}}` that don't
  exist in it (`unknown_variable` warning).
- **Previews and test sends run the resolver too** — previewing as a real
  contact shows exactly what that person would receive, and you can cycle
  contacts with ←/→ in the preview modal.
- **Trigger-event scope:** for flow sends, `info.eventName` /
  `info.eventProperties` carry the triggering event — use them to load the
  right account/topic when a user belongs to several. See
  [Flows → Event parameters](./flows#event-parameters-scoped-flows).
- **Reserved keys** (`contact`, `vars`, `event`, `unsubscribeUrl`,
  `viewInBrowserUrl`, `preferenceCenterUrl`, `senderAddress`) can't be
  declared in the schema — `Mailer.init` throws.
- Return type is checked against `z.infer<typeof schema>` — typos in `resolve`
  fail at compile time.

### Built-in variables

Render-context values, not helpers — reference them directly. They're reserved
keys, so a `varsAdapter` schema can't declare them.

| Variable | Use | Example |
|---|---|---|
| `unsubscribeUrl` | One-click unsub link for this send | `<a href="{{unsubscribeUrl}}">Unsubscribe</a>` |
| `preferenceCenterUrl` | Per-contact preferences (when implemented) | `{{preferenceCenterUrl}}` |
| `senderAddress` | The CAN-SPAM postal address from config | `{{senderAddress}}` |

### Built-in helpers

| Helper | Use | Example |
|---|---|---|
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
