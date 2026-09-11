/**
 * Agent router — the mailery surface for automation.
 *
 * Everything an operator does by hand in the admin SPA to take an email
 * program from "deployed" to "safely on" — render a template as a real
 * contact and check it, send it through the real pipeline and watch delivery,
 * ask what a flow would do to a contact, walk a canary run step by step,
 * gate and arm a flow — is reachable here as JSON, behind a bearer token,
 * with no browser session. It is built for an AI agent or a CI job to drive,
 * which shapes three things:
 *
 *   - Every answer is structured. A verification is a list of named checks
 *     with pass/warn/fail, not a rendered page to squint at.
 *   - Every operation that could touch a real person is guarded by the
 *     `testContacts` pattern: test sends, event firing, run stepping and
 *     resets only apply to contacts whose email matches it. A router with no
 *     pattern configured refuses those routes outright rather than assuming.
 *   - Nothing here can enable a flow without stamping its trigger watermark
 *     (see runner/arm.ts), so an agent cannot replay a month of signups.
 *
 * Mount it beside the admin router, on a path the host's session middleware
 * does not cover, and give it the same JSON body the SPA would:
 *
 *   app.use('/admin/mailer/agent', createAgentRouter(mailer, {
 *     tokens: [{ token: process.env.MAILERY_AGENT_TOKEN!, actor: 'agent:claude' }],
 *     testContacts: /^qa\+.*@example\.com$/i,
 *   }))
 *
 * `GET /` describes every route so a client can discover the surface. The
 * full admin JSON API (docs/reference/admin-api.md) is mounted under `/api`
 * with the token's actor, so reads and existing operations need no second
 * auth path.
 */

import crypto from 'node:crypto'
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { ObjectId } from 'mongodb'
import { z } from 'zod'

import type { Mailer } from '../mailer.js'
import type { Contact } from '../../shared/types.js'
import { slugSchema } from '../../shared/schemas.js'
import type { FlowRunDoc, SendDoc, TemplateDoc } from '../models/index.js'
import { HEALTH_AGG_ID } from '../models/index.js'
import { createAdminApiRouter, type AdminRouterOptions } from './admin.js'
import { runSetupChecks } from './setup-status.js'
import { consoleRouteLogger, type RouteLogger } from './wrap.js'
import { derivePlaintext, renderTemplate, type RenderedTemplate } from '../templates/render.js'
import { lintTemplate } from '../templates/linter.js'
import { validateSenderDomain } from '../templates/sender-domain.js'
import { resolveVars, varsJsonSchema, RESERVED_VAR_KEYS } from '../adapters/vars.js'
import { signUnsubscribeToken } from '../tokens.js'
import { effectiveOverallStatus } from '../runner/health.js'
import { runTick } from '../runner/tick.js'
import { dispatchSend } from '../runner/send.js'
import { webhookEventsForMessageId } from '../runner/webhook.js'
import { processOneRunStep, exitFlowRun } from '../runner/step.js'
import {
  armFlow,
  disarmFlow,
  gateFlow,
  ungateFlow,
  isCanaryGate,
  FlowOperationError,
} from '../runner/arm.js'
import { simulateFlow } from '../runner/simulate.js'
import {
  BroadcastOperationError,
  agentCreateBroadcastSchema,
  agentPatchBroadcastSchema,
  agentScheduleBroadcastSchema,
  broadcastStatusBreakdown,
  broadcastSummary,
  cancelBroadcast,
  computeBroadcastStats,
  createBroadcast,
  emptyBroadcastStats,
  loadBroadcast,
  patchBroadcast,
  scheduleBroadcast,
} from './broadcast-ops.js'

declare const __PKG_VERSION__: string | undefined
const VERSION = typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : 'dev'

/**
 * Body of `PUT /templates/:slug`: the published fields of a `TemplateDoc`,
 * minus what the server owns (timestamps, stats, draft). Defaults mirror what
 * the admin publish route writes for a template created in the SPA.
 */
const agentTagsInputSchema = z.object({
  add: z.array(z.string().min(1).max(128)).max(25).default([]),
  remove: z.array(z.string().min(1).max(128)).max(25).default([]),
})

const publishTemplateInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  kind: z.enum(['marketing', 'transactional']),
  fromName: z.string().min(1).max(200),
  fromEmail: z.string().email(),
  replyTo: z.string().email().nullable().default(null),
  providerOverride: z.string().min(1).nullable().default(null),
  subject: z.string().min(1).max(998),
  preheader: z.string().max(998).default(''),
  body: z.object({
    mjml: z.string().default(''),
    editorJson: z.record(z.string(), z.unknown()).nullable().default(null),
    html: z.string().default(''),
    plainText: z.string().default(''),
  }),
  variablesSchema: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string().min(1).max(100)).max(50).default([]),
  bodyFormat: z.enum(['multipart', 'text_only']).default('multipart'),
  trackOpens: z.boolean().default(true),
  trackClicks: z.boolean().default(true),
  /** Recorded as the publisher; defaults to the token's actor. */
  publishedBy: z.string().min(1).max(200).optional(),
})

export interface AgentToken {
  /** The bearer token. At least 24 characters; generate it, never type it. */
  token: string
  /** Audit actor recorded for everything done with this token, e.g. `agent:claude`. */
  actor: string
}

export interface AgentRouterOptions {
  /** Required. The router refuses to construct without at least one token. */
  tokens: AgentToken[]
  /**
   * Which contacts may be test-sent to, stepped through flows, fired events
   * for, or reset. A regular expression over the email address, or a
   * predicate. Routes that need it answer 403 when it is not configured —
   * the safe default for a surface an automated caller drives.
   */
  testContacts?: RegExp | ((email: string) => boolean)
  /** Structured logger for failures. Defaults to console. */
  logger?: RouteLogger
  /** Passed through to the admin JSON API (tests inject a stub). */
  mailTesterClient?: AdminRouterOptions['mailTesterClient']
}

export const MIN_AGENT_TOKEN_LENGTH = 24

type Check = { id: string; status: 'pass' | 'warn' | 'fail'; detail?: unknown }

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAgentRouter(mailer: Mailer, opts: AgentRouterOptions): Router {
  if (!opts || !Array.isArray(opts.tokens) || opts.tokens.length === 0) {
    throw new Error('createAgentRouter: at least one bearer token is required — the agent API is never open')
  }
  for (const t of opts.tokens) {
    if (typeof t?.token !== 'string' || t.token.length < MIN_AGENT_TOKEN_LENGTH) {
      throw new Error(
        `createAgentRouter: every token must be at least ${MIN_AGENT_TOKEN_LENGTH} characters (got ${t?.token?.length ?? 0})`,
      )
    }
    if (typeof t.actor !== 'string' || !t.actor.trim()) {
      throw new Error('createAgentRouter: every token needs an actor label, e.g. "agent:claude"')
    }
  }
  const logger = opts.logger ?? consoleRouteLogger
  const isTestContact = testContactMatcher(opts.testContacts)
  const c = mailer.collections
  const varsSchema = mailer.config.varsAdapter ? varsJsonSchema(mailer.config.varsAdapter) : null

  const router = Router()
  router.use(express.json({ limit: '1mb' }))
  router.use(bearerAuth(opts.tokens))

  // The admin JSON API, verbatim, with this token's actor.
  router.use('/api', createAdminApiRouter(mailer, { mailTesterClient: opts.mailTesterClient }))

  const actorOf = (req: Request): string => String((req as any).actor)

  /** 403 unless the contact matches `testContacts`. Responds itself. */
  function guardTestContact(res: Response, contact: Contact): boolean {
    if (!isTestContact) {
      res.status(403).json({
        error: 'test_contacts_not_configured',
        message:
          'this route only acts on test contacts, and the router was constructed without a testContacts pattern',
      })
      return false
    }
    if (!isTestContact(contact.email)) {
      res.status(403).json({
        error: 'not_a_test_contact',
        message: `${contact.email} does not match the testContacts pattern`,
        externalId: contact.externalId,
      })
      return false
    }
    return true
  }

  async function loadContact(res: Response, externalId: string): Promise<Contact | null> {
    const contact = await mailer.adapter.getById(externalId)
    if (!contact) res.status(404).json({ error: 'contact_not_found', externalId })
    return contact
  }

  async function loadTemplate(res: Response, slug: string): Promise<TemplateDoc | null> {
    const tpl = await c.templates.findOne({ slug })
    if (!tpl) res.status(404).json({ error: 'template_not_found', slug })
    return tpl
  }

  // ----- Discovery -----------------------------------------------------------
  router.get('/', (req, res) => {
    res.json({
      service: 'mailery-agent',
      version: VERSION,
      actor: actorOf(req),
      testContactsConfigured: !!isTestContact,
      docs: 'https://jeffjassky.github.io/mailery/reference/agent-api',
      endpoints: ENDPOINTS,
    })
  })

  // ----- Templates: verify / render / real sends -----------------------------
  router.post(
    '/templates/:slug/verify',
    wrap(async (req, res) => {
      const tpl = await loadTemplate(res, String(req.params.slug))
      if (!tpl) return
      const contact = await contactForRender(req, res)
      if (!contact) return
      const report = await verifyTemplate(mailer, tpl, contact, {
        eventProperties: objectOrUndefined(req.body?.eventProperties),
        vars: objectOrUndefined(req.body?.vars),
        includeRendered: req.body?.includeRendered === true,
        varsSchema,
      })
      res.status(200).json(report)
    }),
  )

  router.post(
    '/templates/verify-all',
    wrap(async (req, res) => {
      const slugs: string[] | null = Array.isArray(req.body?.slugs) ? req.body.slugs.map(String) : null
      const contactIds: string[] = Array.isArray(req.body?.contactIds) ? req.body.contactIds.map(String) : []
      if (contactIds.length === 0) {
        return res.status(400).json({ error: 'validation_failed', message: 'contactIds (non-empty array) is required' })
      }
      const templates = await c.templates
        .find(slugs ? { slug: { $in: slugs } } : {})
        .sort({ slug: 1 })
        .toArray()
      const contacts: Contact[] = []
      for (const id of contactIds) {
        const found = await mailer.adapter.getById(id)
        if (!found) return res.status(404).json({ error: 'contact_not_found', externalId: id })
        contacts.push(found)
      }
      const results: Array<{
        slug: string
        contactId: string
        ok: boolean
        failed: string[]
        warned: string[]
      }> = []
      for (const tpl of templates) {
        for (const contact of contacts) {
          const report = await verifyTemplate(mailer, tpl, contact, {
            eventProperties: objectOrUndefined(req.body?.eventProperties),
            includeRendered: false,
            varsSchema,
          })
          results.push({
            slug: tpl.slug,
            contactId: contact.externalId,
            ok: report.ok,
            failed: report.checks.filter((k) => k.status === 'fail').map((k) => k.id),
            warned: report.checks.filter((k) => k.status === 'warn').map((k) => k.id),
          })
        }
      }
      const failing = results.filter((r) => !r.ok)
      res.json({
        ok: failing.length === 0,
        templates: templates.length,
        contacts: contacts.length,
        verified: results.length,
        failing: failing.length,
        results,
      })
    }),
  )

  router.post(
    '/templates/:slug/render',
    wrap(async (req, res) => {
      const tpl = await loadTemplate(res, String(req.params.slug))
      if (!tpl) return
      const contact = await contactForRender(req, res)
      if (!contact) return
      const out = await renderForContact(mailer, tpl, contact, {
        reason: 'preview',
        eventProperties: objectOrUndefined(req.body?.eventProperties),
        vars: objectOrUndefined(req.body?.vars),
      })
      res.json({
        template: { slug: tpl.slug, kind: tpl.kind },
        contact: { externalId: contact.externalId, email: contact.email },
        subject: out.rendered.subject,
        preheader: out.rendered.preheader,
        fromName: out.rendered.fromName,
        fromEmail: out.rendered.fromEmail,
        replyTo: out.rendered.replyTo,
        html: out.rendered.html,
        plainText: out.rendered.plainText,
        resolvedVars: out.resolved,
        unsubscribeUrl: out.unsubscribeUrl,
      })
    }),
  )

  /**
   * A REAL send: a `mailer_sends` row, the queue, the provider, tracking and
   * webhook attribution — everything a flow send gets — to a test contact.
   * This is how an automated check proves delivery end to end: send, then
   * `GET /sends/:id/wait?status=delivered`.
   */
  router.post(
    '/templates/:slug/send',
    wrap(async (req, res) => {
      const tpl = await loadTemplate(res, String(req.params.slug))
      if (!tpl) return
      const contactId = typeof req.body?.contactId === 'string' ? req.body.contactId : ''
      if (!contactId) return res.status(400).json({ error: 'validation_failed', message: 'contactId is required' })
      const contact = await loadContact(res, contactId)
      if (!contact) return
      if (!guardTestContact(res, contact)) return
      if (!tpl.body?.html && !tpl.body?.mjml) {
        return res.status(409).json({ error: 'not_published', message: 'template has no published body' })
      }
      const dedupeKey =
        typeof req.body?.dedupeKey === 'string' && req.body.dedupeKey ? String(req.body.dedupeKey) : `agent:${crypto.randomUUID()}`
      const { sendId } = await mailer.sendOneOff({
        templateSlug: tpl.slug,
        externalId: contact.externalId,
        dedupeKey,
        vars: objectOrUndefined(req.body?.vars),
      })
      const dispatchNow = req.body?.dispatch !== 'queue'
      if (dispatchNow) {
        await dispatchSend(new ObjectId(sendId), mailer.getRunnerContext())
      }
      const send = await c.sends.findOne({ _id: new ObjectId(sendId) })
      await mailer.audit({
        actor: actorOf(req),
        action: 'agent.send',
        resource: { collection: 'mailer_sends', id: new ObjectId(sendId), slug: tpl.slug },
        diffSummary: `to=${contact.email} dispatch=${dispatchNow ? 'now' : 'queue'} dedupeKey=${dedupeKey}`,
      })
      res.status(201).json({ sendId, dedupeKey, dispatched: dispatchNow, send: send ? sendSummary(send) : null })
    }),
  )

  /**
   * Publish a compiled template document — the deploy-script path over HTTP.
   *
   * `POST /api/templates/:slug/publish` compiles a draft (MJML or editor
   * JSON). A program authored as hand-built HTML has no draft to compile, so
   * until now its only way into `mailer_templates` was a direct database
   * write with the production credential — exactly the credential an agent or
   * a CI job should not hold. This takes the published fields as JSON, runs
   * the sender-domain and lint gates the publish route runs, and upserts on
   * slug. `createdAt` and `stats` are the document's history and are written
   * only on insert: send counters belong to the runner and survive a redeploy.
   *
   * Not gated by `testContacts`: a template is inert until a flow references
   * its slug, so publishing one touches no real person.
   */
  router.put(
    '/templates/:slug',
    wrap(async (req, res) => {
      const slugParse = slugSchema.safeParse(String(req.params.slug))
      if (!slugParse.success) {
        return res.status(400).json({ error: 'validation_failed', message: 'slug must be lowercase letters, digits and hyphens' })
      }
      const slug = slugParse.data
      const parsed = publishTemplateInputSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return res.status(400).json({
          error: 'validation_failed',
          message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        })
      }
      const input = parsed.data
      if (!input.body.html.trim()) {
        return res.status(400).json({
          error: 'empty_body',
          message: 'body.html is required — this route publishes compiled HTML; a draft goes through POST /api/templates/:slug/publish',
        })
      }
      const senderCheck = validateSenderDomain(input.fromEmail, input.kind, mailer.config.senderDomains)
      if (!senderCheck.ok) {
        return res.status(400).json({ error: 'sender_domain_invalid', code: senderCheck.code, message: senderCheck.reason })
      }
      const plainText = input.body.plainText.trim() ? input.body.plainText : derivePlaintext(input.body.html)
      const lint = lintTemplate(
        {
          subject: input.subject,
          preheader: input.preheader,
          mjml: input.body.mjml,
          editorJson: input.body.editorJson ?? undefined,
          html: input.body.html,
          plainText,
          kind: input.kind,
          fromEmail: input.fromEmail,
        },
        {
          senderDomains: mailer.config.senderDomains,
          varsJsonSchema: varsSchema,
          publicUrl: mailer.config.publicUrl,
          linkDomains: mailer.config.linkDomains,
        },
      )
      if (lint.errors.length > 0) {
        return res.status(422).json({
          error: 'lint_failed',
          message: `Template publish blocked by ${lint.errors.length} content issue(s).`,
          lint,
        })
      }

      const now = new Date()
      const publishedBy = input.publishedBy ?? actorOf(req)
      const set = {
        slug,
        name: input.name,
        description: input.description,
        kind: input.kind,
        fromName: input.fromName,
        fromEmail: input.fromEmail,
        replyTo: input.replyTo,
        providerOverride: input.providerOverride,
        subject: input.subject,
        preheader: input.preheader,
        body: {
          mjml: input.body.mjml,
          editorJson: input.body.editorJson,
          html: input.body.html,
          plainText,
          compiledAt: now,
        },
        variablesSchema: input.variablesSchema as TemplateDoc['variablesSchema'],
        draft: null,
        tags: input.tags,
        bodyFormat: input.bodyFormat,
        trackOpens: input.trackOpens,
        trackClicks: input.trackClicks,
        publishedAt: now,
        publishedBy,
        updatedAt: now,
      }
      const result = await c.templates.updateOne(
        { slug },
        {
          $set: set,
          $setOnInsert: {
            createdAt: now,
            stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, lastSentAt: null },
          },
        },
        { upsert: true },
      )
      const created = result.upsertedCount > 0
      const stored = await c.templates.findOne({ slug })
      await mailer.audit({
        actor: actorOf(req),
        action: 'agent.template.publish',
        resource: { collection: 'mailer_templates', id: stored?._id, slug },
        diffSummary: `${created ? 'created' : 'updated'} kind=${input.kind} html=${Buffer.byteLength(input.body.html, 'utf8')}B trackOpens=${input.trackOpens} trackClicks=${input.trackClicks}`,
      })
      res.status(created ? 201 : 200).json({
        slug,
        created,
        lint: { warnings: lint.warnings, infos: lint.infos },
        template: {
          slug,
          kind: input.kind,
          subject: input.subject,
          fromEmail: input.fromEmail,
          trackOpens: input.trackOpens,
          trackClicks: input.trackClicks,
          publishedAt: now,
          publishedBy,
        },
      })
    }),
  )

  // ----- Sends ------------------------------------------------------------------
  router.get(
    '/sends/:id/wait',
    wrap(async (req, res) => {
      const id = String(req.params.id)
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'bad_id' })
      const target = String(req.query.status ?? 'delivered')
      if (!WAIT_TARGETS.has(target)) {
        return res.status(400).json({ error: 'validation_failed', message: `status must be one of ${[...WAIT_TARGETS].join(', ')}` })
      }
      const timeoutMs = Math.max(0, Math.min(Number(req.query.timeoutMs ?? 30_000) || 0, 55_000))
      const started = Date.now()
      let send: SendDoc | null = null
      let reached = false
      for (;;) {
        send = await c.sends.findOne({ _id: new ObjectId(id) })
        if (!send) return res.status(404).json({ error: 'not_found' })
        reached = waitTargetReached(send, target)
        if (reached || Date.now() - started >= timeoutMs) break
        await sleep(1000)
      }
      const webhookEvents = send.providerMessageId
        ? await c.webhookEvents.find(webhookEventsForMessageId(send.providerMessageId)).sort({ receivedAt: 1 }).limit(100).toArray()
        : []
      res.json({ reached, target, waitedMs: Date.now() - started, send: sendSummary(send), webhookEvents })
    }),
  )

  router.post(
    '/sends/:id/dispatch',
    wrap(async (req, res) => {
      const id = String(req.params.id)
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'bad_id' })
      const send = await c.sends.findOne({ _id: new ObjectId(id) })
      if (!send) return res.status(404).json({ error: 'not_found' })
      const contact = await loadContact(res, send.externalId)
      if (!contact) return
      if (!guardTestContact(res, contact)) return
      await dispatchSend(send._id!, mailer.getRunnerContext())
      const after = await c.sends.findOne({ _id: send._id })
      res.json({ send: after ? sendSummary(after) : null })
    }),
  )

  // ----- Flows: simulate / arm / disarm / gate / ungate ----------------------------
  router.post(
    '/flows/:slug/simulate',
    wrap(async (req, res) => {
      const flow = await c.flows.findOne({ slug: String(req.params.slug) })
      if (!flow) return res.status(404).json({ error: 'flow_not_found', slug: String(req.params.slug) })
      const contactId = typeof req.body?.contactId === 'string' ? req.body.contactId : ''
      if (!contactId) return res.status(400).json({ error: 'validation_failed', message: 'contactId is required' })
      const contact = await loadContact(res, contactId)
      if (!contact) return
      let at: Date | undefined
      if (req.body?.at) {
        at = new Date(String(req.body.at))
        if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'validation_failed', message: 'at must be an ISO date' })
      }
      let steps = undefined as undefined | typeof flow.steps
      if (req.body?.version !== undefined) {
        const v = Number(req.body.version)
        if (v !== flow.version) {
          const snap = await c.flowVersions.findOne({ flowId: flow._id!, version: v })
          if (!snap) return res.status(404).json({ error: 'version_not_found', version: v })
          steps = snap.steps
        }
      }
      const result = await simulateFlow(flow, contact, mailer.getRunnerContext(), {
        at,
        eventProperties: objectOrUndefined(req.body?.eventProperties),
        steps,
      })
      res.json(result)
    }),
  )

  router.post(
    '/flows/:slug/arm',
    wrap(async (req, res) => {
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: 'confirm_required',
          message: 'arming enables a flow for every future matching event; pass {"confirm": true}',
        })
      }
      let since: Date | undefined
      if (req.body?.since) {
        since = new Date(String(req.body.since))
        if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'validation_failed', message: 'since must be an ISO date' })
      }
      const result = await armFlow(mailer, String(req.params.slug), { actor: actorOf(req), since })
      res.json(result)
    }),
  )

  router.post(
    '/flows/:slug/disarm',
    wrap(async (req, res) => {
      res.json(await disarmFlow(mailer, String(req.params.slug), actorOf(req)))
    }),
  )

  router.post(
    '/flows/:slug/gate',
    wrap(async (req, res) => {
      const tag = typeof req.body?.tag === 'string' ? req.body.tag : ''
      res.json(await gateFlow(mailer, String(req.params.slug), { tag, actor: actorOf(req) }))
    }),
  )

  router.post(
    '/flows/:slug/ungate',
    wrap(async (req, res) => {
      res.json(await ungateFlow(mailer, String(req.params.slug), { actor: actorOf(req) }))
    }),
  )

  // ----- Runs: list / inspect / advance / cancel --------------------------------
  router.get(
    '/runs',
    wrap(async (req, res) => {
      const filter: Record<string, unknown> = {}
      if (typeof req.query.externalId === 'string') filter.externalId = req.query.externalId
      if (typeof req.query.flowSlug === 'string') filter.flowSlug = req.query.flowSlug
      if (typeof req.query.status === 'string') filter.status = req.query.status
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200)
      const runs = await c.flowRuns.find(filter).sort({ enteredAt: -1 }).limit(limit).toArray()
      res.json(runs.map(runSummary))
    }),
  )

  router.get(
    '/runs/:id',
    wrap(async (req, res) => {
      const id = String(req.params.id)
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'bad_id' })
      const run = await c.flowRuns.findOne({ _id: new ObjectId(id) })
      if (!run) return res.status(404).json({ error: 'not_found' })
      const sends = await c.sends.find({ flowRunId: run._id }).sort({ queuedAt: 1 }).toArray()
      res.json({ run, sends: sends.map(sendSummary) })
    }),
  )

  /**
   * Walk a run forward NOW, skipping the waits in front of each step. The
   * published timings stay exactly as they are — only this one run, for this
   * one test contact, is hurried. Each requested step is one actionable
   * transition (condition, branch, send, ...); a wait in the way is completed
   * immediately and does not count. Sends created on the way are dispatched
   * inline so the email actually leaves.
   */
  router.post(
    '/runs/:id/advance',
    wrap(async (req, res) => {
      const id = String(req.params.id)
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'bad_id' })
      const run = await c.flowRuns.findOne({ _id: new ObjectId(id) })
      if (!run) return res.status(404).json({ error: 'not_found' })
      const contact = await loadContact(res, run.externalId)
      if (!contact) return
      if (!guardTestContact(res, contact)) return
      if (run.status !== 'active') {
        return res.status(409).json({ error: 'run_not_active', status: run.status, exitReason: run.exitReason })
      }
      const steps = Math.min(Math.max(Number(req.body?.steps ?? 1) || 1, 1), 50)
      const dispatch = req.body?.dispatch !== false
      const ctx = mailer.getRunnerContext()
      const startedAt = new Date()
      const historyBefore = run.history.length
      const actor = actorOf(req)

      for (let i = 0; i < steps; i += 1) {
        const advanced = await advanceOnce(run._id!, ctx, actor, c)
        if (!advanced) break
      }

      const after = await c.flowRuns.findOne({ _id: run._id })
      const newSends = await c.sends.find({ flowRunId: run._id, queuedAt: { $gte: startedAt } }).toArray()
      if (dispatch) {
        for (const s of newSends) {
          if (s.status === 'queued') await dispatchSend(s._id!, ctx)
        }
      }
      const sends = await c.sends.find({ flowRunId: run._id, queuedAt: { $gte: startedAt } }).toArray()
      await mailer.audit({
        actor,
        action: 'agent.run.advance',
        resource: { collection: 'mailer_flow_runs', id: run._id, slug: run.flowSlug },
        diffSummary: `advanced ${steps} step(s) for ${contact.email}; ${sends.length} send(s) created`,
      })
      res.json({
        run: after ? runSummary(after) : null,
        historyAdded: after ? after.history.slice(historyBefore) : [],
        sends: sends.map(sendSummary),
      })
    }),
  )

  router.post(
    '/runs/:id/cancel',
    wrap(async (req, res) => {
      const id = String(req.params.id)
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'bad_id' })
      const run = await c.flowRuns.findOne({ _id: new ObjectId(id) })
      if (!run) return res.status(404).json({ error: 'not_found' })
      if (run.status !== 'active') return res.status(409).json({ error: 'run_not_active', status: run.status })
      const actor = actorOf(req)
      // The `aborted_by_host` prefix is what the dispatcher's aborted-run
      // guard looks for, so a send queued between here and its dispatch is
      // cancelled rather than sent.
      await exitFlowRun(run, `aborted_by_host:${actor}`, mailer.getRunnerContext())
      const cancelled = await c.sends.updateMany(
        { flowRunId: run._id, status: 'queued' },
        { $set: { status: 'cancelled', errorMessage: `cancelled: aborted_by_host:${actor}`, updatedAt: new Date() } },
      )
      await mailer.audit({
        actor,
        action: 'agent.run.cancel',
        resource: { collection: 'mailer_flow_runs', id: run._id, slug: run.flowSlug },
        diffSummary: `cancelled run for ${run.externalId}; ${cancelled.modifiedCount} queued send(s) cancelled`,
      })
      const after = await c.flowRuns.findOne({ _id: run._id })
      res.json({ run: after ? runSummary(after) : null, cancelledSends: cancelled.modifiedCount })
    }),
  )

  // ----- Events ---------------------------------------------------------------------
  router.post(
    '/events',
    wrap(async (req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name : ''
      const externalId = typeof req.body?.externalId === 'string' ? req.body.externalId : ''
      if (!name || !externalId) {
        return res.status(400).json({ error: 'validation_failed', message: 'name and externalId are required' })
      }
      const contact = await loadContact(res, externalId)
      if (!contact) return
      if (!guardTestContact(res, contact)) return
      const dedupeKey = typeof req.body?.dedupeKey === 'string' && req.body.dedupeKey ? req.body.dedupeKey : undefined
      try {
        await mailer.fire(name, externalId, objectOrUndefined(req.body?.properties) ?? {}, dedupeKey)
      } catch (err: any) {
        return res.status(400).json({ error: 'fire_failed', message: String(err?.message ?? err) })
      }
      const latest = await c.events.findOne({ externalId, name }, { sort: { createdAt: -1 } })
      await mailer.audit({
        actor: actorOf(req),
        action: 'agent.event.fire',
        resource: { collection: 'mailer_events', id: latest?._id },
        diffSummary: `${name} for ${contact.email}${dedupeKey ? ` key=${dedupeKey}` : ''}`,
      })
      res.status(201).json({ ok: true, event: latest })
    }),
  )

  // ----- Contacts ------------------------------------------------------------------
  router.get(
    '/contacts/by-email/:email',
    wrap(async (req, res) => {
      const contact = await mailer.adapter.getByEmail(String(req.params.email).toLowerCase())
      if (!contact) return res.status(404).json({ error: 'contact_not_found', email: req.params.email })
      res.json(await contactDetail(contact))
    }),
  )

  router.get(
    '/contacts/:externalId',
    wrap(async (req, res) => {
      const contact = await loadContact(res, String(req.params.externalId))
      if (!contact) return
      res.json(await contactDetail(contact))
    }),
  )

  router.get(
    '/contacts/:externalId/unsubscribe-url',
    wrap(async (req, res) => {
      const contact = await loadContact(res, String(req.params.externalId))
      if (!contact) return
      if (!guardTestContact(res, contact)) return
      res.json({ contact: { externalId: contact.externalId, email: contact.email }, unsubscribeUrl: unsubscribeUrlFor(mailer, contact.email) })
    }),
  )

  router.post(
    '/contacts/:externalId/subscribe',
    wrap(async (req, res) => {
      const contact = await loadContact(res, String(req.params.externalId))
      if (!contact) return
      if (!guardTestContact(res, contact)) return
      // An explicit opt-in: clears the opt-out suppression too, or the
      // contact reads as subscribed while every send comes back suppressed.
      const { removedSuppressions } = await mailer.resubscribe({ externalId: contact.externalId, source: 'agent' })
      const sub = await c.subscriptions.findOne({ externalId: contact.externalId })
      await mailer.audit({
        actor: actorOf(req),
        action: 'agent.contact.subscribe',
        resource: { collection: 'mailer_subscriptions', id: sub?._id },
        diffSummary: `${contact.email} (removed ${removedSuppressions} opt-out suppression${removedSuppressions === 1 ? '' : 's'})`,
      })
      res.json({ subscription: sub, removedSuppressions })
    }),
  )

  router.post(
    '/contacts/:externalId/unsubscribe',
    wrap(async (req, res) => {
      const contact = await loadContact(res, String(req.params.externalId))
      if (!contact) return
      if (!guardTestContact(res, contact)) return
      await mailer.unsubscribe(contact.email, { scope: 'marketing', reason: 'user_request', source: 'agent' })
      const sub = await c.subscriptions.findOne({ externalId: contact.externalId })
      await mailer.audit({
        actor: actorOf(req),
        action: 'agent.contact.unsubscribe',
        resource: { collection: 'mailer_subscriptions', id: sub?._id },
        diffSummary: contact.email,
      })
      res.json({ subscription: sub })
    }),
  )

  /**
   * Tag a test contact, so a gated flow has someone to let through.
   * `POST /flows/:slug/gate` publishes a canary whose first step exits every
   * contact without the tag; the tag itself lives on the host's contact record,
   * which an agent otherwise reaches only through the production database.
   */
  router.post(
    '/contacts/:externalId/tags',
    wrap(async (req, res) => {
      const contact = await loadContact(res, String(req.params.externalId))
      if (!contact) return
      if (!guardTestContact(res, contact)) return
      const parsed = agentTagsInputSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues })
      }
      const { add, remove } = parsed.data
      if (add.length === 0 && remove.length === 0) {
        return res.status(400).json({ error: 'no_tags', message: 'Pass {add: [...]} and/or {remove: [...]}.' })
      }
      const overlap = add.filter((t) => remove.includes(t))
      if (overlap.length > 0) {
        return res.status(400).json({ error: 'tag_conflict', tags: overlap })
      }
      for (const tag of add) await mailer.tag(contact.externalId, tag)
      for (const tag of remove) await mailer.untag(contact.externalId, tag)
      const after = await mailer.adapter.getById(contact.externalId)
      await mailer.audit({
        actor: actorOf(req),
        action: 'agent.contact.tags',
        resource: { collection: 'contacts', id: contact.externalId },
        diffSummary: `${contact.email}: ${add.length ? `+${add.join(', +')}` : ''}${add.length && remove.length ? ' ' : ''}${
          remove.length ? `-${remove.join(', -')}` : ''
        }`,
      })
      res.json({
        contact: { externalId: contact.externalId, email: contact.email },
        added: add,
        removed: remove,
        tags: after?.tags ?? [],
      })
    }),
  )

  /**
   * Put a test contact back to "never seen": runs, sends, events and
   * suppressions gone, subscription restored. This is what makes a
   * `trigger.once` flow re-testable with the same address.
   */
  router.post(
    '/contacts/:externalId/reset',
    wrap(async (req, res) => {
      const contact = await loadContact(res, String(req.params.externalId))
      if (!contact) return
      if (!guardTestContact(res, contact)) return
      const b = req.body ?? {}
      const eventFilter: Record<string, unknown> = { externalId: contact.externalId }
      if (Array.isArray(b.events)) eventFilter.name = { $in: b.events.map(String) }
      const doRuns = b.runs !== false
      const doSends = b.sends !== false
      const doEvents = b.events !== false
      const doSuppressions = b.suppressions !== false
      const doSubscribe = b.subscribe !== false

      const removed = { runs: 0, sends: 0, events: 0, suppressions: 0 }
      if (doRuns) removed.runs = (await c.flowRuns.deleteMany({ externalId: contact.externalId })).deletedCount
      if (doSends) removed.sends = (await c.sends.deleteMany({ externalId: contact.externalId })).deletedCount
      if (doEvents) removed.events = (await c.events.deleteMany(eventFilter as any)).deletedCount
      if (doSuppressions) removed.suppressions = (await c.suppressions.deleteMany({ email: contact.email })).deletedCount
      if (doSubscribe) await mailer.upsertSubscription({ externalId: contact.externalId, source: 'agent-reset' })
      const subscription = await c.subscriptions.findOne({ externalId: contact.externalId })
      await mailer.audit({
        actor: actorOf(req),
        action: 'agent.contact.reset',
        resource: { collection: 'mailer_subscriptions', id: subscription?._id },
        diffSummary: `${contact.email}: removed ${removed.runs} run(s), ${removed.sends} send(s), ${removed.events} event(s), ${removed.suppressions} suppression(s)${doSubscribe ? '; resubscribed' : ''}`,
      })
      res.json({ contact: { externalId: contact.externalId, email: contact.email }, removed, subscription })
    }),
  )

  // ----- Broadcasts -------------------------------------------------------------------
  //
  // The same operations as the admin API's broadcast routes (they share
  // api/broadcast-ops.ts), with structured bodies and the token's actor. What
  // differs from the admin path is what the agent path refuses: see the
  // per-route notes.
  router.get(
    '/broadcasts',
    wrap(async (_req, res) => {
      const docs = await c.broadcasts.find().sort({ createdAt: -1 }).limit(200).toArray()
      const stats = await computeBroadcastStats(mailer)
      res.json(docs.map((b) => ({ ...broadcastSummary(b), stats: stats.get(String(b._id)) ?? emptyBroadcastStats() })))
    }),
  )

  router.get(
    '/broadcasts/:slug',
    wrap(async (req, res) => {
      const b = await loadBroadcast(mailer, String(req.params.slug))
      const [stats, statusBreakdown] = await Promise.all([
        computeBroadcastStats(mailer, b._id),
        broadcastStatusBreakdown(mailer, b._id!),
      ])
      res.json({
        broadcast: broadcastSummary(b),
        stats: stats.get(String(b._id)) ?? emptyBroadcastStats(),
        statusBreakdown,
      })
    }),
  )

  router.post(
    '/broadcasts',
    wrap(async (req, res) => {
      const parsed = agentCreateBroadcastSchema.safeParse(req.body ?? {})
      if (!parsed.success) return res.status(400).json({ error: 'validation_failed', message: zodMessage(parsed.error) })
      const b = await createBroadcast(mailer, parsed.data as any, actorOf(req), { requireSubscribed: true })
      res.status(201).json({ broadcast: broadcastSummary(b) })
    }),
  )

  router.patch(
    '/broadcasts/:slug',
    wrap(async (req, res) => {
      const parsed = agentPatchBroadcastSchema.safeParse(req.body ?? {})
      if (!parsed.success) return res.status(400).json({ error: 'validation_failed', message: zodMessage(parsed.error) })
      const b = await patchBroadcast(mailer, String(req.params.slug), parsed.data as any, actorOf(req), { requireSubscribed: true })
      res.json({ broadcast: broadcastSummary(b) })
    }),
  )

  router.post(
    '/broadcasts/:slug/schedule',
    wrap(async (req, res) => {
      const parsed = agentScheduleBroadcastSchema.safeParse(req.body ?? {})
      if (!parsed.success) return res.status(400).json({ error: 'validation_failed', message: zodMessage(parsed.error) })
      const b = await scheduleBroadcast(mailer, String(req.params.slug), parsed.data, actorOf(req), { requireSubscribed: true })
      res.json({ broadcast: broadcastSummary(b) })
    }),
  )

  router.post(
    '/broadcasts/:slug/cancel',
    wrap(async (req, res) => {
      const out = await cancelBroadcast(mailer, String(req.params.slug), actorOf(req))
      res.json({ broadcast: broadcastSummary(out.broadcast), cancelledSends: out.cancelledSends })
    }),
  )

  // ----- Runner + status ---------------------------------------------------------------
  router.post(
    '/tick',
    wrap(async (_req, res) => {
      const started = Date.now()
      await runTick(mailer.getRunnerContext())
      res.json({ ok: true, ms: Date.now() - started })
    }),
  )

  router.get(
    '/webhooks/status',
    wrap(async (_req, res) => {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const [last, byType24h, total7d, unprocessed] = await Promise.all([
        c.webhookEvents.findOne({}, { sort: { receivedAt: -1 }, projection: { receivedAt: 1, provider: 1, normalizedType: 1 } }),
        c.webhookEvents
          .aggregate<{ _id: string; n: number }>([{ $match: { receivedAt: { $gte: dayAgo } } }, { $group: { _id: '$normalizedType', n: { $sum: 1 } } }])
          .toArray(),
        c.webhookEvents.countDocuments({ receivedAt: { $gte: weekAgo } }),
        c.webhookEvents.countDocuments({ processed: false }),
      ])
      res.json({
        providers: Object.keys(mailer.providers),
        lastReceivedAt: last?.receivedAt ?? null,
        lastProvider: last?.provider ?? null,
        last24h: Object.fromEntries(byType24h.map((r) => [r._id, r.n])),
        last7d: total7d,
        unprocessed,
        ingestPath: `${mailer.config.publicUrl}/m/webhooks/<provider>`,
      })
    }),
  )

  router.get(
    '/status',
    wrap(async (_req, res) => {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const [flows, templates, subscribed, suppressions, activeRuns, sends24h, webhooks24h, lastWebhook, healthDocs, setup] =
        await Promise.all([
          c.flows.find({}, { projection: { slug: 1, enabled: 1, version: 1, lastTriggerScanAt: 1, steps: 1, trigger: 1 } }).sort({ slug: 1 }).toArray(),
          c.templates.find({}, { projection: { slug: 1, kind: 1, publishedAt: 1, 'body.html': 1, fromEmail: 1 } }).sort({ slug: 1 }).toArray(),
          c.subscriptions.countDocuments({ status: 'subscribed' }),
          c.suppressions.estimatedDocumentCount(),
          c.flowRuns.countDocuments({ status: 'active' }),
          c.sends.aggregate<{ _id: string; n: number }>([{ $match: { queuedAt: { $gte: dayAgo } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
          c.webhookEvents.countDocuments({ receivedAt: { $gte: dayAgo } }),
          c.webhookEvents.findOne({}, { sort: { receivedAt: -1 }, projection: { receivedAt: 1 } }),
          c.health.find({}).limit(500).toArray(),
          runSetupChecks(mailer),
        ])
      const activeByFlow = await c.flowRuns
        .aggregate<{ _id: string; n: number }>([{ $match: { status: 'active' } }, { $group: { _id: '$flowSlug', n: { $sum: 1 } } }])
        .toArray()
      const activeMap = new Map(activeByFlow.map((r) => [r._id, r.n]))
      res.json({
        version: VERSION,
        now: new Date(),
        testContactsConfigured: !!isTestContact,
        setup: setup,
        health: { status: healthDocs.length ? effectiveOverallStatus(healthDocs) : null, aggregate: healthDocs.find((d) => d._id === HEALTH_AGG_ID) ?? null },
        flows: flows.map((f) => ({
          slug: f.slug,
          enabled: f.enabled,
          version: f.version,
          lastTriggerScanAt: f.lastTriggerScanAt ?? null,
          trigger: f.trigger,
          liveSteps: Array.isArray(f.steps) ? f.steps.length : 0,
          gated: Array.isArray(f.steps) && isCanaryGate(f.steps[0]) ? (f.steps[0] as any).test.hasTag : null,
          activeRuns: activeMap.get(f.slug) ?? 0,
        })),
        templates: templates.map((t) => ({
          slug: t.slug,
          kind: t.kind,
          fromEmail: t.fromEmail,
          published: !!(t.body && t.body.html),
          publishedAt: t.publishedAt ?? null,
        })),
        counts: {
          subscribed,
          suppressions,
          activeRuns,
          sendsLast24h: Object.fromEntries(sends24h.map((r) => [r._id, r.n])),
          webhookEventsLast24h: webhooks24h,
          lastWebhookAt: lastWebhook?.receivedAt ?? null,
        },
      })
    }),
  )

  // ----- Tail ----------------------------------------------------------------------------
  router.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', message: `no agent route ${req.method} ${req.path}; GET / lists them` })
  })
  router.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof FlowOperationError) {
      return res.status(err.status).json({ error: err.code, message: err.message })
    }
    if (err instanceof BroadcastOperationError) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ?? {}) })
    }
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_failed', issues: err.issues })
    }
    logger.error?.({ err: String(err?.message ?? err), path: req.path, method: req.method }, 'mailery agent: request failed')
    if (res.headersSent) return
    res.status(500).json({ error: 'internal', message: String(err?.message ?? err) })
  })

  return router

  // ----- local helpers that need closure state -------------------------------------------
  async function contactForRender(req: Request, res: Response): Promise<Contact | null> {
    const contactId = typeof req.body?.contactId === 'string' ? req.body.contactId : ''
    if (contactId) return loadContact(res, contactId)
    const sample = req.body?.sampleContact
    if (sample && typeof sample === 'object' && typeof sample.email === 'string') {
      return {
        externalId: String(sample.externalId ?? 'sample-contact'),
        email: sample.email,
        tags: Array.isArray(sample.tags) ? sample.tags.map(String) : [],
        fields: sample.fields && typeof sample.fields === 'object' ? sample.fields : {},
        timezone: typeof sample.timezone === 'string' ? sample.timezone : undefined,
      }
    }
    res.status(400).json({ error: 'validation_failed', message: 'contactId (or a sampleContact with an email) is required' })
    return null
  }

  async function contactDetail(contact: Contact) {
    const [subscription, recentEvents, recentSends, runs, suppressions] = await Promise.all([
      c.subscriptions.findOne({ externalId: contact.externalId }),
      c.events.find({ externalId: contact.externalId }).sort({ occurredAt: -1 }).limit(50).toArray(),
      c.sends.find({ externalId: contact.externalId }).sort({ queuedAt: -1 }).limit(50).toArray(),
      c.flowRuns.find({ externalId: contact.externalId }).sort({ enteredAt: -1 }).limit(50).toArray(),
      c.suppressions.find({ email: contact.email }).toArray(),
    ])
    return {
      contact,
      isTestContact: isTestContact ? isTestContact(contact.email) : null,
      subscription,
      suppressions,
      recentEvents,
      recentSends: recentSends.map(sendSummary),
      runs: runs.map(runSummary),
    }
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  eventProperties?: Record<string, unknown>
  vars?: Record<string, unknown>
  includeRendered?: boolean
  varsSchema?: Record<string, unknown> | null
}

export interface VerifyReport {
  ok: boolean
  template: { slug: string; kind: TemplateDoc['kind']; name: string }
  contact: { externalId: string; email: string }
  checks: Check[]
  links: { total: number; sample: string[] }
  rendered:
    | { subject: string; preheader: string; htmlBytes: number; textLength: number; fromEmail: string }
    | { subject: string; preheader: string; html: string; plainText: string; fromEmail: string; fromName: string; replyTo: string | null }
    | null
}

/** Anything Handlebars left behind: `{{x}}`, `{{#if}}`, `{{{y}}}`. */
const PLACEHOLDER_RE = /\{\{[^{}]*\}\}|\{\{\{[^{}]*\}\}\}/g
const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const GMAIL_CLIP_BYTES = 102 * 1024

export async function verifyTemplate(
  mailer: Mailer,
  tpl: TemplateDoc,
  contact: Contact,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const checks: Check[] = []
  const push = (id: string, status: Check['status'], detail?: unknown) =>
    checks.push(detail === undefined ? { id, status } : { id, status, detail })
  const base = {
    template: { slug: tpl.slug, kind: tpl.kind, name: tpl.name },
    contact: { externalId: contact.externalId, email: contact.email },
  }
  const finish = (rendered: RenderedTemplate | null, links: string[]): VerifyReport => ({
    ok: checks.every((k) => k.status !== 'fail'),
    ...base,
    checks,
    links: { total: links.length, sample: links.slice(0, 50) },
    rendered: rendered
      ? opts.includeRendered
        ? {
            subject: rendered.subject,
            preheader: rendered.preheader,
            html: rendered.html,
            plainText: rendered.plainText,
            fromEmail: rendered.fromEmail,
            fromName: rendered.fromName,
            replyTo: rendered.replyTo,
          }
        : {
            subject: rendered.subject,
            preheader: rendered.preheader,
            htmlBytes: Buffer.byteLength(rendered.html, 'utf8'),
            textLength: rendered.plainText.trim().length,
            fromEmail: rendered.fromEmail,
          }
      : null,
  })

  if (!tpl.body?.html && !tpl.body?.mjml) {
    push('published', 'fail', 'template has no published body (body.html and body.mjml are empty)')
    return finish(null, [])
  }
  push('published', 'pass', { publishedAt: tpl.publishedAt ?? null })

  let out: Awaited<ReturnType<typeof renderForContact>>
  try {
    out = await renderForContact(mailer, tpl, contact, {
      reason: 'test',
      eventProperties: opts.eventProperties,
      vars: opts.vars,
    })
    push('vars_resolved', 'pass', { keys: Object.keys(out.resolved) })
    push('render', 'pass')
  } catch (err: any) {
    const message = String(err?.message ?? err)
    push(message.startsWith('varsAdapter') ? 'vars_resolved' : 'render', 'fail', message)
    return finish(null, [])
  }
  const { rendered, unsubscribeUrl } = out

  const leftovers = new Set<string>()
  for (const part of [rendered.subject, rendered.preheader, rendered.html, rendered.plainText]) {
    for (const m of part.matchAll(PLACEHOLDER_RE)) leftovers.add(m[0])
  }
  push('unresolved_placeholders', leftovers.size ? 'fail' : 'pass', leftovers.size ? { placeholders: [...leftovers] } : undefined)

  // Handlebars renders an unknown path as an EMPTY STRING — no braces are
  // left behind, nothing throws, the recipient just gets a blank where a
  // price or a name should be. So the check that catches this class compares
  // every path the template source references against the object it was
  // actually rendered with.
  const referenced = referencedPaths(
    [tpl.subject, tpl.preheader, tpl.body.html, tpl.body.plainText, tpl.body.mjml ?? ''].join('\n'),
    Object.keys(mailer.config.handlebarsHelpers ?? {}),
  )
  const missing: string[] = []
  const empty: string[] = []
  for (const path of referenced) {
    const value = lookupPath(out.context, path)
    if (value === undefined) {
      // Reserved render-context keys the package declares but does not yet
      // populate (viewInBrowserUrl, preferenceCenterUrl) render blank by
      // design; that is worth a warning, not a failure.
      const root = path.split('.')[0]!
      if ((RESERVED_VAR_KEYS as readonly string[]).includes(root)) empty.push(path)
      else missing.push(path)
    } else if (value === null || value === '') {
      empty.push(path)
    }
  }
  push('unknown_variables', missing.length ? 'fail' : 'pass', { referenced: referenced.length, missing })
  push('empty_variables', empty.length ? 'warn' : 'pass', { empty })

  const links = extractLinks(rendered.html)
  const invalid = links.filter((l) => !/^(https?:\/\/|mailto:|tel:)/i.test(l))
  push('links_absolute', invalid.length ? 'fail' : 'pass', { total: links.length, invalid })

  if (tpl.kind === 'marketing') {
    push('unsubscribe_link', rendered.html.includes(unsubscribeUrl) ? 'pass' : 'fail', {
      hint: 'a marketing template must reference {{unsubscribeUrl}} in its body',
    })
    if (mailer.config.senderAddress) {
      push('sender_address', rendered.html.includes(mailer.config.senderAddress) ? 'pass' : 'fail', {
        hint: 'CAN-SPAM: reference {{senderAddress}} in the footer',
      })
    }
  }

  const text = rendered.plainText.trim()
  push('plain_text', text.length === 0 ? 'fail' : text.length < 40 ? 'warn' : 'pass', { length: text.length })

  const subject = rendered.subject.trim()
  push('subject', subject.length === 0 ? 'fail' : subject.length > 78 ? 'warn' : 'pass', { length: subject.length })

  if (mailer.config.senderDomains && Object.keys(mailer.config.senderDomains).length > 0) {
    const v = validateSenderDomain(rendered.fromEmail, tpl.kind, mailer.config.senderDomains)
    push('from_domain', v.ok ? 'pass' : 'fail', v.ok ? { fromEmail: rendered.fromEmail } : { fromEmail: rendered.fromEmail, code: v.code, reason: v.reason })
  }

  const bytes = Buffer.byteLength(rendered.html, 'utf8')
  push('html_size', bytes > GMAIL_CLIP_BYTES ? 'warn' : 'pass', { bytes, clipAt: GMAIL_CLIP_BYTES })

  const lint = lintTemplate(
    {
      subject: tpl.subject,
      preheader: tpl.preheader,
      mjml: tpl.body.mjml ?? '',
      editorJson: tpl.body.editorJson ?? undefined,
      html: tpl.body.html,
      plainText: tpl.body.plainText,
      kind: tpl.kind,
      fromEmail: tpl.fromEmail,
    },
    {
      senderDomains: mailer.config.senderDomains,
      varsJsonSchema: opts.varsSchema ?? null,
      publicUrl: mailer.config.publicUrl,
      linkDomains: mailer.config.linkDomains,
    },
  )
  push('lint', lint.errors.length ? 'fail' : lint.warnings.length ? 'warn' : 'pass', {
    errors: lint.errors.map((i) => ({ rule: i.rule, message: i.message })),
    warnings: lint.warnings.map((i) => i.rule),
  })

  return finish(rendered, links)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RenderForContactOptions {
  reason: 'preview' | 'test'
  eventProperties?: Record<string, unknown>
  vars?: Record<string, unknown>
}

/**
 * Render a published template for one real contact the way a send would:
 * host vars resolved through the varsAdapter, the contact at the root, a
 * genuinely signed unsubscribe URL. The one difference from a send is that
 * no tracking is applied — nothing here is queued.
 */
export async function renderForContact(
  mailer: Mailer,
  tpl: TemplateDoc,
  contact: Contact,
  opts: RenderForContactOptions,
): Promise<{
  rendered: RenderedTemplate
  resolved: Record<string, unknown>
  unsubscribeUrl: string
  /** The exact object the template was rendered against. */
  context: Record<string, unknown>
}> {
  let resolved: Record<string, unknown>
  try {
    resolved = await resolveVars(mailer.config.varsAdapter, contact, {
      reason: opts.reason,
      templateSlug: tpl.slug,
      eventProperties: opts.eventProperties,
    })
  } catch (err: any) {
    throw new Error(`varsAdapter.resolve threw: ${String(err?.message ?? err)}`)
  }
  const unsubscribeUrl = unsubscribeUrlFor(mailer, contact.email)
  const context = {
    ...resolved,
    contact,
    vars: opts.vars ?? {},
    event: opts.eventProperties ?? {},
    unsubscribeUrl,
    senderAddress: mailer.config.senderAddress,
  }
  const rendered = await renderTemplate(tpl, context, { helpers: mailer.config.handlebarsHelpers })
  return { rendered, resolved, unsubscribeUrl, context }
}

export function unsubscribeUrlFor(mailer: Mailer, email: string): string {
  const expiresAt = new Date(Date.now() + mailer.config.unsubscribeTokenLifetimeDays * 24 * 60 * 60 * 1000)
  const token = signUnsubscribeToken({ email, scope: 'marketing', expiresAt }, mailer.config.unsubscribeSecret)
  return `${mailer.config.publicUrl}/m/unsub/${token}`
}

export function extractLinks(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(HREF_RE)) {
    const href = (m[1] ?? m[2] ?? '').trim()
    if (!href || href.startsWith('#')) continue
    out.push(href)
  }
  return out
}

const BUILTIN_HELPERS = new Set([
  'eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'and', 'or', 'not',
  'formatDate', 'formatNumber', 'formatCurrency', 'pluralize',
  'if', 'unless', 'each', 'with', 'else', 'lookup', 'log', 'this',
  'true', 'false', 'null', 'undefined',
])
const MUSTACHE_RE = /\{\{\{?([^{}]*)\}\}\}?/g
const BLOCK_SCOPE_RE = /\{\{#(each|with)\b[\s\S]*?\{\{\/\1\}\}/g
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

/**
 * Every dotted path a Handlebars source references outside `#each`/`#with`
 * blocks (whose paths are relative to the iterated item and cannot be
 * resolved against the root context) and outside HTML comments. Helper
 * names, literals, hash keys, `@data` variables and Handlebars comments are
 * skipped.
 */
export function referencedPaths(source: string, helperNames: Iterable<string> = []): string[] {
  const helpers = new Set([...BUILTIN_HELPERS, ...helperNames])
  const out = new Set<string>()
  // An HTML comment is rendered too, but nothing in it reaches a reader, so
  // a placeholder mentioned there is documentation, not a reference.
  const scanned = source.replace(HTML_COMMENT_RE, '').replace(BLOCK_SCOPE_RE, '')
  for (const m of scanned.matchAll(MUSTACHE_RE)) {
    let expr = (m[1] ?? '').trim()
    if (!expr || expr.startsWith('!')) continue
    expr = expr.replace(/^[#/^]\s*/, '').replace(/^else\b\s*/, '')
    for (let tok of expr.split(/[\s()]+/)) {
      if (!tok) continue
      const eq = tok.indexOf('=')
      if (eq > 0) tok = tok.slice(eq + 1)
      if (/^['"]/.test(tok) || /^-?\d/.test(tok)) continue
      if (tok.startsWith('@') || tok.startsWith('../') || tok.startsWith('this.')) continue
      if (helpers.has(tok) || !PATH_RE.test(tok)) continue
      out.add(tok)
    }
  }
  return [...out]
}

export function lookupPath(ctx: Record<string, unknown>, path: string): unknown {
  let cur: unknown = ctx
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function testContactMatcher(spec: AgentRouterOptions['testContacts']): ((email: string) => boolean) | null {
  if (!spec) return null
  if (spec instanceof RegExp) return (email) => spec.test(email)
  if (typeof spec === 'function') return (email) => !!spec(email)
  return null
}

function bearerAuth(tokens: AgentToken[]) {
  const hashed = tokens.map((t) => ({ hash: crypto.createHash('sha256').update(t.token).digest(), actor: t.actor }))
  return (req: Request, res: Response, next: NextFunction) => {
    const header = String(req.headers.authorization ?? '')
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header)
    if (!m) {
      return res.status(401).json({ error: 'unauthorized', message: 'send Authorization: Bearer <token>' })
    }
    const presented = crypto.createHash('sha256').update(m[1] ?? '').digest()
    const match = hashed.find((h) => crypto.timingSafeEqual(h.hash, presented))
    if (!match) return res.status(401).json({ error: 'unauthorized', message: 'unknown token' })
    ;(req as any).actor = match.actor
    next()
  }
}

/**
 * One actionable transition for a run: complete the wait in front of it, if
 * any, then process the step. Returns false once the run is no longer active.
 */
async function advanceOnce(
  runId: ObjectId,
  ctx: ReturnType<Mailer['getRunnerContext']>,
  actor: string,
  c: Mailer['collections'],
): Promise<boolean> {
  for (let hop = 0; hop < 10; hop += 1) {
    const run = await c.flowRuns.findOne({ _id: runId })
    if (!run || run.status !== 'active') return false
    if (run.nextActionAt && run.nextActionAt.getTime() > Date.now()) {
      await c.flowRuns.updateOne(
        { _id: runId, status: 'active' },
        {
          $set: { nextActionAt: new Date(), updatedAt: new Date() },
          $push: {
            history: {
              stepIndex: Math.max(0, run.currentStepIndex - 1),
              action: 'wait_completed',
              at: new Date(),
              details: { forcedBy: actor, scheduledFor: run.nextActionAt },
            },
          },
        },
      )
    }
    const before = (await c.flowRuns.findOne({ _id: runId }))?.history.length ?? 0
    await processOneRunStep(runId, ctx)
    const after = await c.flowRuns.findOne({ _id: runId })
    if (!after) return false
    const last = after.history[after.history.length - 1]
    const progressed = after.history.length > before
    // A wait that just started is not the transition the caller asked for;
    // loop once more to complete it and process what follows.
    if (progressed && last?.action === 'wait_started' && after.status === 'active') continue
    return after.status === 'active' && progressed
  }
  return false
}

const WAIT_TARGETS = new Set(['sent', 'delivered', 'opened', 'clicked', 'terminal'])

function waitTargetReached(send: SendDoc, target: string): boolean {
  switch (target) {
    case 'sent':
      return send.status === 'sent' || send.status === 'delivered' || !!send.sentAt
    case 'delivered':
      return send.status === 'delivered' || !!send.deliveredAt
    case 'opened':
      return !!send.openedAt
    case 'clicked':
      return !!send.firstClickAt
    case 'terminal':
      return ['delivered', 'bounced', 'failed', 'suppressed', 'cancelled', 'complained'].includes(send.status)
    default:
      return false
  }
}

function sendSummary(s: SendDoc) {
  return {
    id: String(s._id),
    templateSlug: s.templateSlug,
    externalId: s.externalId,
    email: s.emailAtSend,
    kind: s.kind,
    status: s.status,
    provider: s.provider,
    providerMessageId: s.providerMessageId,
    subject: s.subject,
    errorMessage: s.errorMessage,
    flowRunId: s.flowRunId ? String(s.flowRunId) : null,
    queuedAt: s.queuedAt,
    sentAt: s.sentAt,
    deliveredAt: s.deliveredAt,
    openedAt: s.openedAt,
    firstClickAt: s.firstClickAt,
    bounceType: s.bounceType,
  }
}

function runSummary(r: FlowRunDoc) {
  return {
    id: String(r._id),
    flowSlug: r.flowSlug,
    flowVersion: r.flowVersion,
    externalId: r.externalId,
    email: r.emailAtEntry,
    status: r.status,
    currentStepIndex: r.currentStepIndex,
    currentBranchPath: r.currentBranchPath,
    nextActionAt: r.nextActionAt,
    enteredAt: r.enteredAt,
    exitedAt: r.exitedAt,
    exitReason: r.exitReason,
    triggerEvent: r.triggerEvent ?? null,
    history: r.history,
  }
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
}

function objectOrUndefined(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown
function wrap(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next)
  }
}

const ENDPOINTS: Array<{ method: string; path: string; summary: string; testContactsOnly?: boolean }> = [
  { method: 'GET', path: '/', summary: 'This listing, the package version and the actor behind the token.' },
  { method: '*', path: '/api/*', summary: 'The full admin JSON API (flows, templates, contacts, sends, health, setup-status, …) with this token as the actor.' },
  { method: 'POST', path: '/templates/:slug/verify', summary: 'Render the published template as a contact ({contactId} or {sampleContact}) and run named checks: placeholders, links, unsubscribe, sender address, plain text, subject, from domain, size, lint. {includeRendered: true} returns the HTML.' },
  { method: 'POST', path: '/templates/verify-all', summary: 'Verify every template (or {slugs}) for each of {contactIds}; a matrix of pass/fail.' },
  { method: 'POST', path: '/templates/:slug/render', summary: 'Render for a contact and return subject, preheader, HTML, plain text, resolved vars and the signed unsubscribe URL.' },
  { method: 'POST', path: '/templates/:slug/send', summary: 'A real send through the pipeline to a test contact ({contactId}); dispatched inline unless {dispatch: "queue"}. Returns the sendId.', testContactsOnly: true },
  { method: 'PUT', path: '/templates/:slug', summary: 'Publish a compiled template document (html, plain text, kind, sender, subject, tracking flags) with the sender-domain and lint gates; upserts on slug, keeping createdAt and stats. The deploy-script path over HTTP.' },
  { method: 'GET', path: '/sends/:id/wait?status=delivered&timeoutMs=30000', summary: 'Long-poll a send until it reaches sent | delivered | opened | clicked | terminal, with its webhook events.' },
  { method: 'POST', path: '/sends/:id/dispatch', summary: 'Dispatch a queued send now (test contacts only).', testContactsOnly: true },
  { method: 'POST', path: '/flows/:slug/simulate', summary: 'Dry-run the flow for {contactId} from {at} with {eventProperties}: the path taken, every gate verdict, projected send times, where it ends. Writes nothing.' },
  { method: 'POST', path: '/flows/:slug/arm', summary: 'Enable the flow for FUTURE events: stamps the trigger watermark ({since} or now) in the same write. Requires {confirm: true}.' },
  { method: 'POST', path: '/flows/:slug/disarm', summary: 'Disable the flow (pause). In-flight runs continue.' },
  { method: 'POST', path: '/flows/:slug/gate', summary: 'Publish a canary version whose first step exits anyone without {tag}.' },
  { method: 'POST', path: '/flows/:slug/ungate', summary: 'Restore the newest ungated version.' },
  { method: 'GET', path: '/runs?externalId=&flowSlug=&status=&limit=', summary: 'List flow runs.' },
  { method: 'GET', path: '/runs/:id', summary: 'One run with its history and sends.' },
  { method: 'POST', path: '/runs/:id/advance', summary: 'Walk a test contact\'s run forward now, skipping the wait in front of each of {steps} transitions; sends are dispatched inline.', testContactsOnly: true },
  { method: 'POST', path: '/runs/:id/cancel', summary: 'Exit an active run and cancel its queued sends.' },
  { method: 'POST', path: '/events', summary: 'Fire {name} for a test contact {externalId} with {properties} and optional {dedupeKey}.', testContactsOnly: true },
  { method: 'GET', path: '/contacts/:externalId', summary: 'Contact with subscription, suppressions, recent events, sends and runs.' },
  { method: 'GET', path: '/contacts/by-email/:email', summary: 'Same, looked up by email.' },
  { method: 'GET', path: '/contacts/:externalId/unsubscribe-url', summary: 'A signed one-click unsubscribe URL for a test contact, to exercise POST /m/unsub/:token.', testContactsOnly: true },
  { method: 'POST', path: '/contacts/:externalId/subscribe', summary: 'Subscribe a test contact, clearing any opt-out suppression it has (never bounce/complaint rows).', testContactsOnly: true },
  { method: 'POST', path: '/contacts/:externalId/unsubscribe', summary: 'Unsubscribe a test contact (marketing scope).', testContactsOnly: true },
  { method: 'POST', path: '/contacts/:externalId/tags', summary: 'Add or remove tags on a test contact ({add: [...], remove: [...]}), so a gated flow lets it through.', testContactsOnly: true },
  { method: 'POST', path: '/contacts/:externalId/reset', summary: 'Delete a test contact\'s runs, sends, events ({events: [names]} to narrow) and suppressions, then resubscribe. Each part can be turned off with false.', testContactsOnly: true },
  { method: 'GET', path: '/broadcasts', summary: 'Every broadcast (newest first, up to 200) with its stats.' },
  { method: 'GET', path: '/broadcasts/:slug', summary: 'One broadcast with stats and a per-status count of its send rows.' },
  { method: 'POST', path: '/broadcasts', summary: 'Create a draft broadcast: {slug, name, templateSlug, segmentDefinition?, respectRecipientTimezone?}.' },
  { method: 'PATCH', path: '/broadcasts/:slug', summary: 'Edit a draft broadcast (name, templateSlug, segmentDefinition, respectRecipientTimezone). 409 once it has left draft.' },
  { method: 'POST', path: '/broadcasts/:slug/schedule', summary: 'Schedule a draft: {scheduledAt, confirmedCount, respectRecipientTimezone?}.' },
  { method: 'POST', path: '/broadcasts/:slug/cancel', summary: 'Cancel a broadcast.' },
  { method: 'POST', path: '/tick', summary: 'Run the runner tick now (trigger scan, sweeps, outbox, webhook backlog).' },
  { method: 'GET', path: '/webhooks/status', summary: 'Provider webhook ingest: last event received, counts by type (24h), unprocessed backlog.' },
  { method: 'GET', path: '/status', summary: 'One document with setup checks, health, every flow (enabled, version, watermark, gate, active runs), every template, and 24h counts.' },
]
