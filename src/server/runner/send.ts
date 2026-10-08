/**
 * Send pipeline. `handleSend` is called by the runner state machine; it creates
 * the Send document and enqueues a mailer:send job. `dispatchSend` is the
 * worker — re-checks suppression + circuit breaker, applies tracking, calls
 * the provider, updates the Send row.
 */

import crypto from 'node:crypto'
import { ObjectId } from 'mongodb'

import type { Contact, FlowStep } from '../../shared/types.js'
import type { FlowRunDoc, FlowDoc, SendDoc, TemplateDoc } from '../models/index.js'
import {
  applyTracking,
  renderTemplate,
  type RenderContext,
} from '../templates/render.js'
import { signUnsubscribeToken } from '../tokens.js'
import { registeredProviderNames, resolveProvider } from '../provider-lookup.js'
import { resolveVars } from '../adapters/vars.js'
import { isSuppressed } from './suppression.js'
import { advanceStep, failFlowRun } from './step.js'
import { getBucketStatus, recordHealthCounter } from './health.js'
import { pauseBroadcast } from './broadcast-control.js'
import { acquireRecipientLock, applyContactPolicy, contactPolicyApplies } from './contact-policy.js'
import { sendOrigin, type SendOutcome } from './send-hooks.js'
import type { RunnerContext } from './index.js'

export async function handleSend(
  run: FlowRunDoc,
  step: Extract<FlowStep, { type: 'send' }>,
  contact: Contact,
  flow: FlowDoc,
  ctx: RunnerContext,
): Promise<void> {
  const template = await ctx.collections.templates.findOne({ slug: step.templateSlug })
  if (!template) {
    await failFlowRun(run, `template not found: ${step.templateSlug}`, ctx)
    return
  }

  const dedupeKey = `flowrun:${run._id}:step${run.currentStepIndex}`

  // Idempotency: has this exact step already produced a send?
  const existing = await ctx.collections.sends.findOne({ dedupeKey })
  if (existing) {
    await advanceStep(run, ctx, {
      action: 'sent',
      details: { dedupeKey, alreadySent: true, sendId: String(existing._id) },
    })
    return
  }

  const providerName = pickProviderName(step.providerOverride, template, ctx)

  // Render now (with fresh contact + vars). Tracking application happens in
  // dispatchSend once we have the persisted sendId.
  const renderCtx = buildRenderContext(contact, run, step.vars ?? {}, ctx, {}, undefined, template.category)
  let rendered
  try {
    rendered = await renderTemplate(template, renderCtx, { helpers: ctx.handlebarsHelpers })
  } catch (err: any) {
    await ctx.collections.sends.insertOne(
      newSendDoc({
        dedupeKey,
        run,
        contact,
        template,
        flow,
        providerName,
        renderedSubject: template.subject,
        bodyHash: '',
        status: 'failed',
        errorMessage: `render error: ${err?.message ?? err}`,
      }),
    )
    await advanceStep(run, ctx, {
      action: 'send_skipped',
      details: { reason: 'render_error', message: String(err?.message ?? err) },
    })
    return
  }

  const sendId = new ObjectId()
  await ctx.collections.sends.insertOne(
    newSendDoc({
      _id: sendId,
      dedupeKey,
      run,
      contact,
      template,
      flow,
      providerName,
      renderedSubject: rendered.subject,
      bodyHash: sha256(rendered.html),
      status: 'queued',
      renderedFrom: rendered.fromName ? { name: rendered.fromName, email: rendered.fromEmail } : undefined,
      vars: step.vars ?? {},
    }),
  )

  await ctx.queues.send.add(
    'send',
    { sendId: String(sendId) },
    { attempts: ctx.config.sendRetryAttempts, backoff: { type: 'exponential', delay: 60_000 } },
  )

  await advanceStep(run, ctx, { action: 'sent', details: { dedupeKey, sendId: String(sendId) } })
}

// ---------------------------------------------------------------------------
// Send worker entry point
// ---------------------------------------------------------------------------

export async function dispatchSend(sendId: ObjectId, ctx: RunnerContext): Promise<void> {
  // Atomic claim: flip queued/failed → sending so exactly one worker proceeds.
  // The stranded-send sweep and the queue's stalled-job retry can both fire a
  // job for the same send; a read-then-act status check lets both through and
  // the recipient gets the email twice. Every downstream path writes a
  // terminal status (or resets to 'queued' for the breaker retry); a crash
  // leaves 'sending', which the stranded-send sweep resets after 5 minutes.
  //
  // 0.21: a `deferred` send is claimable once its `notBefore` has passed —
  // by its own delayed job or after `releaseDueDeferredSends` re-queues it.
  const claimedAt = new Date()
  const send = await ctx.collections.sends.findOneAndUpdate(
    {
      _id: sendId,
      $or: [
        { status: { $in: ['queued', 'failed'] } },
        { status: 'deferred', notBefore: { $lte: claimedAt } },
      ],
    },
    { $set: { status: 'sending', updatedAt: claimedAt } },
  )
  if (!send) return // already claimed / dispatched / cancelled / not yet due

  const template = await ctx.collections.templates.findOne({ _id: send.templateId })
  if (!template) {
    await markFailed(send, 'template_missing', ctx)
    return
  }

  // A broadcast send follows its broadcast: nothing leaves while it is
  // paused (stop rule, circuit breaker, operator) or after it is cancelled.
  // Closes the race between a pause/cancel and a job already in the queue.
  // A wave parked at its cap is NOT a hold: its sends are the wave, queued
  // a moment before the broadcast parked, and they go out.
  if (send.broadcastId) {
    const broadcast = await ctx.collections.broadcasts.findOne(
      { _id: send.broadcastId },
      { projection: { status: 1, pauseReason: 1 } },
    )
    const holding = broadcast?.status === 'paused' && broadcast.pauseReason?.code !== 'cap_reached'
    if (holding || broadcast?.status === 'cancelled') {
      const held = holding
      await ctx.collections.sends.updateOne(
        { _id: send._id },
        {
          $set: {
            status: held ? 'held' : 'cancelled',
            errorMessage: held ? `held: broadcast paused (${broadcast.pauseReason?.code ?? 'unknown'})` : 'cancelled: broadcast cancelled',
            updatedAt: new Date(),
          },
        },
      )
      if (!held) {
        await emitOutcome(send, { status: 'cancelled', errorMessage: 'cancelled: broadcast cancelled' }, { status: 'cancelled', exitReason: null, message: 'broadcast cancelled' }, ctx)
      }
      return
    }
  }

  // 1. Suppression check (INVARIANT 3: always re-checked at send time).
  const supp = await isSuppressed(ctx.collections, send.emailAtSend, send.kind, template.category)
  if (supp.suppressed) {
    await ctx.collections.sends.updateOne(
      { _id: send._id },
      { $set: { status: 'suppressed', errorMessage: `suppressed: ${supp.reason}` } },
    )
    await emitOutcome(send, { status: 'suppressed', errorMessage: `suppressed: ${supp.reason}` }, { status: 'suppressed', scope: supp.scope ?? null }, ctx)
    return
  }

  // 2. Circuit-breaker check (only blocks marketing). The breaker is scoped
  // per (senderDomain, kind) bucket — one bad subdomain doesn't hold mail for
  // the others.
  if (send.kind === 'marketing') {
    const bucket = await getBucketStatus(ctx, send.fromEmail, send.kind)
    if (bucket?.status === 'tripped' && send.broadcastId) {
      // A broadcast send does not loop on a 60s retry for as long as the
      // breaker stays tripped (for a large broadcast, thousands of jobs that
      // all fire the moment it is reset). Its broadcast pauses, the send is
      // held with the rest, and an explicit resume re-queues them.
      await ctx.collections.sends.updateOne(
        { _id: send._id },
        { $set: { status: 'held', errorMessage: 'held: circuit breaker tripped', updatedAt: new Date() } },
      )
      await pauseBroadcast(ctx, send.broadcastId, {
        code: 'circuit_breaker',
        message: `the ${bucket.senderDomain ?? 'sender'} ${send.kind} circuit breaker is tripped: ${bucket.trippedReason ?? 'no reason recorded'}`,
        at: new Date(),
        details: { bucket: bucket._id },
      })
      return
    }
    if (bucket?.status === 'tripped') {
      // Release the claim so the delayed retry can re-claim it.
      await ctx.collections.sends.updateOne(
        { _id: send._id },
        { $set: { status: 'queued', updatedAt: new Date() } },
      )
      await ctx.queues.send.add('send', { sendId: String(send._id) }, { delay: 60_000 })
      return
    }
  }

  // 3. Pull the contact + re-render (use the contact that exists now, not at flow entry).
  const contact = await ctx.adapter.getById(send.externalId)
  if (!contact) {
    await markFailed(send, 'contact_missing', ctx)
    return
  }

  // No address to send to: the row was queued without one, or the host blanked
  // the contact's email after it was queued (an account deletion between a
  // flow's send step and dispatch). The provider rejects these outright, so it
  // is permanent — fail it once, without the failedToSend counter (nothing
  // reached a provider) and without throwing into the retry policy.
  if (!send.emailAtSend?.trim() || !contact.email?.trim()) {
    await markFailed(send, 'no_recipient: the contact has no email address', ctx)
    return
  }

  // Origin guard (INVARIANT 19): the originating system may veto the send at
  // the last moment. Runs on every dispatch — a deferred send's re-dispatch
  // included — after suppression and the breaker and BEFORE the contact
  // policy, so a send that should be cancelled is never deferred first. The
  // flow guard closes the race where a send is enqueued between a flow
  // abort's cancellation sweep and dispatch. A guard that throws fails the
  // send closed: nothing is sent and the error reaches the queue's retry.
  const hooks = ctx.sendHooks?.[sendOrigin(send)]
  if (hooks?.guard) {
    let verdict
    try {
      verdict = await hooks.guard(send, ctx)
    } catch (err: any) {
      await releaseClaimAfterError(send, `guard error: ${String(err?.message ?? err)}`, ctx)
      throw err
    }
    if (verdict.verdict === 'cancel') {
      const patch = {
        status: 'cancelled' as const,
        errorMessage: `cancelled: ${verdict.message}`,
        ...(verdict.exitReason ? { exitReason: verdict.exitReason } : {}),
      }
      await ctx.collections.sends.updateOne({ _id: send._id }, { $set: { ...patch, updatedAt: new Date() } })
      await emitOutcome(send, patch, { status: 'cancelled', exitReason: verdict.exitReason, message: verdict.message }, ctx)
      return
    }
  }

  // Contact policy (marketing only; a no-op without `contactPolicy`). Holds a
  // per-recipient lock from the decision until the send row is final, so two
  // dispatches to one address cannot both read an empty history.
  let release: (() => Promise<void>) | null = null
  if (contactPolicyApplies(ctx, send)) {
    release = await acquireRecipientLock(ctx, send.emailAtSend)
    if (!release) {
      // The address stayed busy for the whole wait. Hand the claim back and retry shortly.
      await ctx.collections.sends.updateOne({ _id: send._id }, { $set: { status: 'queued', updatedAt: new Date() } })
      await ctx.queues.send.add('send', { sendId: String(send._id) }, { delay: 5_000 })
      return
    }
  }
  try {
    if (contactPolicyApplies(ctx, send)) {
      const now = new Date()
      let decision
      try {
        decision = await applyContactPolicy(ctx, send, contact, now)
      } catch (err: any) {
        await releaseClaimAfterError(send, `contact policy error: ${String(err?.message ?? err)}`, ctx)
        throw err
      }
      if (decision.action === 'defer') {
        const prior = send.policyDeferral
        const policyDeferral = {
          reason: decision.reason,
          firstDeferredAt: prior?.firstDeferredAt ?? now,
          count: (prior?.count ?? 0) + 1,
        }
        await ctx.collections.sends.updateOne(
          { _id: send._id },
          { $set: { status: 'deferred', notBefore: decision.notBefore, policyDeferral, updatedAt: now } },
        )
        await ctx.queues.send.add(
          'send',
          { sendId: String(send._id) },
          {
            delay: Math.max(0, decision.notBefore.getTime() - now.getTime()),
            attempts: ctx.config.sendRetryAttempts,
            backoff: { type: 'exponential', delay: 60_000 },
          },
        )
        await emitOutcome(
          send,
          { status: 'deferred', notBefore: decision.notBefore, policyDeferral },
          { status: 'deferred', notBefore: decision.notBefore, reason: decision.reason },
          ctx,
        )
        return
      }
      if (decision.action === 'drop') {
        const message = `policy_expired: held back by ${decision.reason} until ${decision.wouldBe.toISOString()}, past the deferral limit`
        const patch = { status: 'cancelled' as const, exitReason: 'policy_expired' as const, errorMessage: `cancelled: ${message}` }
        await ctx.collections.sends.updateOne({ _id: send._id }, { $set: { ...patch, updatedAt: now } })
        await emitOutcome(send, patch, { status: 'cancelled', exitReason: 'policy_expired', message }, ctx)
        return
      }
    }

    const run = send.flowRunId ? await ctx.collections.flowRuns.findOne({ _id: send.flowRunId }) : null
    await deliver(send, template, contact, run, ctx)
  } finally {
    if (release) await release()
  }
}

/** Render, track and hand the claimed send to its provider. */
async function deliver(
  send: SendDoc,
  template: TemplateDoc,
  contact: Contact,
  run: FlowRunDoc | null,
  ctx: RunnerContext,
): Promise<void> {
  // Resolve host vars + render. A throw here (host DB hiccup, bad template)
  // marks the send failed and rethrows so the queue retries with backoff —
  // never dispatch a half-rendered email.
  let renderCtx: RenderContext
  let rendered: Awaited<ReturnType<typeof renderTemplate>>
  try {
    const resolved = await resolveVars(ctx.varsAdapter, contact, {
      reason: 'send',
      templateSlug: template.slug,
      flowSlug: run?.flowSlug,
      eventName: run?.triggerEvent?.name,
      eventProperties: run?.triggerEvent?.properties,
    })
    renderCtx = buildRenderContext(contact, run, send.vars ?? {}, ctx, resolved, String(send._id), template.category)
    rendered = await renderTemplate(template, renderCtx, { helpers: ctx.handlebarsHelpers })
  } catch (err: any) {
    await markFailed(send, `render error: ${String(err?.message ?? err)}`, ctx)
    throw err // let the queue retry per the attempts policy
  }

  // 4. Apply tracking using the now-known send id.
  //
  // text_only skips this entirely: the open pixel needs an HTML part to live
  // in, and click rewriting would replace readable URLs with opaque redirects
  // in text a recipient reads literally — the opposite of what the format is
  // for. Such a send reports no opens and no clicks by design.
  const textOnly = template.bodyFormat === 'text_only'
  const tracking = textOnly
    ? { html: '', links: [] as Array<{ linkId: string; url: string }> }
    : applyTracking(rendered.html, {
        sendId: String(send._id),
        publicUrl: ctx.config.publicUrl,
        trackOpens: template.trackOpens ?? ctx.config.trackOpens,
        trackClicks: template.trackClicks ?? ctx.config.trackClicks,
        preserveUrls: [renderCtx.unsubscribeUrl],
        signingSecret: ctx.config.unsubscribeSecret,
      })

  await ctx.collections.sends.updateOne(
    { _id: send._id },
    {
      $set: {
        links: tracking.links,
        // Hash what actually goes out, so a text_only send's fingerprint
        // tracks the text body rather than an HTML part it never had.
        bodyHash: sha256(textOnly ? rendered.plainText : tracking.html),
        status: 'sending',
        fromName: rendered.fromName,
        fromEmail: rendered.fromEmail,
        subject: rendered.subject,
        updatedAt: new Date(),
      },
    },
  )

  // 5. Provider dispatch.
  //
  // Guarded lookup (see provider-lookup.ts): a bare `ctx.providers[name]` also
  // resolves inherited Object.prototype keys, so a send row whose `provider` is
  // `constructor` or `toString` used to yield a truthy non-provider that blew up
  // on `.send(...)` further down — inside the try/catch below, so it surfaced as
  // a failed send reading "provider.send is not a function" and then burned the
  // full retry budget on a config error no retry can fix.
  //
  // No fallback to the default provider. `send.provider` is written by
  // pickProviderName, which has *already* applied the default; if the name on
  // the row still doesn't resolve it is stale, renamed or mistyped, and quietly
  // routing the mail through a different provider than the row records would
  // send it from the wrong reputation and hide the misconfiguration. Fail this
  // one send with a reason an operator can act on, exactly like the
  // template_missing / contact_missing paths above: no throw, so the send's
  // queue job settles instead of retrying, and nothing else in flight is
  // affected.
  const provider = resolveProvider(ctx.providers, send.provider)
  if (!provider) {
    const known = registeredProviderNames(ctx.providers)
    await markFailed(
      send,
      `provider_unknown: no provider is registered as "${send.provider}". ` +
        `Registered providers: ${known.length ? known.join(', ') : '(none)'}.`,
      ctx,
    )
    return
  }

  // List-Unsubscribe belongs on bulk mail only. The unsubscribe token is
  // scoped 'marketing', so advertising one-click unsub on a password reset
  // both misrepresents the header and offers an opt-out that wouldn't stop
  // the transactional mail the recipient is looking at.
  const headers: Record<string, string> =
    send.kind === 'marketing'
      ? {
          'List-Unsubscribe': `<${renderCtx.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          ...(template.category ? { 'List-ID': `<${template.category}.${senderDomain(rendered.fromEmail)}>` } : {}),
        }
      : {}

  let sentAt: Date
  try {
    const result = await provider.send({
      to: send.emailAtSend,
      fromName: rendered.fromName,
      fromEmail: rendered.fromEmail,
      replyTo: rendered.replyTo ?? undefined,
      subject: rendered.subject,
      ...(textOnly ? {} : { html: tracking.html }),
      text: rendered.plainText,
      headers,
      messageMeta: { sendId: String(send._id) },
    })

    sentAt = new Date()
    await ctx.collections.sends.updateOne(
      { _id: send._id },
      {
        $set: {
          status: 'sent',
          sentAt,
          providerMessageId: result.providerId,
        },
      },
    )
    // Use send.fromEmail (same field getBucketStatus reads) so the breaker
    // gate and the counter record into the same bucket even if a
    // hypothetical render-time fromDefaults swap ever lands.
    await recordHealthCounter(ctx, 'sent', { fromEmail: send.fromEmail, kind: send.kind })
  } catch (err: any) {
    await ctx.collections.sends.updateOne(
      { _id: send._id },
      { $set: { status: 'failed', errorMessage: String(err?.message ?? err) } },
    )
    await recordHealthCounter(ctx, 'failedToSend', { fromEmail: send.fromEmail, kind: send.kind })
    await emitOutcome(send, { status: 'failed', errorMessage: String(err?.message ?? err) }, { status: 'failed', error: String(err?.message ?? err) }, ctx)
    if (ctx.config.onSendFailure) {
      try {
        await ctx.config.onSendFailure({ send, error: err })
      } catch {
        /* swallow */
      }
    }
    throw err // let BullMQ retry per the attempts policy
  }
  await emitOutcome(send, { status: 'sent', sentAt }, { status: 'sent', at: sentAt }, ctx)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickProviderName(stepOverride: string | undefined, tpl: TemplateDoc, ctx: RunnerContext): string {
  if (stepOverride) return stepOverride
  if (tpl.providerOverride) return tpl.providerOverride
  if (tpl.kind === 'transactional' && ctx.config.defaultTransactionalProvider) {
    return ctx.config.defaultTransactionalProvider
  }
  return ctx.config.defaultProvider
}

function senderDomain(fromEmail: string): string {
  return fromEmail.slice(fromEmail.lastIndexOf('@') + 1).toLowerCase()
}

function buildRenderContext(
  contact: Contact,
  run: FlowRunDoc | null,
  vars: Record<string, unknown>,
  ctx: RunnerContext,
  resolved: Record<string, unknown> = {},
  sendId?: string,
  category?: string | null,
): RenderContext {
  const scope = 'marketing'
  const expiresAt = new Date(Date.now() + ctx.config.unsubscribeTokenLifetimeDays * 24 * 60 * 60 * 1000)
  // The send id lets the one-click unsubscribe be attributed to this send
  // (and so to its broadcast's unsubscribe count and stop rule).
  const token = signUnsubscribeToken(
    { email: contact.email, scope, expiresAt, ...(sendId ? { sendId } : {}), ...(category ? { category } : {}) },
    ctx.config.unsubscribeSecret,
  )
  const unsubscribeUrl = `${ctx.config.publicUrl}/m/unsub/${token}`

  return {
    ...resolved,
    contact,
    vars,
    event: run?.triggerEvent?.properties ?? {},
    unsubscribeUrl,
    senderAddress: ctx.config.senderAddress,
  }
}

interface NewSendInput {
  _id?: ObjectId
  dedupeKey: string
  run: FlowRunDoc
  contact: Contact
  template: TemplateDoc
  flow: FlowDoc
  providerName: string
  renderedSubject: string
  bodyHash: string
  status: SendDoc['status']
  errorMessage?: string
  renderedFrom?: { name: string; email: string }
  vars?: Record<string, unknown>
}

function newSendDoc(input: NewSendInput): SendDoc {
  const now = new Date()
  return {
    _id: input._id,
    dedupeKey: input.dedupeKey,
    externalId: input.run.externalId,
    emailAtSend: input.contact.email,
    templateId: input.template._id!,
    templateSlug: input.template.slug,
    flowRunId: input.run._id!,
    broadcastId: null,
    manualSendBy: null,
    kind: input.template.kind,
    ...(input.template.category ? { category: input.template.category } : {}),
    provider: input.providerName,
    providerMessageId: null,
    fromName: input.renderedFrom?.name ?? input.template.fromName,
    fromEmail: input.renderedFrom?.email ?? input.template.fromEmail,
    subject: input.renderedSubject,
    bodyHash: input.bodyHash,
    status: input.status,
    errorMessage: input.errorMessage ?? null,
    bounceType: null,
    bounceReason: null,
    links: [],
    vars: input.vars ?? {},
    openedAt: null,
    openCount: 0,
    firstClickAt: null,
    clickCount: 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt: now,
    updatedAt: now,
    sentAt: null,
    deliveredAt: null,
  }
}

async function markFailed(send: SendDoc, reason: string, ctx: RunnerContext): Promise<void> {
  await ctx.collections.sends.updateOne(
    { _id: send._id },
    { $set: { status: 'failed', errorMessage: reason } },
  )
  await emitOutcome(send, { status: 'failed', errorMessage: reason }, { status: 'failed', error: reason }, ctx)
}

/**
 * An error thrown mid-dispatch (guard, policy lookup) would otherwise strand
 * the row in 'sending', which the queue's retry cannot claim. 'failed' is
 * claimable, so the retry picks it up; no outcome is reported for it.
 */
async function releaseClaimAfterError(send: SendDoc, reason: string, ctx: RunnerContext): Promise<void> {
  await ctx.collections.sends
    .updateOne({ _id: send._id }, { $set: { status: 'failed', errorMessage: reason, updatedAt: new Date() } })
    .catch(() => {})
}

/**
 * Tell the origin's `onOutcome` hook about a status transition. The row is
 * already written, so a throwing hook is logged rather than propagated: a
 * retry could not claim the send again and would only mask the real outcome.
 */
async function emitOutcome(
  send: SendDoc,
  patch: Partial<SendDoc>,
  outcome: SendOutcome,
  ctx: RunnerContext,
): Promise<void> {
  const hook = ctx.sendHooks?.[sendOrigin(send)]?.onOutcome
  if (!hook) return
  try {
    await hook({ ...send, ...patch }, outcome, ctx)
  } catch (err) {
    console.error(`mailery: onOutcome hook failed for send ${String(send._id)}`, err)
  }
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}
