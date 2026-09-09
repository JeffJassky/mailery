# Agent API

The surface an automated caller — an AI agent, a CI job, a deploy script — uses to take an email program from "deployed" to "safely on" without a browser session. Mounted via `createAgentRouter(mailer, opts)`, authenticated with a bearer token, JSON in and out.

```ts
import { createAgentRouter } from 'mailery'

app.use('/admin/mailer/agent', createAgentRouter(mailer, {
  tokens: [{ token: process.env.MAILERY_AGENT_TOKEN!, actor: 'agent:claude' }],
  testContacts: /^qa\+.*@example\.com$/i,
}))
```

Mount it on a path your session middleware does **not** gate; the router does its own auth. Every request carries `Authorization: Bearer <token>`, and every mutation is audited under the token's `actor`.

## Options

```ts
interface AgentRouterOptions {
  tokens: Array<{ token: string; actor: string }>   // required; each token ≥ 24 chars
  testContacts?: RegExp | ((email: string) => boolean)
  logger?: RouteLogger
  mailTesterClient?: MailTesterClient                // passed through to the admin API
}
```

**`testContacts` is the safety boundary.** Real sends, event firing, run stepping, subscription changes and resets only apply to contacts whose email matches it. Without it those routes answer `403 test_contacts_not_configured` — the router never assumes a contact is disposable.

## Discovery

### `GET /`

```ts
→ { service: 'mailery-agent', version, actor, testContactsConfigured, docs, endpoints: [{ method, path, summary, testContactsOnly? }] }
```

Every route below is listed here, so a client can learn the surface from the surface.

## Admin API parity

### `* /api/*`

The whole [Admin REST API](/reference/admin-api) — flows, templates, contacts, sends, suppressions, health, setup-status, dashboard — is mounted under `/api` with the token's actor. Reads and existing operations need no second auth path.

Two admin routes changed alongside this API, for everyone:

- `POST /api/flows/:slug/publish` accepts `{ enable: false }` to promote a draft **without** turning the flow on.
- Any path that turns a flow on (`publish`, `resume`) now stamps `lastTriggerScanAt` when it is null. Until 0.16 a first enable replayed every matching event since the flow document was created.

## Templates

### `POST /templates/:slug/verify`

Render the **published** template as one contact and run named checks.

```ts
body: {
  contactId?: string            // a real contact through the adapter (varsAdapter runs, reason 'test')
  sampleContact?: Contact       // or an inline contact
  eventProperties?: object      // simulate a trigger event ({{event.*}}, resolver scope)
  vars?: object                 // per-send vars
  includeRendered?: boolean     // return the HTML and text (default: sizes only)
}
→ {
  ok: boolean,                  // no check failed
  template: { slug, kind, name },
  contact: { externalId, email },
  checks: [{ id, status: 'pass' | 'warn' | 'fail', detail? }],
  links: { total, sample },
  rendered: { subject, preheader, htmlBytes, textLength, fromEmail } | { subject, preheader, html, plainText, fromEmail, fromName, replyTo }
}
```

| Check | Fails when |
|---|---|
| `published` | the template has no published body |
| `vars_resolved` | the host `varsAdapter` threw |
| `render` | Handlebars or the template threw |
| `unresolved_placeholders` | any `{{…}}` survives in subject, preheader, HTML or text — `detail.placeholders` lists them |
| `unknown_variables` | a path the template references (`{{price.basic.monthly}}`) is absent from the render context — Handlebars renders it as an empty string, silently. `detail.missing` lists them; paths inside `#each`/`#with` blocks are not checked |
| `empty_variables` | warns when a referenced path exists but is `null` or `""` for this contact, or is a reserved key the package does not populate yet |
| `links_absolute` | an `href` is not absolute `http(s)://` (`mailto:` and `tel:` allowed) — `detail.invalid` lists them |
| `unsubscribe_link` | marketing only — the signed unsubscribe URL is not in the HTML |
| `sender_address` | marketing only, when `senderAddress` is configured — the postal address is not in the HTML |
| `plain_text` | the text part is empty (warns under 40 characters) |
| `subject` | empty (warns over 78 characters) |
| `from_domain` | `senderDomains` is configured and the From domain is not valid for the template's kind |
| `html_size` | warns over 102 KB, where Gmail clips |
| `lint` | the content linter has errors (warnings listed in `detail.warnings`) |

The unsubscribe URL in the render is real — signed for that contact with the configured secret — so a verification exercises the same token path a send does.

### `POST /templates/verify-all`

```ts
body: { contactIds: string[]; slugs?: string[]; eventProperties?: object }
→ { ok, templates, contacts, verified, failing, results: [{ slug, contactId, ok, failed: string[], warned: string[] }] }
```

Every template (or the listed slugs) for every contact. Twenty templates times three contacts is one call.

### `POST /templates/:slug/render`

```ts
body: { contactId?: string; sampleContact?: Contact; eventProperties?: object; vars?: object }
→ { template, contact, subject, preheader, fromName, fromEmail, replyTo, html, plainText, resolvedVars, unsubscribeUrl }
```

The rendered parts plus the resolved host variables, for a caller that wants to look rather than check.

### `POST /templates/:slug/send` — test contacts only

A **real** send: a `mailer_sends` row, tracking, the provider, webhook attribution — everything a flow send gets — to a test contact. The published body is used; tracking and the signed unsubscribe URL are applied exactly as in production.

```ts
body: { contactId: string; vars?: object; dedupeKey?: string; dispatch?: 'now' | 'queue' }
→ 201 { sendId, dedupeKey, dispatched, send: SendSummary }
```

`dispatch` defaults to `now`: the send is handed to the provider inline, so a workerless web process can still deliver a test. `queue` leaves it for the worker (or `POST /sends/:id/dispatch`). `dedupeKey` defaults to a fresh UUID; supply one to make a retried call idempotent — the same key returns the same `sendId`.

This is how an automated check proves delivery end to end: send, then wait.

### `PUT /templates/:slug`

Publish a compiled template document directly — the deploy-script path over HTTP.

```ts
body: {
  name: string; description?: string; kind: 'marketing' | 'transactional';
  fromName: string; fromEmail: string; replyTo?: string | null; providerOverride?: string | null;
  subject: string; preheader?: string;
  body: { html: string; plainText?: string; mjml?: string; editorJson?: object | null };
  variablesSchema?: object; tags?: string[]; bodyFormat?: 'multipart' | 'text_only';
  trackOpens?: boolean; trackClicks?: boolean; publishedBy?: string
}
→ 201 { slug, created: true, lint: { warnings, infos }, template }   // inserted
→ 200 { slug, created: false, … }                                     // updated in place
```

`POST /api/templates/:slug/publish` compiles a draft. A program authored as hand-built HTML has no draft, so until 0.16.5 its only way into `mailer_templates` was a direct database write with the production credential — the one credential an agent or a CI job should not hold. This route takes the published fields as JSON, runs the same sender-domain (`400 sender_domain_invalid`) and lint (`422 lint_failed`, with the `lint` report) gates publish runs, and upserts on slug. `plainText` is derived from the HTML when omitted. `createdAt` and `stats` are written only on insert, so a redeploy never resets send counters. `publishedBy` defaults to the token's actor. Not gated by `testContacts`: a template is inert until a flow references its slug.

## Sends

### `GET /sends/:id/wait?status=delivered&timeoutMs=30000`

Long-poll (one second between reads, at most 55 s) until the send reaches `sent`, `delivered`, `opened`, `clicked` or `terminal`.

```ts
→ { reached: boolean, target, waitedMs, send: SendSummary, webhookEvents: WebhookEventDoc[] }
```

`delivered`, `opened` and `clicked` come from provider webhooks. A send that reaches `sent` but never `delivered` while the recipient plainly got it means the webhook is not arriving — `GET /webhooks/status` is the next question.

### `POST /sends/:id/dispatch` — test contacts only

Dispatch a queued send now. `→ { send: SendSummary }`

## Flows

### `POST /flows/:slug/simulate`

"What would happen to this contact if the trigger fired now?" — answered by walking the published steps against the contact's real state with a virtual clock, writing nothing.

```ts
body: { contactId: string; at?: ISO date; eventProperties?: object; version?: number }
→ {
  flow: { slug, version, enabled },
  contact: { externalId, email },
  enteredAt,
  wouldEnter: { ok: boolean, reasons: string[] },   // disabled flow, no/unsubscribed subscription, once-and-already-ran, no steps
  path: [{ at, stepIndex, branchPath, type, outcome, detail? }],
  sends: [{ templateSlug, at, stepIndex, branchPath }],
  terminal: { kind: 'completed' | 'exited' | 'truncated', reason, at },
  durationMs
}
```

Predicates are evaluated by the runner's own evaluator against tags, fields, events, sends and subscription as they are at the moment of the call, with `now` set to the virtual clock. Waits advance the clock; delivery windows push sends to their slot. Outcomes: `waited`, `passed`, `skipped_next`, `exited`, `branch_true`, `branch_false`, `send`, `send_deferred`, `tagged`, `event_fired`, `webhook` (not called), `completed`.

### `POST /flows/:slug/arm`

Enable the flow for **future** events.

```ts
body: { confirm: true; since?: ISO date }
→ { slug, version, armed, alreadyEnabled, watermark, eventName, skippedEvents, pendingEvents }
→ 400 confirm_required · 404 not_found · 409 no_live_steps
```

Stamps `lastTriggerScanAt` (now, or `since`) in the same update that sets `enabled: true`, and says how many of the trigger's past events it is choosing to skip. The scanner re-reads a 30-second overlap window behind the watermark (its own concurrency guard), so an event created that recently still enters; it is counted in `pendingEvents`, not `skippedEvents`. A flow without published steps is refused: an empty flow completes every run instantly. Already enabled → `armed: false, alreadyEnabled: true`, nothing written. Audited as `flow.arm`.

### `POST /flows/:slug/disarm`

`enabled: false`. In-flight runs continue. `→ { slug, disarmed }`

### `POST /flows/:slug/gate`

Publish a canary version whose first step is `{ condition hasTag <tag>, ifFalse: exit }`, so every real contact enters and exits at step 0 with no send while tagged test contacts run the real steps through the real runner in production.

```ts
body: { tag: string }
→ { slug, version, tag, enabled }
→ 409 already_gated · 409 no_live_steps
```

`enabled` is untouched: publishing a canary version and turning the flow on are different decisions. Runs pin their version, so a contact mid-canary finishes on it.

### `POST /flows/:slug/ungate`

Republish the newest ungated version from `mailer_flow_versions`. `→ { slug, version, restoredFrom, enabled }` · `409 not_gated`

## Runs

### `GET /runs?externalId=&flowSlug=&status=&limit=`

`→ RunSummary[]` (newest first, limit ≤ 200).

### `GET /runs/:id`

`→ { run: FlowRunDoc, sends: SendSummary[] }`

### `POST /runs/:id/advance` — test contacts only

Walk one run forward now. Each of `steps` is one actionable transition (a condition, a branch, a send…); a wait standing in front of it is completed immediately and does not count. Sends created on the way are dispatched inline unless `dispatch: false`. The published timings are untouched — only this run, for this test contact, is hurried.

```ts
body: { steps?: number (1–50, default 1); dispatch?: boolean }
→ { run: RunSummary, historyAdded: FlowRunHistoryEntry[], sends: SendSummary[] }
→ 409 run_not_active
```

Forced waits appear in the history as `wait_completed` with `details.forcedBy` set to the actor. This replaces the old trick of publishing a "minutes instead of days" copy of a flow.

### `POST /runs/:id/cancel`

Exit an active run with reason `aborted_by_host:<actor>` and cancel its queued sends. Any contact — stopping mail is the safe direction. `→ { run, cancelledSends }`

## Events

### `POST /events` — test contacts only

```ts
body: { name: string; externalId: string; properties?: object; dedupeKey?: string }
→ 201 { ok: true, event: EventDoc }
→ 400 fire_failed   // unregistered name without a dedupeKey, or a schema error
```

## Contacts

### `GET /contacts/:externalId` · `GET /contacts/by-email/:email`

```ts
→ { contact, isTestContact: boolean | null, subscription, suppressions, recentEvents, recentSends: SendSummary[], runs: RunSummary[] }
```

### `GET /contacts/:externalId/unsubscribe-url` — test contacts only

A signed one-click unsubscribe URL for the contact, so a check can `POST` it to the public router and then confirm the subscription flipped. `→ { contact, unsubscribeUrl }`

### `POST /contacts/:externalId/subscribe` · `POST /contacts/:externalId/unsubscribe` — test contacts only

`→ { subscription, removedSuppressions }` for subscribe, `→ { subscription }` for unsubscribe. Unsubscribe uses the marketing scope, reason `user_request`, source `agent`. Subscribe is an explicit opt-in (`mailer.resubscribe`): it also deletes the `reason: 'unsubscribed'` suppression rows the unsubscribe left, so a canary that unsubscribes and then subscribes a test contact gets mail again — bounce and complaint rows stay.

### `POST /contacts/:externalId/tags` — test contacts only

Add or remove tags on a test contact.

```ts
body: { add?: string[]; remove?: string[] }
→ { contact, added, removed, tags }
→ 400 no_tags · 400 tag_conflict · 400 validation_failed
```

Writes through the host's `ContactAdapter` when it exposes `addTags`/`removeTags` (so the tag lands on the record the app itself reads), and falls back to mailery's own `contactTags` collection when it does not — the same path `mailer.tag()` takes for a flow's tag step.

This is the other half of `POST /flows/:slug/gate`: the canary's first step exits every contact without the tag, and the tag lives on the contact record, so without this route a gated flow has nobody to let through and the only way to arrange one is the production database credential the agent API exists to avoid.

### `POST /contacts/:externalId/reset` — test contacts only

Put a test contact back to "never seen".

```ts
body: { runs?: boolean; sends?: boolean; events?: boolean | string[]; suppressions?: boolean; subscribe?: boolean }   // all default true
→ { contact, removed: { runs, sends, events, suppressions }, subscription }
```

Deletes the contact's flow runs, sends, events (or only the named ones) and suppression rows, then re-subscribes. This is what makes a `trigger.once` flow re-testable with the same address.

## Runner and status

### `POST /tick`

Run the runner tick now — trigger scan, stranded-run and stranded-send sweeps, outbox drain, webhook backlog, health evaluation. `→ { ok, ms }`

### `GET /webhooks/status`

```ts
→ { providers: string[], lastReceivedAt, lastProvider, last24h: { delivered: n, open: n, … }, last7d, unprocessed, ingestPath }
```

`lastReceivedAt: null` after real sends have gone out is the signature of a webhook that is configured on the provider but never verified here — usually a signing-key mismatch.

### `GET /status`

One document for an agent to reason about:

```ts
→ {
  version, now, testContactsConfigured,
  setup: SetupStatus,                       // the dashboard banner's checks
  health: { status, aggregate },
  flows: [{ slug, enabled, version, lastTriggerScanAt, trigger, liveSteps, gated: tag | null, activeRuns }],
  templates: [{ slug, kind, fromEmail, published, publishedAt }],
  counts: { subscribed, suppressions, activeRuns, sendsLast24h: { status: n }, webhookEventsLast24h, lastWebhookAt }
}
```

## Errors

Every error is JSON: `{ error: string, message?: string }`. `401 unauthorized` (no or wrong token), `403 test_contacts_not_configured` / `not_a_test_contact`, `404 *_not_found`, `409` for state conflicts (`no_live_steps`, `already_gated`, `not_gated`, `run_not_active`, `not_published`), `400 validation_failed` / `confirm_required` / `fire_failed`.

## A rollout, end to end

```bash
A="https://app.example.com/admin/mailer/agent"; T="Authorization: Bearer $MAILERY_AGENT_TOKEN"

# 1. every template, every test contact, one call
curl -s -X POST "$A/templates/verify-all" -H "$T" -H 'content-type: application/json' \
  -d '{"contactIds":["u_qa1","u_qa2"]}'

# 2. a real send, then prove delivery through the webhook
ID=$(curl -s -X POST "$A/templates/welcome/send" -H "$T" -H 'content-type: application/json' -d '{"contactId":"u_qa1"}' | jq -r .sendId)
curl -s "$A/sends/$ID/wait?status=delivered&timeoutMs=30000" -H "$T"

# 3. what would the flow do to this person?
curl -s -X POST "$A/flows/activation/simulate" -H "$T" -H 'content-type: application/json' -d '{"contactId":"u_qa1"}'

# 4. canary in production: gate on a tag, arm for future events, fire, step, ungate
curl -s -X POST "$A/flows/activation/gate" -H "$T" -H 'content-type: application/json' -d '{"tag":"Mailery Canary"}'
curl -s -X POST "$A/contacts/u_qa1/tags" -H "$T" -H 'content-type: application/json' -d '{"add":["Mailery Canary"]}'
curl -s -X POST "$A/flows/activation/arm"  -H "$T" -H 'content-type: application/json' -d '{"confirm":true}'
curl -s -X POST "$A/events" -H "$T" -H 'content-type: application/json' -d '{"name":"Created","externalId":"u_qa1"}'
curl -s -X POST "$A/tick" -H "$T"
RUN=$(curl -s "$A/runs?externalId=u_qa1&flowSlug=activation" -H "$T" | jq -r '.[0].id')
curl -s -X POST "$A/runs/$RUN/advance" -H "$T" -H 'content-type: application/json' -d '{"steps":3}'
curl -s -X POST "$A/flows/activation/ungate" -H "$T"

# 5. leave the test contact as you found it
curl -s -X POST "$A/contacts/u_qa1/tags" -H "$T" -H 'content-type: application/json' -d '{"remove":["Mailery Canary"]}'
curl -s -X POST "$A/contacts/u_qa1/reset" -H "$T"
```
