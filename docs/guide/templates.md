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

### Hand-written HTML

A template can also arrive as compiled HTML rather than MJML — written by a deploy script as above, or pushed through the agent API's `PUT /templates/:slug`. Either way `body.html` is set directly and there's no MJML or Design-editor document behind it.

Such a template is edited in the admin UI's **HTML** tab: a Monaco source editor over `body.html`, with syntax highlighting, folding and find/replace. Saving stages the content as `draft.html`, and publishing stores it verbatim — `body.html` unchanged, `body.mjml` `''`, `body.editorJson` `null` — with plain text derived from it unless you override it.

The HTML tab is editable only when raw HTML is the template's actual source of truth. For a template authored in Design or MJML, the tab still renders the compiled `body.html` so you can see what will send, but it's read-only, with a note pointing at the real source tab: hand-edits to compiler output would simply be discarded the next time that template is published from its MJML or Design document.

The editor's **Preview** tab renders the message beside those source tabs, against a sample contact with variables resolved, and re-renders as you type. It previews what you have on screen rather than what was last saved — the body source travels with the request, so looking at your work never writes a draft.

This does not convert an HTML-only template into MJML or into the Design editor's format, and it does not resolve how a deploy-script pipeline and admin-UI editing should coexist long-term for the same template. It solves a narrower problem — making HTML-only templates viewable and editable in the UI at all.

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

For an HTML-authored template (see [Hand-written HTML](#hand-written-html)), the effective source is raw markup rather than compiled MJML, so a markup check runs alongside the checks above:

| Rule | Severity | Catches |
|---|---|---|
| `html_empty` | error | The source is empty |
| `html_unclosed_comment` | error | A `<!--` with no matching `-->` |
| `html_unbalanced_tags` | error | An unclosed tag, a stray closing tag, or a mismatched pair |
| `html_script_tag` | warning | A `<script>` tag — every client strips it, and it raises spam scores |
| `html_missing_body` | warning | No `<html>`/`<body>` wrapper |

HTML's implicit end tags are honoured, so the table markup email leans on — a row of `<td>` cells with no `</td>`, a `<p>` closed only by the next one — is not reported as unbalanced.

The full content linter above — bare URLs, off-domain links, unknown variables, the unsubscribe tag, and the rest — runs against the rendered HTML regardless of source, so the HTML tab gets the same content rules as Design and MJML.

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

## Plain-text-only templates

By default every send is multipart: HTML plus a plain-text alternative. Set
`bodyFormat: 'text_only'` to send the plain-text part alone — no HTML part at
all — for mail that should read as if a person typed it:

```ts
{
  bodyFormat: 'text_only',   // default: 'multipart'
}
```

Also settable in the editor under **Body format**.

The trade is deliberate and total: a `text_only` send records **no opens and no
clicks**. The open pixel needs an HTML part to live in, and click rewriting is
skipped on purpose — swapping readable URLs for opaque `/m/click/...` redirects
in text a recipient reads literally would undo the reason to choose this
format. Engagement-driven features (open-based sunsetting, click predicates)
see nothing from these sends; use `multipart` where that data matters.

Test sends and Mail-Tester checks match the real wire shape, so what you check
is what recipients get.

## Tracking per template

```ts
{
  trackOpens: true,    // default; per-template override
  trackClicks: true,
}
```

For transactional receipts you usually want both `false` — no need to track opens on a password reset.

Note `bodyFormat: 'text_only'` overrides both: with no HTML part there is
nowhere for the pixel or rewritten links to go, so such sends track nothing
regardless of these flags.
