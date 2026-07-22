# mailery's test suites

Four directories, three tiers. The split exists because the axes under test
have genuinely different time and infrastructure characteristics — not because
of taste.

| Directory | Clock | Queue | Provider | Network | Runs |
|---|---|---|---|---|---|
| `unit/` | real | — | — | no | every `yarn test` |
| `integration/` | real | noop | Recording→Null | no | every `yarn test` |
| `matrix/` | **frozen** | noop | Recording→Null | no | every `yarn test` |
| `longhorizon/` | real (or shifted) | noop | Recording→Null | no | every `yarn test` + CI cron |
| `live/` | real | Bull (if Redis) | Recording→**SendGrid** | **yes** | gated by env |
| `e2e/` | real | — | — | browser | `yarn test:e2e` (Playwright) |

Everything except `live/` runs offline with no credentials. `yarn test` must
stay green on a laptop with no network and no `.env`.

## Tier 1 — the fast matrix (`test/matrix/`)

The bulk of the coverage. Real MongoDB (`mongodb-memory-server`), real runner,
real adapters, frozen clock, no background workers. One axis per file:

- `render-vars.test.ts` — every source of template data (contact fields,
  event properties, step vars, host `varsAdapter` keys, `unsubscribeUrl`,
  helpers), asserted on subject, html and plain text.
- `render-text-html.test.ts` — the two body parts, tracking rewrites, and the
  two-render pipeline (queue-time render vs dispatch-time re-render).
- `delivery-window.test.ts` — time-of-day slots, the grace window, weekday
  gating, contact-timezone resolution, DST, deferral idempotency.
- `flow-lifecycle.test.ts` — flow start, every step type, and every exit path
  including abort and mid-flow unsubscribe.

**Clock rule:** fake `Date` only (`vi.useFakeTimers({ toFake: ['Date'] })`).
Faking timers stalls the MongoDB driver's heartbeats and the suite hangs. Move
time with `vi.setSystemTime`. See `matrix/clock.ts`.

## Tier 1b — real-clock gating (`test/longhorizon/`)

The same delivery gating, with **no** frozen clock. Expectations are derived
from whatever day it actually runs on: on a weekend the weekday gate must
defer, on a weekday it must not. Neither branch is vacuous, but only one runs
per execution — which is why CI also runs this on a Saturday/Sunday cron. The
calendar supplies the axis instead of a mock.

The timezone case needs no waiting at all: `Pacific/Kiritimati` (+14) and
`Pacific/Midway` (-11) are 25 hours apart, so they can never share a calendar
date, whatever the instant.

## Tier 2 — live SendGrid (`test/live/`)

**Scope: the provider adapter, not a second copy of the matrix.** These tests
confirm the adapter's own configuration surface works — auth, sandbox mode, the
`SendArgs` → SendGrid mapping, the response mapping, the error path. Flow and
template behaviour stays offline in tier 1.

The inbound half of the adapter (`verifyWebhook`, `parseWebhookEvents`) needs
no network and lives in `unit/sendgrid-provider.test.ts`, so it runs always.

```bash
# Real API, real auth, nothing delivered, no quota spent. Start here.
MAILERY_LIVE_E2E=sandbox yarn test:live

# Real delivery + Gmail IMAP assertions.
MAILERY_LIVE_E2E=deliver yarn test:live
```

Unset `MAILERY_LIVE_E2E` (or omit `SENDGRID_API_KEY`) and the whole tier skips.

Credentials come from the process environment; `test/setup-env.ts` seeds them
from a gitignored `.env`. See `.env.example` for the full list. Real
environment variables always win over `.env`, so CI secrets are never shadowed.

**Known limits:**

- Sandbox mode does *not* validate sender authentication — it accepts an
  unverified from-domain with a 200. Only the deliver path settles that, which
  is why one test is `skipIf(sandbox)`.
- Gmail IMAP requires a 16-character **app password** (2FA on the account) or
  OAuth2. The plain account password is rejected with `AUTHENTICATIONFAILED`.
  Google only shows the app-password page once 2-Step Verification is on;
  before that it reports "the setting you are looking for is not available."
  Spaces in the displayed password are formatting — `gate.ts` strips them.
- `waitForMessage` opens a **fresh IMAP connection per poll**. Holding one
  mailbox lock and searching inside it repeatedly keeps hitting the snapshot
  taken at select time, so mail arriving mid-wait is invisible and the call
  times out while the message sits in the inbox.
- Delivered emails describe their own assertions in the body (`describeChecks`)
  so a human reading the inbox can tell what each one was for. Keep provider
  domain names out of that prose — assert on `href` targets, not on substrings
  of the whole document, or the body matches its own checklist.
- SendGrid's Event Webhook needs a public HTTPS endpoint, so delivered/open/
  click events can't reach a laptop. The inbox check is the local substitute.
- Gmail proxies remote images, so a delivered message may self-trigger the open
  pixel. Never assert `openCount === 0` after a live send.

Set `MAILERY_TEST_REDIS_URL` to run the live tier through real BullMQ workers —
the only configuration that exercises job delays, retries, backoff and the send
rate limiter (`docker run -p 6379:6379 redis:7`).

## Tier 3 — long horizon (CI only)

`.github/workflows/live-e2e.yml`. Hourly cron for time-of-day slots, a
Saturday/Sunday cron for real weekend gating, and a manual `workflow_dispatch`
job that runs `longhorizon/` under `libfaketime` at four pinned instants
(Friday night → Monday morning) to compress multi-day waits. `libfaketime` is
`LD_PRELOAD`-based and Linux-only — it will not work on macOS. SendGrid's own
timestamps stay real under it, so assert on mailery's state, never on provider
timestamps.

## Writing a new matrix case

The builders exist so a case costs ~10 lines. Use them:

```ts
const H = await createTestMailer()
await H.seedContact({ externalId: 'u1', email: 'a@example.com', tags: [], fields: {} })
await H.seedTemplate({ slug: 'tpl', subject: 'Hi {{contact.fields.firstName}}' })
await H.seedFlow({ slug: 'flow', eventName: 'Trigger', steps: [step.send('tpl')] })
H.mailer.registerEvent({ name: 'Trigger', dedupePolicy: 'every-time' })

await H.mailer.fire('Trigger', 'u1')
await H.drain()
```

Give each case its own contact, template, flow and event name — the suites
share one Mongo instance per file and isolate by naming, not by teardown.

**Verify new assertions actually bind.** A test that passes first try against
code you just read is not yet evidence. Break the implementation deliberately
and confirm the right tests fail:

```bash
# e.g. make the weekend gate a no-op, then:
npx vitest run test/matrix/delivery-window.test.ts   # expect failures
```
