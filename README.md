# mailery

> Embedded, MongoDB-backed email automation for Node.js. Triggered flows, broadcasts, segmentation, tracking, suppression, and an admin UI you mount inside your Express app.

**Status:** Design spec only. No code yet. See [`plans/`](./plans/) for the full design.

## What it is

A self-hosted, embeddable email automation library — a developer-first, agent-configurable alternative to MailerLite / Mailchimp / Customer.io.

- **Embedded, not external.** `npm install`, mount the router, fire events. No third-party sync.
- **Mongo schema is the public API.** AI agents read and write flow/template documents directly.
- **Provider-agnostic.** SendGrid first; Postmark / SES / Resend pluggable.
- **Queue-agnostic.** BullMQ (Mongo + Redis) primary; Agenda (Mongo-only) supported.

## Docs

Full documentation: <https://jeffjassky.github.io/mailery/>

## Status & roadmap

See [`plans/13-roadmap.md`](./plans/13-roadmap.md).

## License

[MIT](./LICENSE) © Jeff Jassky
