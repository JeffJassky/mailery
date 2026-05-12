# 00 — Vision

## The one-line pitch

A self-hosted Node.js email automation library you embed inside any Express + MongoDB app — triggered flows, broadcasts, suppression, tracking, and compliance, without standing up a separate service.

## The problem we're solving

Email automation for low/mid-volume SaaS has three categories of options today, all unsatisfying:

1. **Hosted SaaS** (MailerLite, Mailchimp, Customer.io, Loops): Pay per-contact forever. Walled gardens. Your user database has to sync to a third party, and every signup is a webhook across the public internet.
2. **Self-hosted newsletter tools** (Listmonk, Mautic, Keila): Solve broadcasts but weak on triggered automation flows. Run as separate services with their own user model — not designed for embedding inside an existing app.
3. **DIY** (build it on top of SendGrid + cron jobs): Solves the immediate need but every developer rebuilds the same primitives — suppression, bounce handling, tracking, unsubscribe — badly.

There's a fourth category that doesn't yet exist:

**An embedded, opinionated automation engine that lives inside your app's process, talks to your app's MongoDB, and treats your existing users collection as the source of truth for identity.**

That's what this is.

## The wedge

Two things make this different from existing tools:

1. **Embedded, not external.** `npm install`, mount the router, fire events. No webhooks across the public internet for every signup. No syncing your user database to a third-party SaaS. Your user record is the contact — mailer reads it through a tiny adapter and never duplicates identity data.
2. **Both transactional and marketing in one engine.** Password resets, receipts, and security alerts go through the same pipeline as activation drips and newsletters — with the right defaults for each (suppression scope, sender identity, circuit-breaker behavior). One source of truth for "did this user get email X."

## Goals

**The library must:**

- Run fully embedded inside an existing Express + MongoDB app
- Support both **time-based drips** and **event-triggered flows** as first-class citizens
- Send both **transactional** (password resets, receipts) and **marketing** (drips, newsletters) email, with the right defaults applied per kind
- Provide a clean **provider abstraction** so SendGrid can be swapped for Postmark/SES/Resend without touching flow logic
- Use BullMQ (Redis) for queue + delayed-job scheduling
- Handle **deliverability table stakes** correctly: bounces, complaints, suppression, unsubscribes, one-click-unsubscribe headers, DMARC alignment
- Use **MJML** as the template source of truth, compile to HTML on save, auto-derive plain text
- Ship a **WYSIWYG email editor** (Maily-style) for non-technical authors, with MJML as the persisted format
- Track **opens, clicks, deliveries, bounces, complaints** and persist them on each send
- Expose a **mountable admin UI** for human monitoring and small operations
- Document its data model clearly enough that a developer can configure flows and templates by reading and writing MongoDB documents directly when they want to

## Non-goals

**The library will not:**

- Provide a hosted SaaS offering, or any kind of managed deployment. Self-hosted only.
- Ship a visual drag-and-drop flow builder. Flows are JSON documents.
- Build its own SMTP server. We always send via a provider.
- Run on PostgreSQL or MySQL. MongoDB only.
- Be multi-tenant within a single instance. One deployment = one app.
- Ship its own auth/login. The host gates the admin route with its existing middleware.
- Ship forms, popups, landing pages, or signup widgets. The host builds those.
- Build inbox-side features (inbox view, reply parsing). Outbound only.

## Market positioning

> **The embedded email automation layer for Node + MongoDB SaaS.**
>
> If you run a Node + Mongo app and you don't want to pay per-contact-per-month for the rest of time, install this. Fire events from your code. Define flows in MongoDB. Get tracking, suppression, compliance, and an admin UI for free.

Not competing with hosted SaaS on no-code experience. Not competing with Listmonk on standalone newsletter UX. Competing for the slot where a Node-and-Mongo team would otherwise build it themselves on top of SendGrid + cron.

## Success criteria (V1)

V1 is successful when:

- StoryFolder is running 4 production flows (welcome, activation rescue, Pro welcome, cancel save) through this library
- At least one other Node+Mongo app is also running it
- All `INVARIANTS.md` rules are enforced and tested
- The library is extracted to its own repo with a README that a new developer can integrate from in under an hour

Anything beyond that is V2.
