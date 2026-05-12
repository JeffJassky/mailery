# mailery

> Embedded, MongoDB-backed email automation for Node.js. Triggered flows, broadcasts, tracking, suppression, compliance, and an admin UI you mount inside your Express app.

**Status:** design spec only. No code yet. See [`plans/`](./plans/) for the full design.

## What it is

A self-hosted library you `npm install` into your Express + MongoDB app. Fire events from your code, define flows + templates as documents in MongoDB, mount the admin UI on a route you gate with your existing auth.

- **Embedded, not external.** No third-party sync, no per-contact pricing.
- **Both transactional and marketing in one engine.** Password resets, receipts, drips, newsletters — same pipeline, right defaults per kind.
- **Provider-agnostic.** SendGrid first; Postmark, SES, Resend pluggable.
- **BullMQ + Redis** for queue + delayed-job scheduling.
- **MJML** templates with a WYSIWYG editor (Maily) in the admin UI.

## Docs

Design spec: [`plans/`](./plans/) — start with [`plans/README.md`](./plans/README.md).

Published docs (once shipped): <https://jeffjassky.github.io/mailery/>

## Status & roadmap

See [`plans/13-roadmap.md`](./plans/13-roadmap.md).

## License

[MIT](./LICENSE) © Jeff Jassky
