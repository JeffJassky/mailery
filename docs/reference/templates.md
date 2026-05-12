# Template utilities

Lower-level template functions exposed for hosts that want to render or compile MJML outside the main runner.

```ts
import { compileTemplate, renderTemplate, derivePlaintext, applyTracking } from 'mailery'
```

## compileTemplate(mjml)

```ts
async function compileTemplate(mjml: string): Promise<{
  html: string
  plainText: string
  errors: Array<{ line?: number; message: string; tagName?: string }>
}>
```

Compiles MJML → HTML, derives plain text from the HTML. Called at template publish time.

```ts
const { html, plainText, errors } = await compileTemplate(`<mjml>...</mjml>`)
if (errors.length > 0) console.warn('MJML lint warnings', errors)
```

## renderTemplate(template, ctx, opts?)

```ts
async function renderTemplate(
  template: TemplateDoc,
  ctx: RenderContext,
  opts?: { helpers?: Record<string, Handlebars.HelperDelegate> },
): Promise<RenderedTemplate>
```

Renders a published `TemplateDoc` with Handlebars against a contact + vars context. Returns the substituted subject, preheader, HTML, plain text, and From identity.

```ts
const rendered = await renderTemplate(template, {
  contact: { externalId: 'u1', email: 'a@x.com', tags: [], fields: { firstName: 'Ana' } },
  vars: { daysRemaining: 3 },
  unsubscribeUrl: 'https://yourdomain.com/m/unsub/abc123',
  senderAddress: '12 Main Street, Brooklyn NY 11201',
})

// rendered.html, rendered.plainText, rendered.subject, rendered.preheader,
// rendered.fromName, rendered.fromEmail, rendered.replyTo
```

`RenderContext` accepts:

| Field | Notes |
|---|---|
| `contact` | The `Contact` from your adapter |
| `vars` | Per-send vars (template `variablesSchema` defines the schema) |
| `unsubscribeUrl` | The recipient's signed unsubscribe URL |
| `viewInBrowserUrl` | Optional |
| `preferenceCenterUrl` | Optional |
| `senderAddress` | CAN-SPAM postal address |

## derivePlaintext(html)

```ts
function derivePlaintext(html: string): string
```

Auto-derives the plain-text alternative from HTML. Used internally when a template doesn't supply its own plain text.

- Strips tags
- Preserves links as `Text (url)`
- Word-wraps at 80 chars
- Drops images

## applyTracking(html, opts)

```ts
function applyTracking(html: string, opts: {
  sendId: string
  publicUrl: string
  trackOpens: boolean
  trackClicks: boolean
  preserveUrls?: string[]
}): { html: string; links: Array<{ linkId: string; url: string }> }
```

Rewrites `<a href>` to `/m/click/<sendId>/<linkId>` and appends an open pixel.

```ts
const { html: tracked, links } = applyTracking(rendered.html, {
  sendId: 'snd_8a2c',
  publicUrl: 'https://yourdomain.com',
  trackOpens: true,
  trackClicks: true,
  preserveUrls: [unsubscribeUrl],   // don't rewrite the unsubscribe link
})

// `links` is the linkId → URL map. Store on mailer_sends.links for click resolution.
```

### Links NOT rewritten

- `mailto:` / `tel:` / `#anchor`
- URLs in `preserveUrls`
- Tags with `data-mailer-notrack="true"`

## Built-in Handlebars helpers

| Helper | Use |
|---|---|
| `eq`, `ne`, `gt`, `lt`, `gte`, `lte` | Comparison |
| `and`, `or`, `not` | Boolean |
| `formatDate` | `{{formatDate vars.expiresAt 'long'}}` |
| `formatNumber` | `{{formatNumber vars.count}}` |
| `formatCurrency` | `{{formatCurrency vars.amountCents 'usd'}}` |
| `pluralize` | `{{pluralize vars.count 'shot' 'shots'}}` |

Plus host-supplied helpers via `Mailer.init({ handlebarsHelpers: { ... } })`.

## Using outside mailery

These functions don't require a `Mailer` instance — useful for offline rendering, MJML linting, build-time compilation pipelines, etc.

```ts
import { compileTemplate, derivePlaintext, applyTracking } from 'mailery'

// In a build script:
const { html, errors } = await compileTemplate(await fs.readFile('email.mjml', 'utf8'))
if (errors.length > 0) process.exit(1)
await fs.writeFile('email.html', html)
```
