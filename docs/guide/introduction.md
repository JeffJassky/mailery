# Introduction

**mailery** is an embedded email automation library for Node.js + MongoDB apps. You `npm install` it into your Express server, point it at MongoDB + a transactional email provider (and a queue backend — either Redis or your existing Mongo), and you get:

- **Triggered flows** — fire an event from your business code (`user.created`, `cart.abandoned`, etc.), mailery routes them through wait / condition / branch / send / tag steps.
- **Broadcasts** — one-off campaigns to a segment of your contacts, with a confirmation gate above a configurable recipient threshold.
- **Transactional sends** — `mailer.sendOneOff()` for receipts, password resets, and other one-shots, with the same idempotency + tracking + suppression as your marketing emails.
- **Tracking** — open pixel, click-rewriting, provider webhook ingestion. All wired into a `mailer_sends` document per email.
- **Compliance** — HMAC-signed unsubscribe tokens, scope-aware suppression (marketing ≠ all), GDPR forget with hashed-suppression retention.
- **Admin UI** — a prebuilt React SPA you mount on a route gated by your existing auth.

## What mailery is not

- **Not a SaaS.** Self-hosted only. Your MongoDB, your sender domain.
- **Not a SMTP server.** Sends always go through a transactional provider (SendGrid in V1; Postmark / SES / Resend pluggable).
- **Not multi-tenant.** One deployment serves one app. Run separate deployments per account.
- **Not a CRM.** Mailery doesn't own contact identity — your `users` collection does. Mailery reads it through a tiny `ContactAdapter`.
- **Not a drag-and-drop campaign builder.** Flows are JSON documents. The admin UI has a WYSIWYG **template** editor, but flows are authored as code (or directly in Mongo).

## Why embedded?

The four common alternatives all have downsides:

| Option | Problem mailery avoids |
|---|---|
| Hosted SaaS (MailerLite, Customer.io, Loops) | Pay per contact forever; sync your user DB to a third party; APIs don't expose flow content. |
| Self-hosted broadcasters (Listmonk, Mautic) | Weak triggered automation; separate user model from your app. |
| DIY on SendGrid + cron | Every team rebuilds the same primitives — suppression, bounce handling, tracking, unsubscribe — and gets one of them wrong. |

mailery sits inside your app process. Your user record IS the contact. Events fire as in-process function calls. No identity sync, no inter-service webhooks for trivial things.

## Architecture sketch

```
┌──────────────────────────────────────────────────────────────────┐
│  Your Express app                                                │
│                                                                  │
│  business logic ── mailer.fire(event, userId) ──► mailer         │
│                                                     │            │
│  app.use('/admin/mailer', ...createAdminRouter())  │            │
│  app.use('/m', ...createPublicRouter())            │            │
│                                                     ▼            │
│                            ┌──────────────────────────────┐     │
│                            │  Mongo (your app's DB)       │     │
│                            │    mailer_events, flows,     │     │
│                            │    templates, sends, ...     │     │
│                            └──────────────────────────────┘     │
│                                          ▲                       │
│  ┌─────────────────────────────────────┐ │                       │
│  │  worker process                     │ │                       │
│  │    mailer.startWorkers()            │─┘                       │
│  │      queue → SendGrid → recipients                           │
│  └─────────────────────────────────────┘                         │
└──────────────────────────────────────────────────────────────────┘
```

You run two processes from the same codebase: a **web** process serving HTTP + tracking endpoints, and a **worker** process running queue consumers. Both share the same Mongo. The queue backend is pluggable — BullMQ on Redis (default), or Agenda on Mongo. See [Queue drivers](./queues).

## Next steps

- [Quickstart](./quickstart) — wire up mailery in five minutes
- [Configuration](./configuration) — every option, every default
- [Events](./events) — register events, fire them from your code
- [Flows](./flows) — author flow definitions
