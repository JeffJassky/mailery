# Changelog

## 0.15.0 — Public-surface hardening and honest unsubscribes

`createPublicRouter` is the only unauthenticated surface this package mounts,
and most of this release is about it: tracking URLs that can't be forged, an
unsubscribe that doesn't lie, a redirect that can't be pointed at
`javascript:`, and a rejected promise that can no longer take the host process
down. Alongside that, three places where a mistyped provider name silently
routed mail somewhere else now say so.

### If you are upgrading

Six things need a decision or a config change. Each is expanded below.

1. **Set `pendingUnsubsPath`** — or accept that `POST /m/unsub/:token` answers
   **503** while Mongo is degraded, where 0.14 answered a false 200. There is
   no default any more, and the public router logs a warning at construction
   when it is unset.
2. **Check `defaultTransactionalProvider` for typos before you deploy.**
   `Mailer.init` now validates it and throws. A typo that has been silently
   routing transactional mail through your marketing provider will stop your
   app from starting.
3. **`hasOpenedExcludingBots` / `hasClickedExcludingBots` / `openedAtLeastN` /
   `clickedAtLeastN` will match fewer sends** from now on. They were no-ops.
   Flows that branch on them will behave differently.
4. **Leave `requireSignedTrackingUrls` at its default `false`** until the
   `unsigned tracking URL accepted — legacy grace mode` log line goes quiet.
   Mail already in inboxes carries unsigned URLs.
5. **If your ingress can delay a webhook past five minutes**, set
   `webhookToleranceSeconds` (or `MAILER_SENDGRID_WEBHOOK_TOLERANCE`).
   Otherwise SendGrid events start being rejected with 401.
6. **`NullProvider.verifyWebhook()` now returns `false`.** Local or staging
   setups that POST unsigned bodies at `/m/webhooks/null` will get 401.

### Changed

- **`pendingUnsubsPath` has no default, and `POST /m/unsub/:token` can now
  answer 503.** Through 0.14 the route replied 200 before attempting anything
  and appended failures to `/tmp/mailery-pending-unsubs.jsonl` — a file nothing
  ever read back, on a world-writable directory, cleared on reboot. INVARIANT 8
  described a drain and a 503 path; neither existed. A recipient who asked to
  stop receiving mail during a Mongo blip was told they had unsubscribed and
  then kept receiving mail, and no counter anywhere moved.

  The route now awaits the write, bounded by the new `unsubscribeWriteTimeoutMs`
  (default `5000`), and answers 200 only for something durably recorded:

  | outcome | response |
  |---|---|
  | Mongo write succeeds (sub-millisecond, normally) | 200 |
  | write fails or times out, `pendingUnsubsPath` is set | journal → 200 |
  | write fails and there is nowhere to journal it | **503** + `Retry-After: 60` |

  The journal is replayed by `drainPendingUnsubscribes`, which runs on every
  tick — claiming its batch by `rename` (the whole mutex), appending
  undrained entries back before unlinking the claim, so a crash duplicates
  rather than drops, and replaying through the same idempotent path
  `mailer.unsubscribe` uses. It is exported for hosts that don't run the tick.
  A malformed or repeatedly-failing entry is never discarded, only made loud.

  **Existing installs:** upgrading does not pick a path for you, and it must
  not. The journal holds recipient email addresses in plaintext outside the
  database and outside INVARIANT 9's purge story, so where it lives is your
  data-residency decision. It also has to be durable (not `/tmp`), private
  (mailery creates the file `0600` in a `0700` dir and opens it `O_NOFOLLOW`,
  but cannot fix a world-writable parent), node-local (batch claiming needs
  `rename` to be atomic within the directory, so no NFS) and not shared between
  hosts:

  ```ts
  // systemd: StateDirectory=mailery gives you this, owned by the unit's user
  await Mailer.init({ pendingUnsubsPath: '/var/lib/mailery/pending-unsubs.jsonl' })
  ```

  Leaving it unset is a legitimate choice — you are saying "if Mongo is down,
  tell the caller so" rather than "hold it on this node's disk". **A host that
  leaves it unset will see 503s where 0.14 returned 200.** That is the same
  failure, told honestly; the 200 was what made the 503 unreachable and every
  failure a lie. The invariant used to justify the old behaviour by claiming
  SendGrid would queue the unsubscribe internally — it will not. The
  `List-Unsubscribe` URL points at us and the one-click POST comes from the
  recipient's mail client, so the provider never sees it. The journal is the
  only fallback there is.

  `PublicRouterOptions.pendingUnsubsPath` still works but is deprecated: the
  drain reads the **config** value, so a path set only on the router is written
  and never replayed — which is precisely the old bug. Setting it there without
  also setting it in config logs a warning.

- **`Mailer.init` now validates `defaultTransactionalProvider`.** Only
  `defaultProvider` was checked. A typo in the transactional default was
  completely silent, and combined with the runner's fallback (below) it did not
  fail at all: transactional mail went out through the marketing provider, from
  the wrong sending reputation, with nothing recorded to say so.

  **Existing installs:** if that name is wrong today, **your app will now fail
  to start**, with an error naming the unresolved provider and the registered
  alternatives. That is intended — but it will look like the upgrade broke your
  deploy, so check the value before you ship. Both defaults now go through the
  same guarded lookup, so a name like `constructor` is rejected rather than
  resolving to a truthy non-provider.

- **The send runner no longer falls back to `defaultProvider`.** It did
  `providers[send.provider] ?? providers[defaultProvider]`, so a stale or
  mistyped provider name on a send row quietly routed that mail through the
  default: delivered from a reputation the send row does not record, with
  nobody ever learning of the typo. `send.provider` is written by
  `pickProviderName`, which has already applied the default, so a name that
  still doesn't resolve is stale rather than absent and substituting hides it
  forever.

  The send now fails with `provider_unknown: no provider is registered as
  "<name>". Registered providers: …` — marked failed and returned, not thrown,
  matching the `template_missing` / `contact_missing` paths beside it, so the
  queue job settles instead of burning its whole retry budget on a config error
  no retry can fix. The admin test-send and Mail-Tester routes return 400 with
  the same detail (naming whether the offending name came from a template's
  `providerOverride` or from config) instead of a 500 that named
  `defaultProvider` even when a template override was at fault. Mail-Tester
  also resolves the provider before `provisionCheck()`, which was spending a
  paid credit on a request that could never have completed.

- **`hasOpenedExcludingBots`, `hasClickedExcludingBots`, `openedAtLeastN` and
  `clickedAtLeastN` will now return lower numbers.** They did no filtering
  whatsoever. The `opened` branch of the shared counter incremented before the
  bot check ever ran, so `hasOpenedExcludingBots` was identical to
  `hasOpened`; and nothing in the package had ever written
  `clickedLinks[].userAgent`, the only field the click branch inspected, so
  every click scored human too. Both endpoints now record the requesting
  User-Agent (truncated to 256 chars) and both predicate paths apply the same
  pattern.

  A send counts if **any one** of its opens or clicks looks human — a scanner
  that prefetches ahead of the recipient does not disqualify a send the
  recipient also read. **A missing User-Agent counts as human**, deliberately:
  image fetches frequently carry none and Apple Mail Privacy Protection strips
  identifying headers, so scoring unknown as bot would silently discard a large
  share of genuine engagement. The cost is that a scanner sending no UA still
  counts; forgery is what the URL signature below is for, and this filter's job
  is only to be honest about scanners that identify themselves.

  **Existing installs:** this changes automation behaviour, not just reporting.
  Sends recorded before this release carry no User-Agent and therefore still
  all count as human, so nothing is reclassified retroactively and no running
  flow is retroactively emptied — but from the first send after upgrading,
  flows branching on these predicates will take the other path more often and
  engagement segments will shrink. If a flow was tuned against numbers that
  were really unfiltered `hasOpened`, revisit its thresholds.

  Tunable via the new `botFilter` config:

  ```ts
  import { DEFAULT_BOT_UA_RE } from 'mailery'

  botFilter: {
    // replaces the default outright — compose with DEFAULT_BOT_UA_RE to extend it
    userAgentPattern: new RegExp(`${DEFAULT_BOT_UA_RE.source}|AcmeScanner`, 'i'),
    minOpenDelayMs: 0, // default; opens landing this soon after queuedAt are prefetches
  }
  ```

  `minOpenDelayMs` is off by default because it has a real false-positive tail
  (a recipient already reading their inbox when the mail lands) and because
  turning it on silently moves the numbers every existing flow branches on.
  `10000` is the value worth trying first if your open counts look implausible.

- **`NullProvider.verifyWebhook()` returns `false`.** It returned `true`
  unconditionally. The provider holds no signing key, so it can never establish
  that a payload is authentic, and a method whose entire job is to reject
  unauthenticated input must not answer "yes" by default — least of all in the
  dev and staging configurations where that is easiest to miss.
  `RecordingProvider` delegates, so it inherits this.

  **Existing installs:** nothing is lost at runtime — `parseWebhookEvents()`
  returns `[]`, so there was never any inbound behaviour to preserve — but a
  local setup that POSTs unsigned bodies at `/m/webhooks/null` to exercise the
  ingest path will now get 401. Use a provider that actually signs.

- **Non-`http(s)` hrefs are no longer click-rewritten.** `shouldSkipClickRewrite`
  named `mailto:` and `tel:` explicitly; it now skips anything that is not an
  absolute `http:`/`https:` URL, which covers those two plus a `javascript:`
  or `data:` URL that arrived through a substituted Handlebars variable. Such a
  link is left exactly as authored, gets no `linkId`, and is never stored on
  the send. A malformed href is skipped rather than thrown on — one bad
  variable must not fail the render and block the whole send.

### Fixed

- **Tracking URLs are now signed, so opens and clicks can't be forged.** A
  tracking URL identified its send by bare ObjectId, which is four bytes of
  timestamp, five bytes constant per process and three bytes of sequential
  counter — so one tracking URL out of one received email largely predicts its
  neighbours. That is not merely a reporting problem: `hasOpened`,
  `hasClicked` and `openedAtLeastN` are flow inputs, so forged opens advance
  real people through real automation and fire real follow-up mail.

  Every generated tracking URL now carries a 12-character truncated HMAC over
  its own path components, keyed with `unsubscribeSecret` (so there is still
  exactly one secret to provision and rotate) and scoped to `open` or `click`
  so neither replays as the other:

  ```
  /m/open/<sendId>.<sig>.png
  /m/click/<sendId>/<linkId>/<sig>
  ```

  Signing is automatic and needs no configuration. What is configurable is how
  the endpoints treat the unsigned URLs sitting in mail you have already sent —
  and that is the whole compatibility design, not a migration step, because
  that mail will keep being opened for years:

  - a signature that is **present and wrong** is rejected, always, in both
    modes. Grace covers "this URL predates signing", never "this URL was signed
    by someone without the key";
  - a **missing** signature is accepted while `requireSignedTrackingUrls` is
    `false` (the default) and logged at `info` as
    `mailery: unsigned tracking URL accepted — legacy grace mode`. That line is
    the instrument: watch the legacy rate decay to nothing, then set the flag
    to `true`;
  - URLs **do not expire** by default. A legitimate open six months later is
    real data, and the signature rather than a deadline is what proves
    possession. `trackingUrlLifetimeDays` sets a window if you have a retention
    policy; because the deadline is derived from the send's `queuedAt` rather
    than baked into the token, changing it takes effect immediately for mail
    already delivered and costs no URL bytes.

  Rejections are response-identical to ordinary traffic — the pixel still
  returns its 200 PNG and a rejected click 404s exactly like an unknown send —
  because any distinguishable response is an enumeration oracle.

- **A rejected promise in a public route could take down the host
  application.** None of the six public routes had async error handling, so any
  rejection was an unhandled rejection; under Node's default
  `--unhandled-rejections=throw` that is an unauthenticated denial of service
  against the whole host process. All six are now wrapped in a log-and-swallow
  handler: a rejection before headers are sent becomes a plain 500, and one
  after (these routes answer first and work second, by design) is logged and
  swallowed rather than forwarded to `next(err)` — forwarding hands it to a
  host error handler likely to attempt a second response, which is the
  `ERR_HTTP_HEADERS_SENT` crash being avoided.

- **Webhook provider lookup resolved `Object.prototype` members.**
  `/m/webhooks/:provider` indexed a plain object with a request-path segment,
  so `/m/webhooks/constructor` returned something truthy, sailed past the
  `if (!provider)` guard and reached `.verifyWebhook(...)` as a non-provider.
  Lookups now go through a shared helper that gates on both `Object.hasOwn`
  and a shape check — either alone is incomplete — and unknown names 404
  before anything is called. The same helper is applied to the three other
  lookups (runner, admin test-send, Mail-Tester), which take their names from
  the database rather than a request path and so were never exploitable the
  same way; there the defect was that they failed incomprehensibly.

- **Click tracking redirected to the stored URL without validating its
  scheme.** `applyTracking` harvests hrefs from *rendered* HTML — after
  Handlebars substitution — so a template variable in href position could put
  an arbitrary scheme into storage and then be redirected to from the sending
  domain's own origin, with the sender's reputation behind it. The redirect
  now allowlists `http:`/`https:` (parsed with `new URL()`, so `JavaScript:`
  and `java\tscript:` normalise to the same rejection, and a protocol-relative
  `//evil.com` fails to parse), which also covers links already in storage. A
  blocked click returns **400** with a static body — the rejected URL is
  logged but never echoed back — and **is not counted**.

- **SendGrid webhook signatures had no replay window.** The signature check was
  correct and already failed closed without a key, but nothing checked
  freshness, so a captured signed payload replayed indefinitely. SendGrid signs
  `timestamp + body`, so the timestamp was already present and already covered
  by the signature. New `webhookToleranceSeconds` on `SendGridProvider`,
  default **300** seconds, symmetric (rejecting implausibly-future timestamps
  too, since clock skew cuts both ways); `0` or `false` disables the check.
  `Mailer.fromEnv` reads `MAILER_SENDGRID_WEBHOOK_TOLERANCE`. A malformed value
  falls back to the default rather than reading as "disabled" — a config typo
  must not silently reopen the window. The signature is verified *before*
  freshness, so an unauthenticated caller learns nothing about server clock
  state, and a rejection is the same bare 401 a bad signature gets.

  **Existing installs:** this is on by default. **A host whose proxy, ingress
  or queue can delay webhook delivery past five minutes will start seeing
  events rejected** — widen the window (`webhookToleranceSeconds: 900`) or, if
  the delay is unbounded, disable it and keep the signature check.

- **`mailery setup-sendgrid` and `setup-dmarc` threw in the published bundle,
  and DMARC ingest was broken for every ESM consumer.** `parseDmarcReport`
  lazy-loaded `fast-xml-parser` with `require()`, and `src/cli/cloudflare.ts`
  required `psl` inside a synchronous function. The package is
  `"type": "module"`, so tsup compiled both to esbuild's `__require` shim,
  which throws unconditionally. Every DMARC ingest path was dead for an ESM
  consumer — admin upload, CLI and inbound alike — and both CLI setup commands
  threw on zone inference whenever `--cloudflare` was used without an explicit
  `--cloudflare-zone`. Both are now static imports; `__require` is absent from
  `dist/index.js` and `dist/cli.js` entirely. `adm-zip` stays lazy, since
  `extractDmarcXmls` is already async and its `await import()` is correct in
  both output formats.

  **This shipped in v0.14.0.** If you hit either, you were not doing anything
  wrong. The test suite never caught it because tests import from `src/`, where
  the `require` is a real CommonJS require; there is now a regression test that
  runs the built bundle in a separate node process and POSTs a real gzipped
  report over a socket, because node's loader is precisely what the old test
  path could not exercise.

### Added

- **`logger` on `createPublicRouter`.** A pino-style structured logger
  (`logger.error(fields, msg)`; `warn` and `info` optional) for public-route
  failures, replacing scattered `console.error` calls. Defaults to a
  console-backed logger reproducing the previous output, so hosts that pass
  nothing see no change. Pass `{}` to silence it entirely.

- **An opt-in inbound DMARC route**,
  `createPublicRouter(mailer, { dmarcInbound: { secret } })`, for SendGrid
  Inbound Parse and equivalents, so RUA reports ingest as they arrive instead
  of being uploaded by hand. It reuses the existing parser (decompression caps,
  declared-vs-actual size checks, compression-ratio check, zip-slip guard)
  rather than adding a second one.

  **It is off unless you set that secret — no secret, no route registered, so
  it cannot appear on an upgrade.** Read why before enabling it: **SendGrid
  Inbound Parse does not sign its payloads.** The Event Webhook does and
  mailery verifies that; Inbound Parse is a different product with no
  signature, no HMAC and no verifiable identity. There is nothing to verify, so
  auth is a shared secret compared in constant time — as a basic-auth password
  embedded in the destination URL (recommended; unlike a path secret it stays
  out of every access log between SendGrid and you) or as
  `Authorization: Bearer`. It is checked *before* multer reads a byte, so an
  anonymous caller cannot make the process buffer 10 MB. An IP allowlist was
  rejected as the primary control: SendGrid publishes no stable Inbound Parse
  egress range, and `req.ip` is the proxy's address unless the host set
  `trust proxy`, which a library cannot verify. Reports are additionally gated
  on `policy_published.domain` matching a domain you send from, so a leaked
  secret buys exactly one capability — rows about domains you already send
  from. Options: `path` (default `/inbound/dmarc`), `maxFileSizeBytes`
  (default 10 MB), `maxFiles` (default 10), `allowedDomains`, `parseInbound`.

  **Existing installs:** if you followed the old advice and pointed Inbound
  Parse at `/admin/mailer/api/dmarc/upload`, it never worked — that route sits
  behind your `requireAdmin` guard, which Inbound Parse cannot satisfy. If it
  *did* appear to work, check that the guard is actually applied to your admin
  router. The docs recommended this before 0.15 and were wrong.

- **`FlowStep` `webhook.url` is documented as never templated.** No behaviour
  change; it never was rendered. Rendering contact or event data into that
  field would hand the destination of an inside-the-perimeter `fetch` to
  whoever controls the template data. The zod schema validates shape only and
  is quite happy with `http://169.254.169.254/`. Recorded as INVARIANT 16 and
  17, with comments at the fetch site and on the schema.

- New exports: `signTrackingToken`, `verifyTrackingToken`,
  `TRACKING_SIG_LENGTH`, `TrackingScope`, `TrackingTokenParams`,
  `DEFAULT_BOT_UA_RE`, `drainPendingUnsubscribes` (+ its option and result
  types), `sendgridInboundParser`, `DmarcInboundOptions`, `InboundAttachment`,
  `InboundParser`, `RouteLogger`, `BotFilterConfig`.

- `mailer_sends.opens[]` — per-open `{ openedAt, userAgent }`, capped at the 50
  most recent so a repeatedly re-opened mail can't grow a send document toward
  the 16 MB limit. `clickedLinks[]` entries gain `userAgent`. Absent on
  documents written before this release.

### Dependencies

- **Production advisories 36 → 0.** No `resolutions` were needed for any of
  them: every vulnerable transitive's parent already declared a range admitting
  the patched version, and the lockfile was simply holding stale pins, so
  stripping those blocks and re-resolving within the existing ranges was
  enough — and is strictly better than pinning, since nothing in
  `package.json` can then mask a future direct dependency's real range. Direct
  bumps: `mjml` `^5.2.0 → ^5.4.0`, `multer` `^2.1.1 → ^2.2.0` (a direct
  production dependency with two advisories), and `adm-zip` `^0.5.17 → ^0.6.0`
  (hygiene — `dmarc.ts` checks each entry's declared size against a 50 MB cap
  before `getData()`, so the advisory was never reachable here). `adm-zip`
  0.6.0 bundles its own types, so `@types/adm-zip` is removed rather than left
  as a 0.5.x type package beside a 0.6.0 runtime. Remaining `yarn audit`
  findings are dev-only; `express` appears there only as a devDependency, and
  in production it is a peer whose transitives are the host's to patch.

- **`@maily-to/core` moved to `devDependencies`, dropping the production tree
  524 → 351 packages.** It is imported only by `src/client` — the admin SPA —
  which vite compiles into `dist/admin/spa` and ships prebuilt with no
  externals, so consumers never resolved it from `node_modules`; it is already
  inlined in the JavaScript they download. Everyone installing mailery was
  fetching its Tailwind/PostCSS subtree for nothing. **Invisible to consumers:**
  no API change and the built bundle is byte-identical.

### Contributors

Dev tooling moved to vitest 4 / vite 7 (clearing the last dev-only advisories,
including a critical one in the vitest UI server; full-tree audit 13 → 0), and
the test suite's roughly-two-in-five random failure is fixed — it was ~20-26
concurrent `mongod` processes, not memory, so worker fan-out is capped at 4 and
the timeouts raised past the harness setup cost. Vite stops at 7 deliberately:
8 swaps Rollup and esbuild for Rolldown and Oxc, and this package publishes a
built admin SPA. None of this affects consumers.

## 0.14.0 — Stop HTML-escaping the text/plain part

### Fixed

- **The text/plain alternative was compiled with HTML escaping on, so any
  substituted URL arrived at the recipient with its query string in pieces.**
  `renderTemplate` ran `template.body.plainText` through the same Handlebars
  instance as the HTML body. In the HTML body that escaping is correct — the
  browser decodes `&amp;` and `&#x3D;` back out of an `href`. Nothing decodes
  the text part: mail clients render it literally. A template line as ordinary
  as `Read it here: [{{topicUrl}}]` shipped as
  `...?u&#x3D;123&amp;token&#x3D;abc`, and following that link splits the query
  on every `&` inside the entities, so the first parameter comes through empty
  and every parameter after it is lost to a junk key (`amp;token`, `#x3D;abc`).

  Any URL parameter in a text part was affected, but signed links are where it
  does real damage. A passwordless sign-in URL reached the app carrying no
  credential at all, which does not read as a broken link — it reads as no link.
  A host that no-ops when the credential is absent then serves the page under
  whatever session the browser already had, so the recipient lands on the right
  deep link signed in as the wrong user, with no error anywhere and nothing in
  the logs. Click tracking hid it in the common case: tracked HTML links are
  rewritten to `/m/click/...` and redirect from the decoded URL stored on the
  send, so only the text part — and untracked sends — carried the damage.

  The text part now compiles with `noEscape`. Subject and preheader keep their
  escaping: the preheader is injected into the HTML body, and subjects reach
  HTML surfaces that render them.

  **Existing installs:** already-delivered mail is not repaired by upgrading.
  Links in the HTML part were always fine; links a recipient follows from the
  text part of mail sent before this release stay broken. Hosts that resolve a
  credential from the query string should refuse a damaged one rather than
  ignoring it, so a mangled link fails visibly instead of quietly resolving to
  the live session.

## 0.13.0 — Per-webhook SendGrid event webhook setup

### Fixed

- **`mailery setup-sendgrid` configured the event webhook through SendGrid's
  legacy single-webhook API, so it could not share an account with anything
  else.** `GET`/`PATCH /v3/user/webhooks/event/settings` present the account as
  if it held exactly one event webhook; a PATCH there repoints whichever webhook
  is oldest by `created_date`. One SendGrid account serving two mailery
  instances — separate products, or staging beside production — is an ordinary
  setup, and under that view the instances were invisible to each other. Without
  `--force` the CLI threw on any account that already had a webhook, after
  domain authentication had already run, leaving setup half-finished. With
  `--force` it repointed the other instance's webhook, and that failure is
  silent on the far side: nothing errors, the old endpoint simply stops being
  called, so bounces, spam reports and unsubscribes stop ingesting there and the
  suppression list quietly freezes while that app keeps mailing addresses which
  already hard-bounced or complained.

  Setup now reads `/settings/all`, matches on the URL you passed, and either
  updates that webhook by `id` or creates a new one alongside the existing
  entries — every other webhook on the account is left untouched. The
  verification key comes from `/settings/signed/{id}`, so each instance gets its
  own key rather than an account-wide one. Accounts that don't expose the
  multi-webhook endpoint fall back to the previous singleton behaviour.

  Nothing changes at runtime: `SendGridProvider({ webhookVerificationKey })`
  already took a single key per instance, and each instance verifies only its
  own webhook. **Existing installs:** re-running the CLI adopts the webhook
  matching `--webhook-url` and rewrites nothing else. Keys are per-webhook and
  not interchangeable, so set `SENDGRID_WEBHOOK_VERIFICATION_KEY` per
  environment from that run's output.

- **`--force` no longer means "repoint whatever is there, whoever owns it."** On
  accounts with the multi-webhook API it is unnecessary — a webhook for a
  different URL is never rewritten — and the CLI says so. On legacy
  single-webhook accounts it keeps its old meaning, and both the refusal message
  and the `--force` warning now spell out that the previous consumer stops
  receiving events.

### Added

- **`--webhook-name`** sets `friendly_name` on a webhook mailery creates
  (default `mailery <host>`), so a human looking at the SendGrid dashboard can
  tell which app owns which webhook.
- `setupSendgrid()` returns `webhookId` — SendGrid's id for the webhook it
  configured, absent on legacy single-webhook accounts.

## 0.12.1 — Agenda queue retention and namespacing

### Fixed

- **The Agenda driver retained every job document forever.** Agenda defaults to
  `removeOnComplete: false` and mailery never overrode it, so `_mailerJobs` grew
  by one document per send, advance, and webhook indefinitely — in the same
  database as your operational data. Succeeded one-shot jobs are now removed on
  completion, and failed ones (which Agenda's auto-remove never touches) are
  swept hourly on a 7-day window, matching the Bull driver's `removeOnFail`.
  `failedJobRetentionDays: 0` disables the sweep. Jobs awaiting a retry, jobs
  under an active lock, and repeating jobs are all spared — the tick is a single
  document whose `nextRunAt` is recomputed in place and was never a source of
  growth.

  This is the Agenda counterpart to the Bull retention fix in 0.11.0. The other
  half of that fix does not apply here: the driver's pending-job lookup already
  excluded finished jobs, so a completed document never suppressed a
  `jobId`-based re-add.

  **Existing deployments:** already-stored completed jobs are not removed
  retroactively. See the [queues guide](https://jeffjassky.github.io/mailery/guide/queues)
  for the one-time `deleteMany` to reclaim that space.

### Added

- **`MAILER_QUEUE_PREFIX` now applies to the Agenda driver**, suffixing the jobs
  collection (`_mailerJobs_prod`) the way it prefixes Redis keys under Bull, so
  several mailery instances can share one Mongo database. With no prefix the
  collection name is unchanged, so upgrading strands nothing. Prefixes are
  restricted to letters, digits, `_` and `-`; `collectionName` still sets the
  name outright.

## 0.12.0 — Link and image lint rules

### Added

- **Four new content-linter rules, all warnings — none block publish.**
  `offdomain_links` fires when more than half a body's resolvable links
  point away from the `fromEmail` domain; link domains that match the
  sending domain are what build reputation, and a body pointing mostly
  elsewhere reads like a forwarded template. Hostname matching is loose on
  purpose (exact, subdomain either direction, or a shared last-two-label
  suffix), so `mail.example.com` and `www.example.com` count as one site —
  a false off-domain warning costs the operator more than a missed one.
  Merge-tag hrefs, `mailto:`, and relative URLs are skipped.

  `insecure_link` flags `http://` hrefs. This is a scheme check only —
  liveness (200 vs 404) needs network I/O and stays out of the pure lint
  pass. `image_missing_alt` and `image_only_link` cover the images-blocked
  case: most clients hide images on first open, so an image with no alt
  text is invisible and an image-only call-to-action is unclickable.

## 0.11.0 — Plain-text-only templates

### Added

- **`bodyFormat` on templates: `'multipart'` (default) or `'text_only'`.**
  A text_only template sends its plain-text part alone — no HTML part at all —
  for mail that should read as if a person typed it rather than as a designed
  message. Settable per template in the editor (Body format), or via the
  template update API.

  The trade is deliberate and total: **a text_only send records no opens and
  no clicks.** The open pixel needs an HTML part to live in, and click
  rewriting is skipped on purpose — swapping readable URLs for opaque
  `/m/click/...` redirects in text a recipient reads literally would undo the
  reason to choose this format. Engagement-driven features (open-based
  sunsetting, click predicates) therefore see nothing from these sends; use
  multipart where that data matters.

  Existing templates are unaffected — the field is optional and absent
  documents behave exactly as before. `SendArgs.html` is now optional, and the
  SendGrid provider omits the key entirely rather than sending an empty part.
  Test sends and Mail-Tester checks from the editor match the real wire shape.

## 0.10.2 — Heartbeat visible from the web process

### Fixed

- **The dead-workers banner never showed in a web/worker split.** The
  `workers_heartbeat` setup check was skipped whenever the process was
  `workerless` — but in a split deployment the workerless web process is the
  one serving `/admin/mailer`, so the operator's dashboard reported a clean
  bill of health while the tick could be hours dead. The heartbeat lives in
  Mongo, which both processes share, so the check now runs regardless of
  `workerless`; only the wording changes ("workers run in another process…").
  A missing heartbeat doc stays a warn, not an error — a fresh install
  legitimately has none yet.

## 0.10.1 — Waits hold

### Fixed

- **A flow whose first step is a `wait` could skip it.** The schedule was
  enforced only by the callers — the sweep's `nextActionAt <= now` filter and
  the advance job's delay — so the sweep could select a run while it was due,
  have the run's own advance job park it on a wait in the meantime, and then
  process the step AFTER the wait. This was reachable on every tick: a freshly
  triggered run is inserted with `nextActionAt = now`, and `runTick` runs the
  trigger scan and the sweep back to back. A win-back flow opening with
  "wait 4 days" would send its first mail immediately on entry.
  `processOneRunStep` now refuses to act on a run parked in the future
  (1s skew tolerance), so the schedule holds regardless of caller.

## 0.10.0 — Per-scope flow runs

One contact, several of the same thing (accounts, workspaces, orders), one
series each. Fire the trigger with a scope-qualified `dedupeKey` and
`once: false`, and each scope gets its own run; the additions below let those
runs be cancelled independently and branch on their own context.

### Changed

- **`fire_event` steps now inherit the triggering event's properties.** A
  step's `properties` are authored once in the flow definition, so a fired
  event could previously only say "this contact" — it lost whatever scope the
  originating event carried, leaving the receiving flow with nothing to
  resolve variables against. The run's `triggerEvent.properties` are now
  merged in underneath; explicit `step.properties` still win on conflict.

  This applies to **every** flow, not only scoped ones. Downstream flows and
  any host matching on fired-event properties will see additional keys. If a
  host depends on fired events carrying exactly the authored properties,
  review those handlers before upgrading.

### Added

- **`abortFlow(..., { matchTriggerProperties })`.** Restricts an abort to runs
  whose trigger event carried the given properties, so a host whose subject is
  an account but whose contact is a user can end one account's series while
  that person's other accounts keep running:

  ```ts
  await mailer.abortFlow('trial-onboarding', userId, {
    reason: 'upgraded',
    matchTriggerProperties: { accountId },
  })
  ```

  Omitting it keeps the previous behaviour (abort every active run for the
  contact on that flow). Keys must match `^[A-Za-z0-9_]+$` and values must be
  primitives — these go into a Mongo query, and an object value such as
  `{ $ne: null }` would otherwise reach it as an operator and match every
  scoped run. The scope is recorded in the audit log so a scoped abort is
  distinguishable from an abort-all.

- **`triggerPropertyEquals` / `triggerPropertyTruthy` predicates.** Gate a
  condition or branch on a property of the event that started the run rather
  than on contact state:

  ```ts
  { type: 'condition', test: { triggerPropertyTruthy: 'wasReferred' }, ifFalse: 'continue' }
  ```

  Use these when the gate depends on what the run is *about* instead of a
  durable trait of the person. A tag is shared by every concurrent run for
  that contact, so the last writer wins and branching silently changes in runs
  already in flight; a trigger property is fixed per run.

  The flow editor's value inputs for `triggerPropertyEquals` and `fieldEquals`
  now coerce `true`/`false`/`null`/numeric text to typed values — the
  evaluator compares with strict `===`, so a string-only input could never
  match a typed property like `isPremium: true`. The literal string `"true"`
  is still authorable via the raw JSON editor.

## 0.9.0 — Redis queue prefix

### Added

- **`queue.prefix` for the Bull driver.** All mailery Redis keys (queues,
  workers, the repeating tick scheduler) are namespaced under the prefix, so
  multiple mailery instances can share one Redis cluster without seeing each
  other's jobs — typically one prefix per environment
  (`mailery-dev` / `mailery-prod`):

  ```ts
  queue: { driver: 'bull', redis: { url }, prefix: 'mailery-prod' }
  ```

  `Mailer.fromEnv` reads it from `MAILER_QUEUE_PREFIX`. Prefixes containing
  `:` (BullMQ's key separator) are rejected at init. Changing an instance's
  prefix orphans jobs under the old one — drain first, as with a driver swap.

## 0.8.1 — Queue and scheduling correctness

A full review of the queue drivers and runner turned up a set of scheduling and
concurrency defects. All are fixed here; no API changes.

### Fixed

- **Event triggers could be skipped permanently.** The trigger scan
  watermarked on `occurredAt`, so an event committed "in the past" — an
  outbox-drained `fireFromSession` event carrying its host-transaction
  timestamp, or a `fire()` racing an in-flight scan — fell behind the watermark
  and never started its flow. The scan now watermarks on `createdAt` with a
  30-second overlap window, deduped by a unique partial
  `(flowId, triggerDedupeKey)` index on flow runs.
- **Webhook events could be applied more than once.** Concurrent webhook
  workers scanned the same unprocessed batch, double-counting opens, clicks,
  bounces and complaints — inflated bounce rates could trip the circuit
  breaker. Workers now claim each event atomically before applying.
- **Crash recovery could deliver an email twice.** The stranded-send sweep and
  the queue's stalled-job retry can both fire a job for the same send, and the
  status check was read-then-act. `dispatchSend` now claims the send
  atomically; exactly one dispatcher proceeds.
- **A large broadcast froze the tick for its whole duration.** Recipient
  enqueue ran inline in the single-concurrency tick, starving trigger scans and
  sweeps for hours on big segments. Dispatch now runs as a queue job (inline
  under the `noop` driver, which has no workers), heartbeats progress, and a
  new tick-side sweep resumes broadcasts whose dispatcher died — resumption is
  idempotent via per-recipient dedupe keys.
- **Agenda driver: ticks could be silently swallowed.** `Mailer.init` started
  Agenda with a placeholder no-op tick handler; a process that never called
  `startWorkers` (an API-only process in a web/worker split) locked and
  completed real tick jobs doing nothing. Agenda now starts only in
  `startWorkers`, after the real handlers are defined.
- **BullMQ: completed and failed jobs accumulated in Redis forever.** Queues
  now set bounded retention (`removeOnComplete`: 24 h / 1000 jobs,
  `removeOnFail`: 7 days). This also un-poisons jobId-based idempotent re-adds
  that were dropped against stale completed jobs.
- **Delayed wake-ups could collide across branches.** Advance jobIds used
  `(runId, stepIndex)`, but `currentStepIndex` resets to 0 on branch entry, so
  a wait step inside a branch could be deduped against an earlier step's
  completed job and stall until the sweep rescued it. JobIds now include the
  branch path.
- **Agenda driver: a custom `collectionName` broke queue counts and dedupe.**
  Internal reads hardcoded `_mailerJobs` regardless of the configured name,
  so `getWaitingCount` returned 0 (disabling broadcast backpressure) and
  jobId dedupe never matched.
- **Stranded webhook events are now drained by the tick.** If the queue add
  failed at ingest, webhook events sat unprocessed until the next webhook
  happened to arrive. The tick now applies rows older than 5 minutes.
- **`sendOneOff` no longer throws on a concurrent duplicate.** Two calls
  racing on the same `dedupeKey` returned E11000 to one caller; it now returns
  the winner's `sendId`.
- **Tracked link URLs with HTML entities decode correctly.**

### Changed

- **`respectRecipientTimezone` broadcasts: recipients east of the schedule
  timezone now get the next occurrence of the wall-clock slot** (same time
  next day) instead of a mistimed immediate send — delays can only push
  forward, and their local slot has already passed when dispatch starts.
  Per-recipient delays also anchor to `scheduledAt`, so backpressure pauses no
  longer drift later batches.
- **`bullmq` peer range narrowed to `^5.16.0`.** The driver has always called
  `upsertJobScheduler` (added in 5.16); the old `^5.0.0` range admitted
  versions that crashed at init.
- Two Mongo indexes are added automatically at init: `(name, createdAt)` on
  events and the unique partial `(flowId, triggerDedupeKey)` on flow runs.
  The unique index only applies to new runs (legacy docs lack the field), so
  existing deployments upgrade without migration.

## 0.8.0 — Test system, Mail-Tester `requireScore`

### Added

#### Three-tier end-to-end test system
- **Fast matrix** (`test/matrix`) — offline, real in-memory MongoDB, frozen clock. Systematic coverage of variable rendering (contact fields, `{{event.*}}`, step vars, `varsAdapter` root keys, `unsubscribeUrl`, built-in and host helpers), the html/plain-text pair and tracking rewrites, delivery windows (time-of-day slots and grace, weekday gating, contact-timezone resolution and fallback chain, DST edges), and the full flow lifecycle (every step type, abort, mid-flow unsubscribe, suppression, idempotency).
- **Real-clock gating** (`test/longhorizon`) — the same delivery gating with no fake clock, deriving expectations from the day it runs on.
- **Live SendGrid tier** (`test/live`) — provider-adapter axes against the real API, gated on `MAILERY_LIVE_E2E`. Sandbox by default (real auth and payload validation, nothing delivered); the deliver path reads the message back over Gmail IMAP to confirm the multipart/alternative, headers, unicode subject and link handling survive.
- **Scheduled workflow** (`.github/workflows/live-e2e.yml`) — hourly and weekend crons so the real calendar supplies the axes that cannot be compressed, plus a `libfaketime` job for multi-day waits.

#### `mailery/testing` additions
- `buildTemplate(spec)` / `buildFlow(spec)` and the `step` shorthands — every required document field defaulted, so a fixture states only what it asserts on.
- `drain(ctx, opts?)` and `harness.drain()` — run the runner to quiescence instead of hand-sequencing `runTick` / `processOneRunStep` / `dispatchSend`.
- `RecordingProvider` — wraps any provider, records every `SendArgs`; the harness always applies it, so `provider.sent` works whether you run against `NullProvider` or real SendGrid.
- Harness helpers `seedContact`, `seedTemplate`, `seedFlow`, `ctx`, plus `provider: 'null' | 'sendgrid' | MailProvider`, `queue` and `startWorkers` options.

#### Mail-Tester `requireScore`
- `mailTester.requireScore` (default `false`) — when `true`, publishing content that has never been scored is blocked, not just content already known to score below `minScore`. Without it, any edit changed the content key, missed the cache and published freely.
- The `mail_tester_blocked` response carries a `code` distinguishing "scored too low" from "never scored", with the matching next step in `hint`.
- `GET /api/templates/:slug/mail-tester-status` returns `requireScore`; the editor warns when publish is gated on an unscored body.

### Changed
- **`List-Unsubscribe` is sent on marketing mail only.** The unsubscribe token is scoped `marketing`, so advertising one-click unsubscribe on a transactional send misrepresented the header and offered an opt-out that would not stop the mail in question.
- Admin client errors now surface the server's `message` and `hint` instead of the bare status line, so a refused publish explains itself.

## 0.7.0 — Flow abort primitives

### Added
- `mailer.abortFlow(flowSlug, externalId, { reason })` and `mailer.abortAllFlows(externalId, { reason })` — exit active runs immediately, including runs parked in a `wait`, and cancel the flow's queued or retrying sends so an abort means no further mail rather than just no further steps. Both are no-ops when nothing is active, and a dispatch-time guard closes the race where a send was enqueued between the cancellation sweep and dispatch.

### Fixed
- Linter no longer reports a false `missing_plain_text` on script-seeded templates.

## 0.6.0 — Host variables, delivery windows, event-scoped flows

### Added

#### Host variables (`varsAdapter`)
- `defineVars({ schema, resolve })` — declare a zod schema + resolver in `Mailer.init({ varsAdapter })`; resolved keys land at the template-context root (`{{user.name}}`, `{{firstActiveTopic.title}}`). Return type checked against `z.infer<schema>`.
- Resolver runs at dispatch time per send; a throw marks the send `failed` and lets the queue retry — a half-rendered email never goes out.
- `GET /api/vars-schema` — the schema as JSON Schema + built-in context keys.
- Linter rule `unknown_variable` (warning) — `{{paths}}` in subject/preheader/MJML/editorJson checked against the schema; helper args validated, `{{#each}}`-relative paths and open shapes skipped.
- Admin editor: `{{` autocomplete in subject/preheader, Variables sidebar card (click-to-copy), both driven by the schema.
- Reserved keys (`contact`, `vars`, `event`, `unsubscribeUrl`, …) rejected at `Mailer.init`.

#### Real-contact preview + test sends
- `POST /api/templates/:slug/preview` accepts `contactId` — renders as a real contact through the adapter with resolved host vars; preview modal cycles contacts with ←/→.
- `POST /api/templates/:slug/send-test` accepts `contactId` — renders with that contact's data, delivers to the typed address.
- Both accept `eventProperties` to simulate a trigger event.

#### Delivery windows
- `delivery` on flow `send` steps: `weekdaysOnly` (Sat/Sun slot → Monday), `timeOfDay: 'HH:mm'` (next local slot, 1-hour grace for tick jitter), `useContactTimezone` + IANA `timezone` fallback (default UTC). Pure Intl math, no new dependency.
- Runner parks the run (`send_deferred` history action) and re-fires when the window opens; suppression/breaker/subscription still checked at actual send time.
- Flow editor UI for the window fields.

#### Event-scoped flows
- Flow runs snapshot the triggering event (`triggerEvent: { name, properties, occurredAt }`).
- Templates read `{{event.*}}`; `varsAdapter.resolve` receives `info.eventName` / `info.eventProperties` / `info.flowSlug` to scope lookups (account/topic flows for users in many accounts).

### Fixed
- Live lint no longer reports `missing_plain_text` (and friends) for script-seeded / MJML templates: the editor stops sending its placeholder empty Maily doc for non-Maily templates, and the lint endpoint falls back to the stored `body.html` / `body.plainText` when the draft has no compilable source.
- Save-draft/publish on a non-Maily template no longer risks clobbering the body with an empty Maily doc — the draft carries the MJML source forward instead.

### Docs
- New guide sections: Templates → Host variables, Flows → Event parameters, Flows → Delivery windows; reference updates for the new endpoints and step fields.

## 0.1.0 — Phase 0 spike

**First working release.** End-to-end pipeline from `mailer.fire()` to a delivered email is functional.

### Added

#### Public API
- `Mailer` class with `init()` / `fromEnv()` / `startWorkers()` / `stop()`.
- `mailer.fire()` + `mailer.fireFromSession()` (outbox-based for Mongo transactions).
- `mailer.registerEvent()` + auto-derived `dedupeKey` from policy (`once-per-contact`, `once-per-day`, `every-time`).
- `mailer.upsertSubscription()`, `mailer.unsubscribe()`, `mailer.tag()` / `untag()`, `mailer.suppress()`.
- `mailer.forget()` (GDPR right-to-erasure with hashed-suppression retention).
- `mailer.exportContactData()` (GDPR data export).
- `mailer.sendOneOff()` for ad-hoc transactional sends.
- `mailer.audit()` helper for direct-DB scripts.

#### Adapters / providers
- `MongoContactAdapter` (reads + optional narrow tag writes).
- `MemoryContactAdapter` (test-only, in-process).
- `SendGridProvider` with webhook signature verification + event normalization.
- `NullProvider` for tests.

#### Templates
- `compileTemplate()` (MJML → HTML), `derivePlaintext()`, `renderTemplate()` (Handlebars).
- `applyTracking()` rewrites `<a href>` to `/m/click/:sendId/:linkId` + appends open pixel.
- Handlebars helpers: `eq`/`ne`/`gt`/`lt`/`and`/`or`/`not`, `formatDate`, `formatNumber`, `formatCurrency`, `pluralize`.

#### Runner
- Flow state machine with all `FlowStep` types (`wait`, `condition`, `branch`, `send`, `tag`, `fire_event`, `webhook`, `exit`).
- Trigger scan (event-only V1), recovery sweep, outbox drain.
- Predicate evaluator covering `hasTag`, `fieldEquals`, `hasFiredEvent`, `subscriptionStatus`, `hasOpened` / `hasClicked` (with bot-filtered variants), `all`/`any`/`not`.
- Send pipeline: idempotent (dedupeKey-gated) Send row creation → BullMQ enqueue → `dispatchSend` re-checks suppression + circuit breaker + applies tracking + calls provider.
- Optimistic-concurrency on `currentStepIndex` — two workers racing the same flow_run advance only one wins.
- Webhook event applier with hard-bounce / complaint / unsubscribe cascades into suppressions + subscription status.

#### HTTP routers
- `createPublicRouter(mailer)`: open pixel, click redirect, RFC 8058 one-click unsub (GET + POST, disk fallback for compliance even when Mongo is degraded), provider webhook ingest (signature-verified + deduped).
- `createAdminRouter(mailer)`: serves the prebuilt React SPA + REST endpoints (`/api/dashboard`, `/api/flows`, `/api/templates`, `/api/broadcasts`, `/api/contacts`, `/api/sends`, `/api/suppressions`, `/api/audit`, `/api/health`, `/api/me`).
- HMAC-signed unsubscribe tokens with 90-day default lifetime.

#### Client
- React 18 admin SPA, Vite-built, served as static assets from `dist/admin/spa/`. ~232 KB JS / 63 KB gzipped.
- 14 screens: dashboard, flows list/detail, templates list/editor, broadcasts list/composer, contacts list/detail, sends list/detail, suppressions, audit log, health.
- `src/client/lib/api.ts` + `useLive` hook ready for live-data wiring.

#### Storage
- TypeScript interfaces + `getCollections()` factory + `ensureIndexes()` across all 16 mailer-owned collections.
- Zod schemas for every public-API input.

#### Queue
- BullMQ + ioredis wiring for `mailer-tick`, `mailer-advance`, `mailer-send`, `mailer-webhook` queues.
- Per-provider rate limiter on the send worker (BullMQ group limiter).
- `redis: null` opt-out for queueless / test mode.

#### Tests
- 36 tests across 5 unit + 5 integration suites.
- `mailery/testing` exports `createTestMailer` (mongodb-memory-server-backed), `NullProvider`, `MemoryContactAdapter`.

### Known gaps (Phase 1+ roadmap)

- Circuit-breaker counters / auto-trip (manual override works).
- Soft → hard bounce promotion job.
- Broadcast streaming dispatch.
- Daily webhook reconciliation.
- Domain auth verification UI.
- Double opt-in flow.
- Maily WYSIWYG editor in the template editor.
- SPA screens still consume mock data; REST endpoints exist and `api.ts` is ready.

### Internals

- Build pipeline: tsup (ESM + CJS + .d.ts) + Vite (React SPA) → single `dist/` shipped in the npm tarball.
- Trusted-publishing release workflow on GitHub Actions (OIDC, no NPM_TOKEN).

## 0.0.1

Initial trusted-publish smoke release. Layout-only.

## 0.0.0

Hand-published smoke release.
