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
import { resolveVars } from '../adapters/vars.js'
import { isSuppressed } from './suppression.js'
import { advanceStep, failFlowRun } from './step.js'
import { getBucketStatus, recordHealthCounter } from './health.js'
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
  const renderCtx = buildRenderContext(contact, run, step.vars ?? {}, ctx)
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
  const send = await ctx.collections.sends.findOne({ _id: sendId })
  if (!send) return
  if (send.status !== 'queued' && send.status !== 'failed') return // already dispatched / cancelled

  const template = await ctx.collections.templates.findOne({ _id: send.templateId })
  if (!template) {
    await markFailed(send._id!, 'template_missing', ctx)
    return
  }

  // 1. Suppression check (INVARIANT 3: always re-checked at send time).
  const supp = await isSuppressed(ctx.collections, send.emailAtSend, send.kind)
  if (supp.suppressed) {
    await ctx.collections.sends.updateOne(
      { _id: send._id },
      { $set: { status: 'suppressed', errorMessage: `suppressed: ${supp.reason}` } },
    )
    return
  }

  // 2. Circuit-breaker check (only blocks marketing). The breaker is scoped
  // per (senderDomain, kind) bucket — one bad subdomain doesn't hold mail for
  // the others.
  if (send.kind === 'marketing') {
    const bucket = await getBucketStatus(ctx, send.fromEmail, send.kind)
    if (bucket?.status === 'tripped') {
      await ctx.queues.send.add('send', { sendId: String(send._id) }, { delay: 60_000 })
      return
    }
  }

  // 3. Pull the contact + re-render (use the contact that exists now, not at flow entry).
  const contact = await ctx.adapter.getById(send.externalId)
  if (!contact) {
    await markFailed(send._id!, 'contact_missing', ctx)
    return
  }

  const run = send.flowRunId ? await ctx.collections.flowRuns.findOne({ _id: send.flowRunId }) : null

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
    renderCtx = buildRenderContext(contact, run, send.vars ?? {}, ctx, resolved)
    rendered = await renderTemplate(template, renderCtx, { helpers: ctx.handlebarsHelpers })
  } catch (err: any) {
    await markFailed(send._id!, `render error: ${String(err?.message ?? err)}`, ctx)
    throw err // let the queue retry per the attempts policy
  }

  // 4. Apply tracking using the now-known send id.
  const tracking = applyTracking(rendered.html, {
    sendId: String(send._id),
    publicUrl: ctx.config.publicUrl,
    trackOpens: template.trackOpens ?? ctx.config.trackOpens,
    trackClicks: template.trackClicks ?? ctx.config.trackClicks,
    preserveUrls: [renderCtx.unsubscribeUrl],
  })

  await ctx.collections.sends.updateOne(
    { _id: send._id },
    {
      $set: {
        links: tracking.links,
        bodyHash: sha256(tracking.html),
        status: 'sending',
        fromName: rendered.fromName,
        fromEmail: rendered.fromEmail,
        subject: rendered.subject,
        updatedAt: new Date(),
      },
    },
  )

  // 5. Provider dispatch.
  const provider = ctx.providers[send.provider] ?? ctx.providers[ctx.config.defaultProvider]
  if (!provider) {
    await markFailed(send._id!, `provider_unknown: ${send.provider}`, ctx)
    return
  }

  try {
    const result = await provider.send({
      to: send.emailAtSend,
      fromName: rendered.fromName,
      fromEmail: rendered.fromEmail,
      replyTo: rendered.replyTo ?? undefined,
      subject: rendered.subject,
      html: tracking.html,
      text: rendered.plainText,
      headers: {
        'List-Unsubscribe': `<${renderCtx.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      messageMeta: { sendId: String(send._id) },
    })

    await ctx.collections.sends.updateOne(
      { _id: send._id },
      {
        $set: {
          status: 'sent',
          sentAt: new Date(),
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
    if (ctx.config.onSendFailure) {
      try {
        await ctx.config.onSendFailure({ send, error: err })
      } catch {
        /* swallow */
      }
    }
    throw err // let BullMQ retry per the attempts policy
  }
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

function buildRenderContext(
  contact: Contact,
  run: FlowRunDoc | null,
  vars: Record<string, unknown>,
  ctx: RunnerContext,
  resolved: Record<string, unknown> = {},
): RenderContext {
  const scope = 'marketing'
  const expiresAt = new Date(Date.now() + ctx.config.unsubscribeTokenLifetimeDays * 24 * 60 * 60 * 1000)
  const token = signUnsubscribeToken(
    { email: contact.email, scope, expiresAt },
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

async function markFailed(sendId: ObjectId, reason: string, ctx: RunnerContext): Promise<void> {
  await ctx.collections.sends.updateOne(
    { _id: sendId },
    { $set: { status: 'failed', errorMessage: reason } },
  )
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}
