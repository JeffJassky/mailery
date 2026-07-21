# Mailer

The library's main class. Hosts call `Mailer.init(config)` to construct an instance.

```ts
import { Mailer } from 'mailery'
```

## Static methods

### `Mailer.init(config)`

```ts
static async init(config: MailerConfig): Promise<Mailer>
```

Connects to Mongo, ensures indexes on all mailer collections, instantiates the queue driver. Does **not** start workers — call `.startWorkers()` for that.

```ts
const mailer = await Mailer.init({
  db,
  adapter: new MongoContactAdapter({ db, collection: 'users' }),
  queue: { driver: 'bull', redis: { url: process.env.REDIS_URL! } },
  providers: { sendgrid: new SendGridProvider({ apiKey: '...' }) },
  defaultProvider: 'sendgrid',
  publicUrl: 'https://yourdomain.com',
  unsubscribeSecret: process.env.MAILER_UNSUB_SECRET!,
})
```

See [the configuration guide](/guide/configuration) for the full `MailerConfig`.

### `Mailer.fromEnv()`

```ts
static async fromEnv(): Promise<Mailer>
```

Constructs a `Mailer` from `MAILER_*` env vars. See [the guide](/guide/configuration#from-environment-variables) for the variable list.

## Event firing

### `registerEvent(input)`

```ts
registerEvent(input: { name: string; dedupePolicy: 'once-per-contact' | 'once-per-day' | 'every-time' }): void
```

Declares an event name + dedupe policy so subsequent `fire()` calls can omit the key.

### `fire(name, externalId, properties?, dedupeKey?)`

```ts
fire(
  eventName: string,
  externalId: string,
  properties?: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void>
```

Records a behavioral event. If no `dedupeKey` is passed, one is derived from the registered policy. Without either, throws.

Duplicate-keyed calls are silent no-ops at the unique index.

### `fireFromSession(session, name, externalId, properties?, dedupeKey?)`

```ts
fireFromSession(
  session: ClientSession,
  eventName: string,
  externalId: string,
  properties?: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void>
```

Use inside a Mongo transaction. Writes to `mailer_outbox` within the session; the tick drains pending rows into `mailer_events` after the transaction commits.

## Subscriptions

### `upsertSubscription(input)`

```ts
upsertSubscription(input: {
  externalId: string
  source: string
  consentTimestamp?: Date
  consentIp?: string
  consentUserAgent?: string
}): Promise<void>
```

Creates / updates the `mailer_subscriptions` row for a contact. If `requireDoubleOptIn: true` in config, the new row is `status: 'pending_doi'`.

### `unsubscribe(email, opts)`

```ts
unsubscribe(email: string, opts: {
  scope: 'all' | 'marketing' | 'transactional'
  reason?: 'user_request' | 'hard_bounce' | 'complaint' | 'manual' | 'gdpr_forget' | 'list_cleaning'
  source?: string
  notes?: string
}): Promise<void>
```

Records an unsubscribe + adds a suppression row. Same path as the public `/m/unsub/:token` endpoint.

## Suppression

### `suppress(email, opts)`

```ts
suppress(email: string, opts: {
  scope: 'all' | 'marketing' | 'transactional'
  reason: 'unsubscribed' | 'hard_bounce' | 'complaint' | 'manual' | 'list_cleaning' | 'gdpr_forget'
  source?: string
  notes?: string
  expiresAt?: Date
}): Promise<void>
```

Adds a suppression row directly. Idempotent (upsert on `(email, scope)`).

## Tags

### `tag(externalId, tag)` / `untag(externalId, tag)`

```ts
tag(externalId: string, tag: string): Promise<void>
untag(externalId: string, tag: string): Promise<void>
```

Adds / removes a tag. Routes through `adapter.addTags` / `removeTags` if defined; otherwise writes to `mailer_contact_tags`.

## Flow abort

### `abortFlow(flowSlug, externalId, opts?)`

```ts
abortFlow(
  flowSlug: string,
  externalId: string,
  opts?: { reason?: string },
): Promise<{ abortedRuns: number; cancelledSends: number }>
```

Aborts every active run of the flow for that contact, immediately. Exits the runs (`exitReason: 'aborted_by_host:<reason>'`) — including runs parked in a `wait`, whose delayed wake-up then no-ops — and cancels any of the flow's emails still sitting undispatched in the send queue (`queued`, or `failed` awaiting retry → `cancelled`). Writes an audit row (`flow.abort`).

Call it from the same handler that processes the business event:

```ts
// user upgraded — stop the trial sequences
await mailer.abortFlow('trial-onboarding', userId, { reason: 'upgraded' })
await mailer.abortFlow('trial-winback', userId, { reason: 'upgraded' })
```

No-op (zero counts) when nothing is active. Throws on an unknown `flowSlug`. Note: a flow with `trigger: { once: true }` will not re-enter for a contact with any prior run, aborted included.

### `abortAllFlows(externalId, opts?)`

```ts
abortAllFlows(
  externalId: string,
  opts?: { reason?: string },
): Promise<{ abortedRuns: number; cancelledSends: number }>
```

Same semantics with no flow filter — exits every active run for the contact across all flows (audit action `flow.abort_all`). For "stop everything" events: account deleted, churned.

## GDPR

### `forget(externalId)`

```ts
forget(externalId: string): Promise<void>
```

Hard-deletes all PII for the contact across mailer collections, then inserts a `mailer_suppressions` row with `email: null` + `emailHash` retained. Future sends to the same email are blocked at the hash level — INVARIANT 9.

### `exportContactData(externalId)`

```ts
exportContactData(externalId: string): Promise<Record<string, unknown>>
```

Returns a JSON-serializable object with all mailer-side data for the contact (subscription, events, flowRuns, sends, suppressions, tags). Pipe this into your host's GDPR export.

## One-off sends

### `sendOneOff(input)`

```ts
sendOneOff(input: {
  templateSlug: string
  externalId: string
  vars?: Record<string, unknown>
  providerOverride?: string
  dedupeKey: string                     // required
}): Promise<{ sendId: string }>
```

Ad-hoc transactional send (receipts, password resets). Same pipeline as flow sends — suppression check, tracking, idempotency via `dedupeKey`.

```ts
await mailer.sendOneOff({
  templateSlug: 'password-reset',
  externalId: user._id.toString(),
  vars: { resetUrl: `https://yourdomain.com/reset?token=${tokenHash}` },
  dedupeKey: `password-reset:${user._id}:${tokenHash}`,
})
```

The `dedupeKey` prevents accidental double-sends if your caller retries.

## Audit

### `audit(entry)`

```ts
audit(entry: {
  actor: string
  action: string
  resource: { collection: string; id?: string | ObjectId; slug?: string }
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  diffSummary?: string
  ip?: string
  userAgent?: string
  requestId?: string
}): Promise<void>
```

Writes an entry to `mailer_audit_log`. Useful when you mutate mailer collections directly from a deploy script:

```ts
await db.collection('mailer_flows').updateOne({ slug }, { $set: { 'draft.steps': newSteps } })
await mailer.audit({
  actor: 'script:deploy',
  action: 'flow.draft.update',
  resource: { collection: 'mailer_flows', slug },
  diffSummary: 'Added day-21 check-in step',
})
```

## Lifecycle

### `startWorkers()`

```ts
startWorkers(): Promise<void>
```

Spins up queue workers (Bull or Agenda, per your `queue.driver`) for tick / advance / send / webhook queues. Call from your worker process only.

### `stop()`

```ts
stop(): Promise<void>
```

Closes workers, queues, and underlying connections (Redis for the Bull driver). Call on `SIGTERM` for graceful shutdown.

### `getRunnerContext()`

```ts
getRunnerContext(): RunnerContext
```

Returns the internal context object passed to runner functions. Useful for tests that drive `runTick`, `processOneRunStep`, `dispatchSend` directly. Not part of the public API for production code.

## Properties

| Property | Type | Notes |
|---|---|---|
| `mailer.db` | `Db` | The Mongo database mailery owns its collections in. |
| `mailer.collections` | `Collections` | Typed accessors for every `mailer_*` collection. |
| `mailer.adapter` | `ContactAdapter` | Whatever you passed at init. |
| `mailer.providers` | `Record<string, MailProvider>` | Configured providers map. |
| `mailer.queues` | `Queues` | Driver-agnostic queue facade (`add`, `getWaitingCount`, `close`). |
| `mailer.config` | `ResolvedConfig` | Resolved configuration with defaults applied. |
| `mailer.events` | `EventRegistry` | Internal registry tracking event policies. |

## Deliverability config (optional)

The `MailerConfig` interface accepts these optional sub-objects in addition to the core fields. Each is fully opt-in — leave it out and the feature stays dormant.

```ts
interface MailerConfig {
  // ... core fields ...

  circuitBreaker?: Partial<{
    hardBounceRatePctTrip: number          // default 2
    complaintRatePctTrip: number           // default 0.3
    combinedBounceRatePctTrip: number      // default 5
    failedToSendRatePctDegrade: number     // default 10
    windowMinutes: number                  // default 60
    minSendsBeforeEval: number             // default 100
  }>

  dnsbl?: {
    domainLists?: Array<{ host: string; label: string }>
    ipLists?: Array<{ host: string; label: string }>
    dedicatedIps?: string[]
    intervalHours?: number                 // default 24, 0 disables
  }

  postmaster?: {
    clientId: string
    clientSecret: string
    refreshToken: string                   // scope: postmaster.readonly
    domains?: string[]                     // defaults to union of senderDomains keys + fromDefaults.email domain + transactionalFromDefaults.email domain
    intervalHours?: number                 // default 24
  }

  snds?: {
    accessKey: string
    ips?: string[]                         // optional filter
    intervalHours?: number                 // default 24
  }

  dmarc?: {
    knownSources?: Array<{ ip: string; label: string; ignored?: boolean }>
    retentionDays?: number                 // default 90 — old failures pruned by an hourly housekeeping job
  }

  mailTester?: {
    apiKey: string
    minScore?: number                      // default 8.0
    cacheHours?: number                    // default 24
    baseUrl?: string                       // override for staging
  }
}
```

See [the configuration guide](/guide/configuration) for behavior + the [deliverability guide](/guide/deliverability) for the surrounding features.

## Collections

`mailer.collections` exposes typed handles to every mailer-owned Mongo collection. New collections introduced with the deliverability features:

| Collection | Document type | Purpose |
|---|---|---|
| `health` | `HealthDoc` | One doc per (sender domain × kind) bucket plus an `_id: 'agg'` aggregate. Replaces the prior singleton. |
| `dnsblChecks` | `DnsblCheckDoc` | Latest scan result per (target, list). |
| `postmasterSnapshots` | `PostmasterSnapshotDoc` | One doc per (domain, day) from Google Postmaster Tools. |
| `sndsSnapshots` | `SndsSnapshotDoc` | One doc per (IP, activityStart) from Microsoft SNDS. |
| `dmarcReports` | `DmarcReportDoc` | One doc per ingested DMARC aggregate report. |
| `dmarcFailures` | `DmarcFailureDoc` | One doc per (report × non-aligned source IP). |
| `dmarcSourceTags` | `DmarcSourceTagDoc` | Operator-set IP labels written from the admin UI. |
| `mailTesterScores` | `MailTesterScoreDoc` | Cached Mail-Tester scores keyed on a content fingerprint. |

Each document type is exported from `mailery` for hosts that need to query mailer-owned collections directly.

## Deliverability helpers

These functions live in `mailery/server/runner/*` and are exported for hosts that want to bypass the admin endpoints (e.g., scheduled jobs in your own process):

```ts
import {
  recordHealthCounter,
  evaluateHealth,
  effectiveOverallStatus,
  getBucketStatus,
} from 'mailery'                              // health.ts

import { runDnsblChecks } from 'mailery'      // dnsbl.ts
import { runPostmasterPull } from 'mailery'   // postmaster.ts
import { runSndsPull } from 'mailery'         // snds.ts

import {
  ingestDmarcAttachment,                     // bytes → parse → persist
  parseDmarcReport,                          // pure XML → parsed report
  extractDmarcXml,                           // pure decompress
  pruneDmarcFailures,
  resolveSourceTags,
  suggestPolicyProgression,
} from 'mailery'                              // dmarc.ts

import { computeListHygiene } from 'mailery'  // hygiene.ts

import {
  createMailTesterClient,
  evaluateMailTesterGate,
  mailTesterContentKey,
} from 'mailery'                              // mail-tester.ts

import { lintTemplate } from 'mailery'        // templates/linter.ts
```

The `tick.ts` runner already calls `evaluateHealth`, `runDnsblChecks`, `runPostmasterPull`, `runSndsPull`, and `pruneDmarcFailures` on its interval. Reach for these helpers directly only when you need on-demand execution outside the tick.
