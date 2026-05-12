---
layout: home

hero:
  name: mailery
  text: Embedded email automation
  tagline: Triggered flows, broadcasts, tracking, and a React admin UI you mount inside your Node.js + MongoDB app. No SaaS, no per-contact pricing.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: View on GitHub
      link: https://github.com/JeffJassky/mailery

features:
  - title: Embedded, not external
    icon: 📦
    details: '`npm install mailery`, mount the routers, fire events from your code. No third-party sync, no webhooks across the public internet for every signup.'
  - title: Triggered flows + broadcasts
    icon: 🔁
    details: Event-driven automation with wait / condition / branch / send / tag steps. Idempotent runner with optimistic-concurrency and exactly-once sends per step.
  - title: Both transactional and marketing
    icon: ✉️
    details: One engine handles password resets and drip campaigns. Suppression scope, sender identity, and circuit-breaker behavior all do the right thing per kind.
  - title: MJML templates with WYSIWYG
    icon: 🎨
    details: MJML source with Handlebars variables. WYSIWYG editor in the admin UI. Plain-text auto-derivation, click + open tracking, scope-aware suppression at send time.
  - title: Pluggable providers
    icon: 🔌
    details: SendGrid ships in the box. Postmark / SES / Resend pluggable via a tiny interface. Per-provider rate limiting and routing per template kind.
  - title: Built-in React admin UI
    icon: 🎛️
    details: Prebuilt SPA serves from your own domain at any mount path. No bundler in your app. Auto-cached, code-split, ~60 KB gzipped.
---

```ts
import { Mailer, MongoContactAdapter, SendGridProvider, createAdminRouter, createPublicRouter } from 'mailery'

const mailer = await Mailer.init({
  db,
  adapter: new MongoContactAdapter({ db, collection: 'users' }),
  queue: { driver: 'bull', redis: { url: process.env.REDIS_URL! } },
  providers: { sendgrid: new SendGridProvider({ apiKey: process.env.SENDGRID_API_KEY! }) },
  defaultProvider: 'sendgrid',
  publicUrl: 'https://yourdomain.com',
  unsubscribeSecret: process.env.MAILER_UNSUB_SECRET!,
})

mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })

app.use('/admin/mailer', requireAdmin, createAdminRouter(mailer))
app.use('/m', createPublicRouter(mailer))

// From your business logic:
await mailer.fire('Created', user._id.toString())
```
