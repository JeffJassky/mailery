# 00 — Vision

## The one-line pitch

A self-hosted Node.js email automation library you embed inside any Express app — designed to be configured by AI agents reading and writing its MongoDB-backed schema directly.

## The problem we're solving

Email automation for low/mid-volume SaaS has three categories of options today, all unsatisfying:

1. **Hosted SaaS** (MailerLite, Mailchimp, Customer.io, Loops): Pay per-contact forever. Walled gardens. APIs don't expose flow content editing, so AI agents can't configure them. Designed for human operators clicking through visual builders.
2. **Self-hosted newsletter tools** (Listmonk, Mautic, Keila): Solve sending broadcasts but weak on triggered automation flows. Not designed for embedding inside an existing app.
3. **DIY** (build it on top of SendGrid + cron jobs): Solves the immediate need but every developer rebuilds the same primitives — suppression, bounce handling, tracking, unsubscribe — badly.

There's a fourth category that doesn't yet exist:

**An embedded, opinionated automation engine that lives inside your app's process, talks to your app's MongoDB, and exposes everything an agent or developer needs to do via well-named documents in well-known collections.**

That's what this is.

## The wedge

Three things make this different from every existing tool:

1. **Embedded, not external.** `npm install`, mount the router, fire events. No webhooks across the public internet for every signup. No syncing your user database to a third party.
2. **Mongo schema is the public API.** Want to add a new email to a flow? Push a step into `flows.draft.steps`. Want to see what's queued? Query `flow_runs`. Want to update a template? Edit `templates.draftBody`. The schema is small, documented, and stable. AI agents work with the database directly — no special API surface to learn.
3. **Multi-app portable.** The same library deploys across multiple SaaS products. Each app runs its own instance with its own state. An agent managing your portfolio just connects to whichever app's database it needs.

## Goals

**The library must:**

- Run fully embedded inside an existing Express + MongoDB app
- Support both **time-based drips** and **event-triggered flows** as first-class citizens
- Provide a clean **provider abstraction** so SendGrid can be swapped for Postmark/SES/Resend without touching flow logic
- Provide a **queue abstraction** so the runner works on Agenda (Mongo-only stacks) or BullMQ (Mongo + Redis stacks)
- Handle **deliverability table stakes** correctly: bounces, complaints, suppression, unsubscribes, one-click-unsubscribe headers, DMARC alignment
- Store **all configuration in MongoDB** so agents can introspect and mutate without code changes
- Use **MJML** as the template source-of-truth, compile to HTML on save, auto-derive plain text
- Track **opens, clicks, deliveries, bounces, complaints** and persist them on each send
- Expose a **mountable admin UI** for human monitoring (read-mostly; flows authored in code/Mongo, not drag-and-drop)
- Document the schema clearly enough that an agent can configure flows reliably on first read

**Specifically, an AI agent integrated into the host app should be able to:**

- Read all flows and templates to understand what's running
- Draft a new email and insert it as a step in an existing flow
- Create a new flow triggered by a specific event
- Pause or unpause a flow
- A/B test by inserting branching steps
- Read send performance metrics and propose changes
- Diagnose why a specific contact got (or didn't get) a specific email
- Add a contact to a suppression list

…all by querying and mutating MongoDB documents directly.

## Non-goals

**The library will not:**

- Replace transactional email (one-off "your password reset" emails). Use SendGrid/Postmark directly for those.
- Provide a hosted SaaS offering, or any kind of managed deployment. Self-hosted only.
- Include a visual drag-and-drop flow builder. Flows are JSON documents. The admin UI displays them; it doesn't author them.
- Build its own SMTP server. We always send via a provider.
- Run on PostgreSQL or MySQL. MongoDB only. (Could be added later; not in MVP.)
- Be multi-tenant within a single instance. Each app's deployment serves exactly one "account." Multi-app means multiple deployments.
- Ship its own auth/login. The consuming app gates the admin route via existing middleware.
- Build inbox-side features (inbox view, reply parsing). Outbound only.

## Market positioning

If this gets extracted as an OSS library or product, the positioning is:

> **The email automation layer for AI-native, MongoDB-backed SaaS.**
>
> If you run a Node + Mongo app and you want an AI agent (or a developer) to manage your email program without learning a vendor's proprietary API, install this.

Closest comparables and how we differ:

| Tool | What it is | Why we're different |
|---|---|---|
| Customer.io | Hosted enterprise marketing automation | Embedded, MongoDB-native, agent-readable schema |
| Loops.so | Hosted dev-friendly email | Embedded, schema-as-API, multi-app portable |
| Listmonk | Self-hosted Go newsletter tool | Triggered flows + agent-configurable, not just broadcasts |
| Plunk | Self-hosted standalone email app | Library you embed, not a separate service |
| Mautic | Self-hosted enterprise marketing PHP | Modern, dev-first, Node-native, ~1% the surface area |
| Resend Audiences | Hosted contact management | Embedded, flows + segmentation built in |

## Success criteria (V1)

V1 is successful when:

- StoryFolder is running 4 production flows (welcome, activation rescue, Pro welcome, cancel save) through this library, replacing MailerLite for those touchpoints
- At least one other app is also running it
- An AI agent can read the schema, propose a new flow, and apply it via direct MongoDB writes — no human-in-the-loop required to make the change (humans approve before publish)
- The library is extracted to its own repo with a README that a new developer can integrate from in under an hour

Anything beyond that is V2.
