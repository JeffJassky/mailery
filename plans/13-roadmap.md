# 13 — Roadmap

The phased build plan. Each phase is independently shippable. Phase 0 ends with mailer running one production flow at StoryFolder.

## Phase 0 — Spike (1 week)

Goal: validate the design end-to-end with the minimum viable surface. No clean abstractions, no admin UI. Just prove the loop works.

**Build:**

- Mongo schemas for `subscriptions`, `events`, `flows`, `flow_runs`, `templates`, `sends`, `suppressions`. Skip `outbox`, `audit_log`, `webhook_events`, `health`, `leads`, `tags` for now.
- `MongoContactAdapter` (basic — no batch hydration, no tag writes).
- BullMQ wiring: `mailer:tick` queue with a single-minute repeat.
- Runner: just `wait`, `condition`, `send`, `exit` step types. No branch, no fire_event, no webhook step.
- SendGrid provider: `send()` only. No webhook handling, no signature verification.
- MJML rendering + Handlebars substitution.
- Open pixel endpoint (basic). No click rewriting.
- Public `fire()`, `upsertSubscription()`, `unsubscribe()` methods.

**Deploy:**

- StoryFolder runs one flow: `activation-rescue`. Triggered on `Downloaded app`. Two emails, 24h apart, with a condition checking `Activated app`.
- Existing MailerLite Main Drip stays running in parallel.

**Validate:**

- Watch a real signup, see the runner pick up the event, send the email, record the open via pixel.
- Confirm no double-sends across two runner workers.
- Confirm a contact who activates after Email 1 doesn't get Email 2.

**End of Phase 0:** working code, one production flow, no clean separation. Lots of TODOs.

## Phase 1 — Cleanup + extraction (1 week)

Goal: turn the spike into a respectable library.

**Refactor:**

- Move spike code into `packages/mailer/` with proper directory structure (per `01-architecture.md`).
- Define interfaces: `ContactAdapter`, `MailProvider`.
- Refactor SendGrid into a proper `SendGridProvider` class implementing the interface.
- Add Zod schemas for all collections; validate at write boundaries.
- Set up Vitest with unit + integration test layers.
- Add `mailer_audit_log`, `mailer_outbox`, `mailer_health`, `mailer_webhook_events`, `mailer_flow_versions`.

**Add features:**

- Provider webhooks (SendGrid event webhook with signature verification, dedup, async processing).
- Hard-bounce → suppression cascade.
- Click rewriting + tracking.
- Circuit breaker (basic — trip on hard bounce or complaint rate, manual resume).
- All FlowStep types: `branch`, `tag`, `fire_event`, `webhook`, `exit`.
- Outbox pattern + `fireFromSession()`.
- Tag adapter writes (`tagsField` / `tagsWritable`).

**End of Phase 1:** library is its own package, well-tested, all FlowStep types supported, all of `INVARIANTS.md` enforced.

## Phase 2 — Admin UI + multi-app extraction (1 week)

Goal: human operators can monitor, agents can configure.

**Build:**

- Mountable admin router (htmx + server-rendered HTML).
- All views from `09-admin-ui.md`: dashboard, flows list/detail, templates list/edit, sends log, contacts search, suppressions, broadcasts, audit log, health.
- MJML live-preview pane.
- Send-test for templates.
- Broadcast scheduling with confirmation gate.

**Extract:**

- Pull `packages/mailer/` into its own repo.
- Publish to private npm (or local file dep for now).
- Install in StoryFolder via the package manager.
- Add to a second app to prove portability.

**End of Phase 2:** library is installable, two apps using it, agents can configure flows by writing to Mongo, humans can monitor via the admin UI.

## Phase 3 — Hardening + polish (1 week)

Goal: production-quality across all the small things.

**Add:**

- Postmark provider (for transactional). Build out the abstraction with two real providers.
- Daily webhook reconciliation against provider Activity APIs.
- GDPR forget + export endpoints.
- Double opt-in flow.
- Send-time IP / User-Agent logging (opt-in).
- Linting on template publish (unsubscribe link present, sender address present, valid MJML).
- The `mailer_leads` collection for pre-user form fills.
- `promoteLead()` API.
- `MongoContactAdapter` batch hydration via `getBatch()`.

**Polish:**

- Migration tooling (collection prefix change, schema additions).
- `Mailer.fromEnv()` factory.
- Comprehensive README in the package.
- Versioned API; semver discipline.

**End of Phase 3:** production-ready library that can be open-sourced.

## Phase 4 — Decision point (after a quarter of production data)

Three forks based on what we learned:

### Fork A — Keep it private, run it
Polish, but don't OSS. Use across all the user's apps. Build internal automation tools (agent integration) without worrying about external developer ergonomics.

### Fork B — Open source
- Write up the README, contribute guide, license (probably MIT).
- Migrate repo to its own GitHub org or public account.
- Build a docs site (VitePress).
- Announce. Accept contributions.

### Fork C — Commercial offering
- Build a hosted version (multi-tenant).
- Pricing tier.
- "Self-host or pay us to host" model. The library stays free; the hosting / managed compliance / SLA is the paid layer.

The decision is informed by how the library actually performs in production across multiple apps, and what other developers say when they see it. Not pre-committed.

## Out of scope (V1)

To stay focused, V1 explicitly skips:

- Visual drag-and-drop flow builder
- A/B test infrastructure (manual via branch steps for now)
- SMS / push channels (email only)
- Inbound parsing (replies → events)
- Segment versioning ("here's what this segment looked like a month ago")
- Send-time optimization (best time to send per contact)
- Multi-tenant inside a single instance
- PostgreSQL support
- Mobile / responsive admin UI (desktop-only is fine for V1)
- Localization / i18n of the admin UI
- Detailed analytics dashboards beyond what's needed for the dashboard view

All deferrable. None blocks V1.

## Success criteria

V1 ships when:

- [ ] StoryFolder runs 4 flows through mailer (activation rescue, Pro welcome, cancel save, monthly newsletter)
- [ ] At least one other app is running mailer in production
- [ ] An AI agent has end-to-end configured a flow (drafted email, inserted step, published) without human-in-loop on any individual step
- [ ] Library has a published version (private npm or local file dep)
- [ ] All `INVARIANTS.md` rules enforced and tested
- [ ] Admin UI usable for daily monitoring without needing to drop to direct DB queries

Stretch:

- [ ] Postmark provider in production for transactional
- [ ] Library OSS'd (Phase 4 Fork B)
- [ ] Hosted offering MVP (Phase 4 Fork C)

## Time budget

Phase 0–3 estimated at **4 weeks of focused work**. Realistically with normal interruptions: 6–8 calendar weeks. The boring middle (Phase 1 + Phase 3) eats more than the exciting bits (Phase 0 + Phase 2).

If time is tight: ship Phase 0 to production immediately, do Phase 1 over time, defer 2–3 until needed.
