# 03 — The Runner

The runner advances `flow_runs` through their state machine. It has two execution paths:

1. **Delayed-job wakeups** (primary): when a `wait` step finishes, BullMQ delivers a job at the scheduled time. The handler advances exactly that run.
2. **Tick recovery sweep** (secondary): every minute, a `mailer:tick` job scans for runs whose `nextActionAt` has passed but weren't woken — covers worker restarts, missed schedules, newly-fired events.

The tick is also where newly-fired event triggers are picked up and broadcasts are dispatched.

## The single tick job

```ts
queue.every('mailer:tick', '* * * * *', async () => {
  await processNewlyFiredEventTriggers()
  await sweepStrandedFlowRuns()
  await processScheduledBroadcasts()
  await drainOutbox()
  await rollupStats()           // every 15 min in practice; guard by minute mod
  await reconcileWebhookEvents() // once daily; same gating
})
```

Runs every minute. All work is bounded — long-running operations are deferred to subsequent ticks.

The tick is **safe to run concurrently** (multiple workers on different boxes) because:

- Each flow_run advance uses a Mongo `findOneAndUpdate` with optimistic concurrency on `currentStepIndex` — only one worker advances a given run per step
- Each send uses a unique `dedupeKey` — sends with the same key collide on insert, second insert no-ops
- Trigger creation uses `(externalId, flowId)` lookup before creating a flow_run; concurrent creates collide on a unique compound index

## Stage 1 — processing newly fired event triggers

```ts
async function processNewlyFiredEventTriggers() {
  const eventFlows = await Flows.find({
    enabled: true,
    'trigger.type': 'event',
  }).toArray()

  for (const flow of eventFlows) {
    const eventName = flow.trigger.eventName
    const since = flow.lastTriggerScanAt ?? flow.createdAt

    const newEvents = await Events.find({
      name: eventName,
      occurredAt: { $gt: since },
    }).limit(1000).toArray()

    for (const event of newEvents) {
      if (flow.trigger.once) {
        const existing = await FlowRuns.findOne({
          externalId: event.externalId,
          flowId: flow._id,
        })
        if (existing) continue
      }

      // Subscription gate (marketing flows require a subscribed contact)
      const sub = await Subscriptions.findOne({ externalId: event.externalId })
      if (!sub || sub.status !== 'subscribed') continue

      try {
        await FlowRuns.insertOne({
          externalId: event.externalId,
          flowId: flow._id,
          flowSlug: flow.slug,
          flowVersion: flow.version,
          emailAtEntry: sub.emailAtSubscribe,
          enteredAt: new Date(),
          status: 'active',
          currentStepIndex: 0,
          currentBranchPath: [],
          nextActionAt: new Date(),       // process immediately on next sweep
          attemptsForCurrentStep: 0,
          history: [{ stepIndex: -1, action: 'entered', at: new Date() }],
        })
        // Wake the runner now (delayed=0) rather than waiting for the next tick.
        await queue.enqueue('mailer:advance', { flowRunId: newId })
      } catch (err) {
        if (!isDuplicateKey(err)) throw err
        // Concurrent insert by another worker — fine, skip.
      }
    }

    await Flows.updateOne(
      { _id: flow._id },
      { $set: { lastTriggerScanAt: new Date() } },
    )
  }
}
```

`lastTriggerScanAt` is stored on `mailer_flows` (added to schema in `02-data-model.md`).

### Segment-enter and cron triggers

Segment-enter triggers re-evaluate the segment definition periodically and create flow_runs for newly-matching contacts. Cron triggers fire on schedule against a segment.

For V1, only `event` triggers are required. The other two are scaffolded but optional.

## Stage 2 — advancing flow_runs

Two entry points; both call `processOneRunStep`:

```ts
// Primary: a delayed job fires at the run's nextActionAt
worker.on('mailer:advance', async (job) => {
  await processOneRunStep(job.data.flowRunId)
})

// Recovery sweep: tick finds runs that should have advanced but didn't
async function sweepStrandedFlowRuns() {
  const runs = await FlowRuns.find({
    status: 'active',
    nextActionAt: { $lte: new Date() },
  })
    .limit(500)
    .sort({ nextActionAt: 1 })
    .toArray()

  for (const run of runs) {
    await processOneRunStep(run._id).catch(err => {
      logger.error('Run advance failed', { runId: run._id, err })
    })
  }
}
```

In normal operation, the delayed-job path handles every advance. The sweep only picks up runs that were stranded by worker restarts or BullMQ data loss.

### `processOneRunStep`

The core state machine. One step transition per call.

```ts
async function processOneRunStep(runId) {
  const run = await FlowRuns.findOne({ _id: runId })
  if (!run || run.status !== 'active') return

  const flow = await Flows.findOne({ _id: run.flowId })
  const steps = run.flowVersion === flow.version
    ? flow.steps
    : (await FlowVersions.findOne({ flowId: run.flowId, version: run.flowVersion })).steps

  const step = locateStep(steps, run.currentStepIndex, run.currentBranchPath)
  if (!step) {
    await completeFlowRun(run, 'completed')
    return
  }

  // Contact identity lives on the host. Always read through the adapter.
  const contact = await adapter.getById(run.externalId)

  // Marketing flows skip remaining steps if the contact is no longer subscribed.
  // Transactional sends (if any survive past this point) still respect suppressions at send time.
  const sub = await Subscriptions.findOne({ externalId: run.externalId })
  if (!sub || sub.status !== 'subscribed') {
    return exitFlowRun(run, sub?.status ?? 'no_subscription')
  }
  if (!contact) {
    return exitFlowRun(run, 'contact_missing')
  }

  switch (step.type) {
    case 'wait':       return handleWait(run, step)
    case 'condition':  return handleCondition(run, step, contact)
    case 'branch':     return handleBranch(run, step, contact)
    case 'send':       return handleSend(run, step, contact, flow)
    case 'tag':        return handleTag(run, step, contact)
    case 'fire_event': return handleFireEvent(run, step, contact)
    case 'webhook':    return handleWebhook(run, step, contact)
    case 'exit':       return exitFlowRun(run, step.reason || 'exit_step')
  }
}
```

### Handlers in detail

#### `handleWait`

```ts
async function handleWait(run, step) {
  const ms = unitToMs(step.value, step.unit)
  const nextAt = new Date(Date.now() + ms)

  const updated = await FlowRuns.findOneAndUpdate(
    { _id: run._id, currentStepIndex: run.currentStepIndex },
    {
      $set: { nextActionAt: nextAt },
      $inc: { currentStepIndex: 1 },
      $push: {
        history: {
          stepIndex: run.currentStepIndex,
          action: 'wait_started',
          at: new Date(),
          details: { until: nextAt },
        },
      },
    },
  )
  if (!updated) return // another worker advanced; their job will run.

  // Schedule a delayed wakeup so the runner processes this run at nextAt.
  await queue.enqueue('mailer:advance', { flowRunId: run._id }, { delay: ms })
}
```

The optimistic-concurrency filter (`currentStepIndex: run.currentStepIndex`) ensures only one worker schedules the wakeup. If two workers race, the second's update no-ops and they don't schedule a duplicate job.

#### `handleCondition`

`condition` is a guard step. It evaluates the predicate. If **true**, the next step runs. If **false**, behavior is governed by `ifFalse`: `'continue'` skips the next step and goes to the one after, `'exit'` ends the flow_run.

For most cases you want `'exit'` (e.g. "send only if they still haven't activated"). For "do something different if false," use `branch`.

```ts
async function handleCondition(run, step, contact) {
  const result = await evaluatePredicate(step.test, contact, run)

  if (result) {
    return advanceStep(run, { action: 'condition_evaluated', details: { result: true } })
  }
  if (step.ifFalse === 'continue') {
    return advanceStep(run, { action: 'condition_evaluated', details: { result: false, skip: 1 } }, { skip: 1 })
  }
  return exitFlowRun(run, 'condition_false')
}
```

#### `handleBranch`

```ts
async function handleBranch(run, step, contact) {
  const result = await evaluatePredicate(step.test, contact, run)

  const updated = await FlowRuns.findOneAndUpdate(
    { _id: run._id, currentStepIndex: run.currentStepIndex },
    {
      $set: {
        currentBranchPath: [...run.currentBranchPath, run.currentStepIndex, result ? 'true' : 'false', 0],
        nextActionAt: new Date(),
      },
      $push: {
        history: {
          stepIndex: run.currentStepIndex,
          action: 'branch_taken',
          at: new Date(),
          details: { result },
        },
      },
    },
  )
  if (!updated) return
  await queue.enqueue('mailer:advance', { flowRunId: run._id })
}
```

`currentBranchPath` is a list of `[parentStepIndex, 'true'|'false', childStepIndex]` triples — supports arbitrary nesting depth. `locateStep` walks this path.

#### `handleSend`

The most important handler. The runner does **not** call the provider inline — it creates the send row and enqueues a `mailer:send` job. The send worker handles provider dispatch and retries.

```ts
async function handleSend(run, step, contact, flow) {
  const template = await Templates.findOne({ slug: step.templateSlug })
  if (!template) {
    return failFlowRun(run, `template not found: ${step.templateSlug}`)
  }

  const dedupeKey = `${run._id}:${run.currentStepIndex}`

  // Idempotency: has this exact step already produced a send?
  const existing = await Sends.findOne({ dedupeKey })
  if (existing) {
    return advanceStep(run, {
      action: 'sent',
      details: { dedupeKey, alreadySent: true, sendId: existing._id },
    })
  }

  // Provider selection: step override > template override > kind-specific default > default
  const providerName =
    step.providerOverride
    ?? template.providerOverride
    ?? (template.kind === 'transactional' ? config.defaultTransactionalProvider : null)
    ?? config.defaultProvider

  // Render at send-time (so contact fields are fresh).
  const vars = buildVariableContext(contact, run, step.vars)
  const rendered = await renderTemplate(template, vars)

  // Persist the send row first (so we have a stable id for tracking links).
  // Suppression is re-checked by the send worker per INVARIANTS.md rule 3.
  const sendId = new ObjectId()
  await Sends.insertOne({
    _id: sendId,
    dedupeKey,
    externalId: run.externalId,
    emailAtSend: contact.email,
    templateId: template._id,
    templateSlug: template.slug,
    flowRunId: run._id,
    broadcastId: null,
    manualSendBy: null,
    kind: template.kind,
    provider: providerName,
    providerMessageId: null,
    fromName: rendered.fromName,
    fromEmail: rendered.fromEmail,
    subject: rendered.subject,
    bodyHash: sha256(rendered.html),
    status: 'queued',
    openedAt: null, openCount: 0,
    firstClickAt: null, clickCount: 0, clickedLinks: [],
    unsubscribedAt: null, complainedAt: null,
    errorMessage: null, bounceType: null, bounceReason: null,
    queuedAt: new Date(), sentAt: null, deliveredAt: null,
  })

  await queue.enqueue('mailer:send', { sendId, renderedHtml: rendered.html, renderedText: rendered.plainText })

  return advanceStep(run, { action: 'sent', details: { sendId, dedupeKey } })
}
```

The send worker (defined in `04-queues.md`) takes over from here:

1. Re-load the send doc (could have been cancelled).
2. Re-check suppression by `(emailAtSend, scope)` against `template.kind`.
3. Re-check circuit breaker (`mailer_health.status`); marketing sends are held when tripped, transactional bypass.
4. Apply tracking rewrites (open pixel, click links) using `sendId`.
5. Call `provider.send(...)`.
6. Update `sends.status` → `'sent'` + `providerMessageId`.
7. On failure: BullMQ retries up to 4 times (exponential backoff). After exhaustion, send is `'failed'`. The flow_run has already advanced past this step — failed sends do not block subsequent steps.

Key invariants:

- **`dedupeKey = ${flowRunId}:${stepIndex}`** — a given step in a given run produces at most one send row.
- **Send row created before enqueue** — if the enqueue fails, the row sits in `status: 'queued'` and the next tick can re-enqueue. If the worker fails partway, we have a row to update.
- **Status transitions**: `queued` → `sent` → `delivered` (via webhook) → optionally `opened` / `clicked` / `bounced` / `complained` / `failed` / `suppressed`.
- **No flow-run-level send retry counter.** BullMQ owns send retries. `attemptsForCurrentStep` covers non-send step failures (webhook step 5xx, condition predicate errors).

#### `handleTag` / `handleFireEvent`

`handleTag` routes through the adapter's `addTags`/`removeTags` (host-owned tags) or writes to `mailer_contact_tags` (mailer-owned). `handleFireEvent` inserts a synthetic event row (with a dedupeKey derived from `${runId}:${stepIndex}`). Both then call `advanceStep`.

#### `handleWebhook`

POST to a URL. Useful for cross-system integration ("when this flow's third step runs, ping our analytics warehouse"). On failure: increment `attemptsForCurrentStep`, retry on next tick up to a configurable limit (default 3). After exhaustion, log + advance (soft-fail) unless the step opts into hard-fail (`{ failureMode: 'fail_run' }`).

## Idempotency guarantees

| Operation | Mechanism |
|---|---|
| Don't enter same flow twice for same contact | Unique compound index `(externalId, flowId)` on `mailer_flow_runs` for flows with `trigger.once = true` |
| Don't advance same step twice | Optimistic concurrency on `currentStepIndex` in `findOneAndUpdate` filter |
| Don't send same email twice for same step | Unique `dedupeKey` constraint on `mailer_sends.dedupeKey` |
| Don't double-process webhook events | Unique `(provider, providerEventId)` on `mailer_webhook_events` |
| Don't re-create flow_run if existing exited | When `trigger.once = true`, re-entry is prevented; otherwise allowed |

## Versioning: what happens when a flow is edited?

Two competing requirements:

1. **In-flight contacts should finish on the version they entered on** (no surprises).
2. **New entrants should get the latest version.**

Solution: pin `flowVersion` on flow_run creation. When the runner loads steps for a run, it checks `run.flowVersion === flow.version`. If yes, use `flow.steps`. If no, look up the pinned version from `mailer_flow_versions` (a snapshot collection populated on every publish).

This collection is append-only. Keeps history indefinitely (retention policy in `08-compliance.md`).

Cost: an extra collection. Benefit: edits and republishes never break in-flight runs.

## Manual interventions

The admin UI exposes:

- **Pause a flow** (`flows.enabled = false`) — no new entrants, in-flight runs continue
- **Stop a flow** — `flows.enabled = false` + bulk update active runs to `exited`
- **Cancel a specific run** — set `status: 'exited'`, `exitReason: 'manually_cancelled'`
- **Resend a specific send** — clone the send row with a new `dedupeKey` and re-dispatch
- **Skip a stuck contact past a step** — manually advance their `currentStepIndex`

All such mutations are logged in the run's `history` and `mailer_audit_log`.

## Retry policy

- **Provider failures** (5xx, network errors): BullMQ retries up to 4 times with exponential backoff (1m, 5m, 25m, 125m). Configurable via `sendRetryAttempts` / `sendRetryBackoff`.
- **Render failures** (bad MJML, missing required variable): no retry. Mark send `failed`, advance flow_run past the send step.
- **Suppression**: skip cleanly, mark send `suppressed`, advance flow_run.
- **Soft bounce** (returned in webhook): no client-side retry. Provider handles soft-bounce retries internally. Three soft bounces for the same address within 30 days promote to a hard bounce (configurable; see `INVARIANTS.md` rule 13).
- **Hard bounce** (returned in webhook): no retry. Add to suppressions. Future sends to that contact will skip.
- **Webhook step failure**: increment `attemptsForCurrentStep`; retry on next tick up to `webhookRetryAttempts` (default 3).

## Observability

The runner emits structured logs (and optionally pushes to a log sink via config):

```
{level: 'info', event: 'tick_started', batchSize, ...}
{level: 'info', event: 'flow_run_entered', flowSlug, externalId, ...}
{level: 'info', event: 'step_processed', flowSlug, stepIndex, stepType, action, ...}
{level: 'warn', event: 'send_failed', sendId, error, retryCount, ...}
{level: 'error', event: 'tick_failed', error, durationMs, ...}
```

Tick duration is exposed as a metric (`mailer.tick.duration_ms`) for monitoring backlog growth. Delayed-job lag (`mailer:advance` jobs sitting past their `delay`) is the primary backlog signal.
