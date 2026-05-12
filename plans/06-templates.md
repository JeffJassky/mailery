# 06 — Templates

Templates are MJML-source emails with a Handlebars rendering pass for variables. Stored in `mailer_templates`, edited via `draft`, promoted to live on publish.

## Why MJML

MJML compiles to bulletproof email HTML that works across Outlook, Gmail, Apple Mail, Yahoo, Thunderbird, mobile clients. Writing raw HTML for email in 2026 is a waste — too many client-specific quirks to keep up with by hand.

MJML is also legible. A developer can read an MJML document and reason about layout. The compiled HTML is unreadable; the MJML is not.

## Rendering pipeline

```
Author writes MJML source (via WYSIWYG or source mode)
  │
  ▼
draft.mjml stored in mailer_templates.draft
  │
  ▼
[publish] ───────────────────────────────┐
  │                                       │
  ▼                                       │
mjml(source) → html string                │
text-from-html(html) → plain text         │
  │                                       │
  ▼                                       │
body.mjml = source                        │
body.html = compiled                      │
body.plainText = derived                  │
body.compiledAt = now                     │
publishedAt = now                         │
draft = null                              │
  │                                       │
  ▼                                       │
[send-time, per send] ───────────────────┘
  │
  ▼
Handlebars render with contact + variables context → html + text
  │
  ▼
Tracking pass:
  - Rewrite all <a href="X"> → /m/click/<sendId>/<linkId>  (302 to X)
  - Append open pixel <img src="/m/open/<sendId>.png" width="1" height="1">
  - Inject List-Unsubscribe footer if not present
  │
  ▼
Provider .send()
```

## Variable substitution

Handlebars is the templating layer on top of MJML. Variables in subject, preheader, and body are interpolated at send time.

```mjml
<mj-section>
  <mj-column>
    <mj-text>
      Hey {{contact.fields.firstName}}, your supporter rate expires in
      {{daysRemaining}} days.
    </mj-text>
    <mj-button href="https://storyfolder.com/deal?email={{contact.email}}">
      Lock in 20% off
    </mj-button>
  </mj-column>
</mj-section>
```

Two namespaces in the Handlebars context:

| Namespace | Source | Examples |
|---|---|---|
| `contact.*` | `Contact` object from adapter | `contact.email`, `contact.fields.firstName`, `contact.timezone` |
| `vars.*` | Resolved against `template.variablesSchema` | `vars.daysRemaining`, `vars.deepLinkUrl` |

`vars` come from:
1. Flow step config (e.g. `{ type: 'send', templateSlug: '...', vars: { daysRemaining: 3 } }`)
2. Broadcast definition
3. Template defaults (`variablesSchema.<name>.defaultValue`)

Missing required variables — template render fails, the send is marked failed in `mailer_sends`, flow advances past it.

## Built-in helpers

Handlebars helpers shipped by the library:

| Helper | Use | Example |
|---|---|---|
| `unsubscribeUrl` | One-click unsub link for this send | `<mj-text><a href="{{unsubscribeUrl}}">Unsubscribe</a></mj-text>` |
| `preferenceCenterUrl` | Per-list / per-contact preferences | `{{preferenceCenterUrl}}` |
| `viewInBrowserUrl` | Render the email in a public browser view | `{{viewInBrowserUrl}}` |
| `formatDate` | Locale-aware date | `{{formatDate vars.expiresAt 'long'}}` → "May 15, 2026" |
| `pluralize` | English-only pluralization | `{{pluralize vars.count 'shot' 'shots'}}` |
| `formatCurrency` | Currency format | `{{formatCurrency vars.amountCents 'usd'}}` |
| `formatNumber` | Number with separators | `{{formatNumber vars.shotCount}}` |
| `eq, ne, gt, lt, and, or, not` | Standard comparison helpers | `{{#if (gt vars.daysRemaining 3)}}...{{/if}}` |

Custom helpers can be registered in config:

```ts
new Mailer({
  // ...
  handlebarsHelpers: {
    truncate: (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s,
  },
})
```

## Plain-text derivation

After MJML compiles to HTML, the library derives a plain-text version:

1. Strip tags, preserve list structure as `- item`
2. Preserve link URLs as `Text (https://...)`
3. Preserve heading hierarchy as `## Heading`
4. Drop images
5. Collapse excessive whitespace

The result is stored as `template.body.plainText` and sent as the `text/plain` alternative on every send. Always sent — many spam filters check that both alternatives exist.

If the auto-derivation produces something bad, templates can override:

```ts
{
  body: {
    mjml: "<mjml>...</mjml>",
    html: "...",
    plainText: "Custom plain text here.",       // overrides auto-derivation
    plainTextSource: 'manual',                  // 'derived' | 'manual'
  }
}
```

## The transactional/marketing distinction

`template.kind` must be either `'transactional'` or `'marketing'`. This affects:

| Aspect | Transactional | Marketing |
|---|---|---|
| Default sender | `transactional@yourdomain.com` | `hello@yourdomain.com` |
| Default provider | Postmark recommended | SendGrid recommended |
| Suppression scope | Respects `all` + `transactional` | Respects `all` + `marketing` |
| Circuit breaker | Bypasses (sends even when tripped) | Held while tripped |
| Subscription status check | Skipped (user MAY be unsubscribed) | Required (must be `subscribed`) |
| Open/click tracking | Off by default | On by default |
| Mandatory unsubscribe link | No | Yes (legally required) |

Transactional templates that violate the "user took an explicit action" rule (e.g. someone sends a "newsletter" as transactional to bypass unsubscribe) are an abuse of the system. The library doesn't enforce — it trusts authors — but the audit log makes the distinction visible.

## Template authoring conventions

For maximum compatibility and clean MJML:

1. **Body width: 600px.** MJML's default `mj-section` is fine.
2. **Fonts: system stacks.** `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"`. Custom fonts don't reliably load in email.
3. **Buttons: `<mj-button>` not custom HTML.** MJML's button output handles all client quirks.
4. **Images: hosted on a CDN with `width`/`height` attributes and `alt` text.** Many clients block images by default; alt text is your fallback.
5. **No JavaScript, no forms, no iframes, no video tags.** They don't work and they trigger spam filters.
6. **Mobile-first.** Use `<mj-class>` and the responsive grid; assume 50%+ of opens are mobile.
7. **Test in Litmus, Email on Acid, or send to a few real inboxes.** The library provides `template.sendTest(toEmail, sampleData)` for this.

## Send-test flow

```ts
await mailer.templates.sendTest({
  templateSlug: 'activation-rescue-day-1',
  to: 'qa@yourdomain.com',
  sampleData: {
    contact: { email: 'qa@yourdomain.com', fields: { firstName: 'QA' }, tags: [] },
    vars: { daysRemaining: 3 },
  },
})
```

Test sends:
- Bypass suppression (the test recipient gets it regardless)
- Bypass subscription status
- Bypass circuit breaker
- Include a `[TEST]` prefix on the subject
- Don't log to `mailer_sends` stats (so they don't pollute analytics)
- Don't fire opens/clicks toward template stats

This is for development and content review, not for verifying production deliverability. For that, send to a real test address through a real flow.

## Preview rendering

Admin UI offers a live preview of a template:

```ts
await mailer.templates.preview({
  templateSlug: 'activation-rescue-day-1',
  sampleData: { /* ... */ },
})
// Returns: { html: string, plainText: string, subject: string, preheader: string }
```

The htmx-driven preview pane refreshes the iframe with this rendered HTML as the operator edits the draft MJML. No round-trip needed for visual feedback during authoring.

## WYSIWYG editor

MJML source is the persisted format, but most operators don't want to write MJML by hand. The admin UI ships a WYSIWYG editor that produces MJML on save.

### Choice: Maily

V1 integrates [**Maily**](https://github.com/arikchakma/maily) (MIT, Tiptap-based, MJML-compatible). Reasons:

- Outputs JSON internally and MJML on export — clean round-trip with our storage format.
- Tiptap is a Node-friendly framework; integrates without a heavy build step in the host app (we bundle the editor's static assets the same way as `htmx`/`alpine`).
- Active OSS project, MIT license — safe to embed.
- Supports the email primitives we need (sections, columns, buttons, images, text styles, merge tags).

Fallbacks if Maily turns out unsuitable in practice: [GrapesJS](https://grapesjs.com) with the MJML preset, or [EasyEmail](https://github.com/zalify/easy-email). Both are heavier integrations.

### Behavior

- Editor opens with the current `draft.mjml` (or the published `body.mjml` if no draft).
- On save, the editor exports MJML and writes to `draft.mjml`. The library does not store the editor's internal JSON — MJML is the single source of truth.
- Source mode toggle: a tab lets MJML-fluent authors edit MJML directly. The editor reloads from the MJML on switch back.
- Merge tag insertion: a "{{ }}" menu in the editor lists the template's `variablesSchema` plus standard helpers (`unsubscribeUrl`, `preferenceCenterUrl`, `viewInBrowserUrl`, `senderAddress`, contact fields exposed by the adapter).
- Live preview: the right pane shows the compiled HTML, refreshed on each save via the same htmx pipeline as the source-mode preview (`09-admin-ui.md`).

### What stays out of WYSIWYG

- Custom MJML components (`mj-include`, conditional `mj-section`s) — author in source mode.
- Handlebars block helpers (`{{#if}}...{{/if}}`) — author in source mode; preview renders them.
- Raw HTML escape hatches — discouraged in email; supported via source mode only.

The WYSIWYG covers the 80% case (founder voice, marketing campaign, monthly newsletter). Power authors drop to source mode for the rest.

## Versioning and rollback

Each template publish snapshots into `mailer_template_versions`:

```ts
mailer_template_versions {
  templateId, version, mjml, html, plainText, subject, preheader, publishedAt, publishedBy
}
```

Rollback: copy a prior version's content into `draft`, then re-publish. The library exposes `mailer.templates.rollback(slug, toVersion)` for this.

In-flight flow_runs that reference a template always render with the *current* published version (not pinned, unlike flow versions). This is deliberate: emails are content, and content fixes (typo corrections, link updates) should propagate immediately. If you need pinned content, fork the template (`slug-v2`) and reference the new slug.

## Anatomy of a complete template

Here's what a real activation-rescue template looks like in storage:

```js
{
  slug: 'activation-rescue-day-1',
  name: 'Activation Rescue — Day 1',
  description: 'Sent 24h after Downloaded if not yet Activated',
  kind: 'marketing',
  fromName: 'Jeff Jassky',
  fromEmail: 'jeff@jeffjassky.com',
  replyTo: 'jeff@jeffjassky.com',
  subject: "Need a hand getting StoryFolder running?",
  preheader: "30-second walkthrough of the Connect Your Account step.",
  body: {
    mjml: `<mjml>
      <mj-head>...</mj-head>
      <mj-body>
        <mj-section>
          <mj-column>
            <mj-text>Hi {{contact.fields.firstName}},</mj-text>
            <mj-text>I noticed you downloaded StoryFolder yesterday but haven't connected your account yet...</mj-text>
            <mj-button href="https://storyfolder.com/help/getting-started/connect-account">
              Open the walkthrough
            </mj-button>
            <mj-text>
              — Jeff<br/>
              <a href="{{unsubscribeUrl}}">Unsubscribe</a>
            </mj-text>
          </mj-column>
        </mj-section>
      </mj-body>
    </mjml>`,
    html: '<!-- compiled MJML output, ~10KB -->',
    plainText: 'Hi {{contact.fields.firstName}},\n\nI noticed...\n\n— Jeff',
    compiledAt: new Date(),
  },
  variablesSchema: {},  // no custom vars for this template
  trackOpens: true,
  trackClicks: true,
  tags: ['activation', 'founder-voice'],
  publishedAt: new Date(),
  publishedBy: 'script:operator',
  // stats omitted
}
```
