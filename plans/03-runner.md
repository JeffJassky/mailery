# 03 — The Runner

The runner is a single scheduled job that processes `flow_runs`. It's the engine. This document describes its state machine, idempotency guarantees, and edge cases.

## The single tick job

```ts
queue.every('mailer:tick', '* * * * *', async () => {
  await processNewlyFiredEventTriggers()
  await advanceActiveFlowRuns()
  await processScheduledBroadcasts()
  await retryFailedSends()
})
```

Runs every minute. All work is bounded — long-running operations are deferred to subsequent ticks.

The tick is **safe to run concurrently** (multiple workers on different boxes) because:

- Each flow_run advance uses a Mongo `findOneAndUpdate` with optimistic concurrency on `currentStepIndex` — only one worker advances a given run per step
- Each send uses a unique `dedupeKey` — sends with the same key collide on insert, second insert no-ops
- Trigger creation uses `{ contactId, flowId }` unique-ish lookup (a flow_run is only created if no active one exists)

## Stage 1 — processing newly fired event triggers

```ts
async function processNewlyFiredEventTriggers() {
  const eventFlows = await Flows.find({
    enabled: true,
    'trigger.type': 'event',
  })

  for (const flow of eventFlows) {
    const eventName = flow.trigger.eventName
    const since = flow.lastTriggerScanAt ?? flow.createdAt

    // Find events of this name since last scan
    const newEvents = await Events.find({
      name: eventName,
      occurredAt: { $gt: since },
    }).limit(1000)

    for (const event of newEvents) {
      // Has this contact already entered this flow?
      if (flow.trigger.once) {
        const existing = await FlowRuns.findOne({
          contactId: event.contactId,
          flowId: flow._id,
        })
        if (existing) continue
      }

      // Is the contact still emailable?
      const contact = await Contacts.findById(event.contactId)
      if (!contact || contact.status !== 'active') continue

      // Create flow_run, ready to run on next stage
      await FlowRuns.create({
        contactId: event.contactId,
        flowId: flow._id,
        flowSlug: flow.slug,
        flowVersion: flow.version,
        enteredAt: new Date(),
        status: 'active',
        currentStepIndex: 0,
        currentBranchPath: [],
        nextActionAt: new Date(),                  // process immediately
        attemptsForCurrentStep: 0,
        history: [{ stepIndex: -1, action: 'entered', at: new Date() }],
      })
    }

    // Mark this flow's progress so the next tick doesn't re-scan
    await Flows.updateOne(
      { _id: flow._id },
      { $set: { lastTriggerScanAt: new Date() } },
    )
  }
}
```

### Segment-enter and cron triggers

Handled similarly. Segment-enter triggers re-evaluate the segment definition and compare to a prior snapshot per flow (stored on the flow doc). Cron triggers fire on schedule per matching segment.

For V1, only `event` triggers are required. The other two are scaffolded but optional.

## Stage 2 — advancing active flow_runs

```ts
async function advanceActiveFlowRuns() {
  const runs = await FlowRuns.find({
    status: 'active',
    nextActionAt: { $lte: new Date() },
  })
    .limit(500)                                    // bounded; subsequent ticks drain backlog
    .sort({ nextActionAt: 1 })

  for (const run of runs) {
    await processOneRunStep(run).catch(err => {
      console.error('Run advance failed', run._id, err)
      // Increment attempts; if too many, fail the run
      // ...
    })
  }
}
```

### `processOneRunStep`

The core state machine. One step transition per call.

```ts
async function processOneRunStep(run) {
  const flow = await Flows.findById(run.flowId)
  const steps = run.flowVersion === flow.version
    ? flow.steps
    : await getPinnedFlowVersion(run.flowId, run.flowVersion)

  const step = locateStep(steps, run.currentStepIndex, run.currentBranchPath)
  if (!step) {
    // Out of steps — flow_run completes
    await completeFlowRun(run, 'completed')
    return
  }

  const contact = await Contacts.findById(run.contactId)

  // Check if contact is still emailable; if not, exit
  if (!contact || contact.status !== 'active') {
    await exitFlowRun(run, contact?.status === 'unsubscribed' ? 'unsubscribed' : 'bounced')
    return
  }

  switch (step.type) {
    case 'wait':       return await handleWait(run, step)
    case 'condition':  return await handleCondition(run, step, contact)
    case 'branch':     return await handleBranch(run, step, contact)
    case 'send':       return await handleSend(run, step, contact)
    case 'tag':        return await handleTag(run, step, contact)
    case 'fire_event': return await handleFireEvent(run, step, contact)
    case 'webhook':    return await handleWebhook(run, step, contact)
    case 'exit':       return await exitFlowRun(run, step.reason || 'exit_step')
  }
}
```

### Handlers in detail

#### `handleWait`

```ts
async function handleWait(run, step) {
  const ms = unitToMs(step.value, step.unit)
  const nextAt = new Date(Date.now() + ms)

  await FlowRuns.findOneAndUpdate(
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
}
```

The optimistic concurrency check (`currentStepIndex: run.currentStepIndex` in the filter) ensures only one worker advances the step. If a concurrent worker already advanced, our update no-ops.

#### `handleCondition`

Evaluate the predicate. If true, advance to next step normally. If false and `ifFalse === 'exit'`, exit the run. If false and `ifFalse === 'continue'`, skip the next step.

Wait, this needs clarification. Re-spec:

> `condition` is a guard step. It evaluates the predicate. If **true**, the next step runs. If **false**, the behavior is governed by `ifFalse`: `'continue'` skips the next step and goes to the one after, `'exit'` ends the flow_run.

For most cases, you want `'exit'` (e.g. "send only if they still haven't activated"). For "do something different if false," use `branch` instead.

```ts
async function handleCondition(run, step, contact) {
  const result = await evaluatePredicate(step.test, contact, run)

  let action: 'advance' | 'skip_one' | 'exit'
  if (result) {
    action = 'advance'
  } else if (step.ifFalse === 'continue') {
    action = 'skip_one'
  } else {
    action = 'exit'
  }

  // ... update flow_run accordingly
}
```

#### `handleBranch`

```ts
async function handleBranch(run, step, contact) {
  const result = await evaluatePredicate(step.test, contact, run)
  const subSteps = result ? step.ifTrueSteps : step.ifFalseSteps

  // Descend into the chosen branch
  await FlowRuns.findOneAndUpdate(
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
}
```

The `currentBranchPath` is a list of `[parentStepIndex, 'true'|'false', childStepIndex]` triples — supports arbitrary nesting depth. `locateStep` walks this path.

#### `handleSend`

This is the most important handler. Idempotent send.

```ts
async function handleSend(run, step, contact) {
  const template = await Templates.findOne({ slug: step.templateSlug })
  if (!template) {
    return await failFlowRun(run, `template not found: ${step.templateSlug}`)
  }

  const dedupeKey = `${run._id}:${run.currentStepIndex}`

  // Idempotency check — has this exact step already sent?
  const existing = await Sends.findOne({ dedupeKey })
  if (existing) {
    // Already sent (possibly by a previous tick that crashed mid-step). Skip but advance.
    await advanceStep(run, {
      action: 'sent',
      stepIndex: run.currentStepIndex,
      details: { dedupeKey, alreadySent: true },
    })
    return
  }

  // Suppression check
  const suppressed = await Suppressions.findOne({ email: contact.email })
  if (suppressed) {
    await Sends.create({
      dedupeKey,
      contactId: contact._id,
      templateId: template._id,
      templateSlug: template.slug,
      flowRunId: run._id,
      to: contact.email,
      fromName: template.fromName,
      fromEmail: template.fromEmail,
      subject: template.subject,
      status: 'suppressed',
      queuedAt: new Date(),
    })
    await advanceStep(run, { action: 'send_skipped', stepIndex: run.currentStepIndex, details: { reason: 'suppressed' } })
    return
  }

  // Render
  const variables = buildVariableContext(contact, run)
  const rendered = await renderTemplate(template, variables)

  // Create send row first (so we have an ID to thread through tracking links)
  const send = await Sends.create({
    dedupeKey,
    contactId: contact._id,
    templateId: template._id,
    templateSlug: template.slug,
    flowRunId: run._id,
    to: contact.email,
    fromName: rendered.fromName,
    fromEmail: rendered.fromEmail,
    subject: rendered.subject,
    bodyHash: sha256(rendered.html),
    status: 'queued',
    queuedAt: new Date(),
    provider: defaultProvider.name,
  })

  // Rewrite links + add open pixel using send._id
  const finalHtml = applyTracking(rendered.html, send._id, template)

  try {
    const result = await defaultProvider.send({
      to: contact.email,
      fromName: rendered.fromName,
      fromEmail: rendered.fromEmail,
      subject: rendered.subject,
      html: finalHtml,
      text: rendered.plainText,
      headers: {
        'List-Unsubscribe': `<${publicUrl}/m/unsub/${unsubToken(contact.email)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      messageMeta: { sendId: send._id.toString() },
    })

    await Sends.updateOne(
      { _id: send._id },
      { $set: { status: 'sent', sentAt: new Date(), providerMessageId: result.providerId } },
    )

    await advanceStep(run, { action: 'sent', stepIndex: run.currentStepIndex, details: { sendId: send._id } })
  } catch (err) {
    await Sends.updateOne(
      { _id: send._id },
      { $set: { status: 'failed', errorMessage: err.message } },
    )
    // Increment attempts. Retry on next tick if under threshold.
    await FlowRuns.updateOne(
      { _id: run._id },
      { $inc: { attemptsForCurrentStep: 1 } },
    )
    if (run.attemptsForCurrentStep + 1 >= MAX_SEND_ATTEMPTS) {
      await failFlowRun(run, `send failed after ${MAX_SEND_ATTEMPTS} attempts`)
    }
  }
}
```

Key invariants:

- **`dedupeKey` is `${flowRunId}:${stepIndex}`** — a given step in a given run can only ever send one email
- **Send row created BEFORE provider call** — if the provider call succeeds but our DB write fails, we can recover from the provider's webhook
- **Status transitions**: `queued` → `sent` → `delivered` (via webhook) → optionally `opened` / `clicked` / `bounced` / `complained`

#### `handleTag` / `handleFireEvent`

Simple. Add/remove tags or insert a synthetic event. Advance.

#### `handleWebhook`

POST to a URL. Useful for cross-system integration ("when this flow's third step runs, ping our analytics warehouse"). Treat failures as soft (log, continue) unless the step opts into hard-fail.

## Idempotency guarantees

| Operation | Mechanism |
|---|---|
| Don't enter same flow twice for same contact | `flow_runs` lookup by `(contactId, flowId)` for flows with `trigger.once = true` |
| Don't advance same step twice | Optimistic concurrency on `currentStepIndex` in `findOneAndUpdate` filter |
| Don't send same email twice for same step | Unique `dedupeKey` constraint on `sends.dedupeKey` |
| Don't double-process webhook events | Webhook events keyed on provider message ID + event timestamp; upsert |
| Don't re-create flow_run if existing exited | When `trigger.once = false`, re-entry is allowed; otherwise prevented |

## Versioning: what happens when a flow is edited?

Two competing requirements:

1. **In-flight contacts should finish on the version they entered on** (no surprises).
2. **New entrants should get the latest version.**

Solution: pin `flowVersion` on flow_run creation. When the runner loads steps for a run, it checks `run.flowVersion === flow.version`. If yes, use `flow.steps`. If no, look up the pinned version from `mailer_flow_versions` (a snapshot collection populated on every publish).

```ts
mailer_flow_versions {
  flowId, version, steps, publishedAt, publishedBy
}
```

This collection is append-only. Keeps history forever (or until a retention policy is added).

Cost: an extra collection. Benefit: agents can confidently edit and republish without worrying about breaking in-flight runs.

## Manual interventions

The admin UI exposes:

- **Pause a flow** (`flows.enabled = false`) — no new entrants, in-flight runs continue
- **Stop a flow** — `flows.enabled = false` + bulk update active runs to `exited`
- **Cancel a specific run** — set `status: 'exited'`, `exitReason: 'manually_cancelled'`
- **Resend a specific send** — clone the send row with a new `dedupeKey` and re-dispatch
- **Skip a stuck contact past a step** — manually advance their `currentStepIndex`

All such mutations are logged in the run's `history`.

## Retry policy

- **Provider failures** (5xx, network errors): retry up to 3 times with exponential backoff (1m, 5m, 25m). Each retry is a separate tick.
- **Render failures** (bad MJML, missing variable): no retry. Mark send `failed`, advance flow_run past the send step.
- **Suppression**: skip cleanly, don't retry, log to `send_skipped`.
- **Bounce (soft, returned in webhook)**: don't retry from this side. Provider handles soft-bounce retries internally.
- **Bounce (hard, returned in webhook)**: don't retry. Add to suppressions. Future sends to that contact will skip.

## Observability

The runner emits structured logs (and optionally pushes to a log sink via config):

```
{level: 'info', event: 'tick_started', batchSize, ...}
{level: 'info', event: 'flow_run_entered', flowSlug, contactEmail, ...}
{level: 'info', event: 'step_processed', flowSlug, stepIndex, stepType, action, ...}
{level: 'warn', event: 'send_failed', sendId, error, retryCount, ...}
{level: 'error', event: 'tick_failed', error, durationMs, ...}
```

Tick duration is exposed as a metric (`mailer.tick.duration_ms`) for monitoring backlog growth.
