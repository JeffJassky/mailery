/**
 * Mailer — public facade. Hosts call `Mailer.init(config)` and get an object
 * exposing the public API (fire, upsertSubscription, unsubscribe, ...) plus
 * mountable Express routers.
 *
 * See plans/10-public-api.md for the surface.
 */

import type { Db, ClientSession, ObjectId } from 'mongodb'
import { ObjectId as ObjectIdCtor } from 'mongodb'

import type {
  ContactAdapter,
  MailProvider,
} from '../shared/types.js'
import {
  abortAllFlowsInputSchema,
  abortFlowInputSchema,
  fireInputSchema,
  registerEventSchema,
  sendOneOffInputSchema,
  suppressInputSchema,
  tagInputSchema,
  unsubscribeInputSchema,
  upsertSubscriptionSchema,
  type FireInput,
  type RegisterEventInput,
  type SendOneOffInput,
  type SuppressInput,
  type TagInput,
  type UnsubscribeInput,
  type UpsertSubscriptionInput,
} from '../shared/schemas.js'
import { resolveConfig, type MailerConfig, type ResolvedConfig } from './config.js'
import {
  ensureIndexes,
  getCollections,
} from './models/index.js'
import type { Collections } from './models/index.js'
import { EventRegistry } from './events.js'
import { sha256Hex, signDoiToken } from './tokens.js'
import {
  createQueueDriver,
  type QueueDriver,
  type Queues,
} from './queues/index.js'
import {
  dispatchSend,
  exitFlowRun,
  processOneRunStep,
  runTick,
  type RunnerContext,
} from './runner/index.js'
import { applyWebhookEvent } from './runner/webhook.js'

export class Mailer {
  readonly db: Db
  readonly collections: Collections
  readonly adapter: ContactAdapter
  readonly providers: Record<string, MailProvider>
  readonly queues: Queues
  readonly config: ResolvedConfig
  readonly events: EventRegistry

  private queueDriver: QueueDriver
  private workersStarted = false
  private runnerContext: RunnerContext

  private constructor(args: {
    config: ResolvedConfig
    db: Db
    collections: Collections
    adapter: ContactAdapter
    providers: Record<string, MailProvider>
    queueDriver: QueueDriver
    events: EventRegistry
  }) {
    this.config = args.config
    this.db = args.db
    this.collections = args.collections
    this.adapter = args.adapter
    this.providers = args.providers
    this.queueDriver = args.queueDriver
    this.queues = args.queueDriver.queues
    this.events = args.events

    this.runnerContext = {
      db: this.db,
      collections: this.collections,
      adapter: this.adapter,
      varsAdapter: this.config.varsAdapter,
      providers: this.providers,
      queues: this.queues,
      config: this.config,
      handlebarsHelpers: this.config.handlebarsHelpers,
      audit: (entry) => this.audit(entry),
    }
  }

  /**
   * Construct a Mailer from environment variables. Reads:
   *
   *   MAILER_MONGODB_URI                — Mongo connection string (required)
   *   MAILER_MONGODB_DB                 — database name (optional; defaults to the URI default)
   *   MAILER_REDIS_URL                  — Redis connection URL (required)
   *   MAILER_PUBLIC_URL                 — base for tracking/unsub URLs (required)
   *   MAILER_UNSUBSCRIBE_SECRET         — HMAC key (required)
   *   MAILER_SENDER_ADDRESS             — postal address for CAN-SPAM (optional)
   *   MAILER_FROM_NAME / MAILER_FROM_EMAIL
   *   MAILER_DEFAULT_PROVIDER           — defaults to 'sendgrid' if SENDGRID_API_KEY is set
   *   MAILER_SENDGRID_API_KEY / MAILER_SENDGRID_WEBHOOK_KEY
   *   MAILER_HOST_USERS_COLLECTION (default 'users')
   *   MAILER_HOST_USERS_EMAIL_FIELD (default 'email')
   *   MAILER_HOST_USERS_ID_FIELD (default '_id')
   *   MAILER_HOST_USERS_TAGS_FIELD
   *   MAILER_HOST_USERS_TAGS_WRITABLE — '1' or 'true' to enable
   *
   * For anything beyond this (custom toContact, custom providers, hooks),
   * use the programmatic init.
   */
  static async fromEnv(): Promise<Mailer> {
    const env = process.env
    const required = (k: string) => {
      const v = env[k]
      if (!v) throw new Error(`Mailer.fromEnv: missing env var ${k}`)
      return v
    }

    const { MongoClient } = await import('mongodb')
    const mongoClient = await MongoClient.connect(required('MAILER_MONGODB_URI'))
    const db = env.MAILER_MONGODB_DB ? mongoClient.db(env.MAILER_MONGODB_DB) : mongoClient.db()

    const { MongoContactAdapter } = await import('./adapters/mongo.js')
    const adapter = new MongoContactAdapter({
      db,
      collection: env.MAILER_HOST_USERS_COLLECTION ?? 'users',
      emailField: env.MAILER_HOST_USERS_EMAIL_FIELD ?? 'email',
      idField: env.MAILER_HOST_USERS_ID_FIELD ?? '_id',
      tagsField: env.MAILER_HOST_USERS_TAGS_FIELD,
      tagsWritable:
        env.MAILER_HOST_USERS_TAGS_WRITABLE === '1' || env.MAILER_HOST_USERS_TAGS_WRITABLE === 'true',
    })

    const providers: Record<string, MailProvider> = {}
    if (env.MAILER_SENDGRID_API_KEY) {
      const { SendGridProvider } = await import('./providers/sendgrid.js')
      providers.sendgrid = new SendGridProvider({
        apiKey: env.MAILER_SENDGRID_API_KEY,
        webhookVerificationKey: env.MAILER_SENDGRID_WEBHOOK_KEY,
        sandbox: env.NODE_ENV !== 'production',
      })
    }
    if (Object.keys(providers).length === 0) {
      throw new Error('Mailer.fromEnv: no provider configured (set MAILER_SENDGRID_API_KEY, ...)')
    }

    const defaultProvider = env.MAILER_DEFAULT_PROVIDER ?? Object.keys(providers)[0]!

    const driverEnv = env.MAILER_QUEUE_DRIVER ?? 'bull'
    const queue =
      driverEnv === 'agenda'
        ? ({ driver: 'agenda' as const })
        : driverEnv === 'noop'
        ? ({ driver: 'noop' as const })
        : ({ driver: 'bull' as const, redis: { url: required('MAILER_REDIS_URL') } })

    return Mailer.init({
      db,
      adapter,
      queue,
      providers,
      defaultProvider,
      publicUrl: required('MAILER_PUBLIC_URL'),
      unsubscribeSecret: required('MAILER_UNSUBSCRIBE_SECRET'),
      senderAddress: env.MAILER_SENDER_ADDRESS,
      fromDefaults:
        env.MAILER_FROM_NAME && env.MAILER_FROM_EMAIL
          ? { name: env.MAILER_FROM_NAME, email: env.MAILER_FROM_EMAIL }
          : undefined,
    })
  }

  static async init(input: MailerConfig): Promise<Mailer> {
    const config = resolveConfig(input)
    if (!config.providers[config.defaultProvider]) {
      throw new Error(`defaultProvider "${config.defaultProvider}" not in providers map`)
    }
    if (config.varsAdapter) {
      const { assertNoReservedVarKeys } = await import('./adapters/vars.js')
      assertNoReservedVarKeys(config.varsAdapter)
    }

    const collections = getCollections(config.db, config.collectionPrefix)
    await ensureIndexes(config.db, config.collectionPrefix)

    const queueDriver = await createQueueDriver(config.queue, config.db)
    if (!config.workerless && config.queue.driver !== 'noop') {
      await queueDriver.scheduleRepeatingTick(config.tickIntervalSeconds)
    }

    return new Mailer({
      config,
      db: config.db,
      collections,
      adapter: config.adapter,
      providers: config.providers,
      queueDriver,
      events: new EventRegistry(),
    })
  }

  // -------------------------------------------------------------------------
  // Event registration + firing
  // -------------------------------------------------------------------------

  registerEvent(reg: RegisterEventInput): void {
    const parsed = registerEventSchema.parse(reg)
    this.events.register(parsed)
  }

  async fire(
    eventName: string,
    externalId: string,
    properties: Record<string, unknown> = {},
    dedupeKey?: string,
  ): Promise<void> {
    const input = fireInputSchema.parse({ eventName, externalId, properties, dedupeKey })
    const key = this.events.deriveKey(input.eventName, input.externalId, input.dedupeKey, new Date())
    if (!key) {
      throw new Error(
        `fire("${input.eventName}") missing dedupeKey and no policy registered. ` +
          `Call mailer.registerEvent("${input.eventName}", { dedupePolicy }) or pass a key explicitly.`,
      )
    }
    try {
      await this.collections.events.insertOne({
        externalId: input.externalId,
        name: input.eventName,
        properties: input.properties ?? {},
        dedupeKey: key,
        occurredAt: new Date(),
        createdAt: new Date(),
      })
    } catch (err: any) {
      if (err?.code !== 11000) throw err
      // Duplicate dedupeKey — no-op by design.
    }
  }

  async fireFromSession(
    session: ClientSession,
    eventName: string,
    externalId: string,
    properties: Record<string, unknown> = {},
    dedupeKey?: string,
  ): Promise<void> {
    const input = fireInputSchema.parse({ eventName, externalId, properties, dedupeKey })
    const key = this.events.deriveKey(input.eventName, input.externalId, input.dedupeKey, new Date())
    if (!key) {
      throw new Error(`fireFromSession("${input.eventName}") missing dedupeKey and no policy registered.`)
    }
    try {
      await this.collections.outbox.insertOne(
        {
          payload: {
            type: 'event',
            data: {
              externalId: input.externalId,
              name: input.eventName,
              properties: input.properties ?? {},
              occurredAt: new Date(),
            },
            dedupeKey: key,
          },
          status: 'pending',
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
          enqueuedAt: new Date(),
          processedAt: null,
        },
        { session },
      )
    } catch (err: any) {
      if (err?.code !== 11000) throw err
    }
  }

  // -------------------------------------------------------------------------
  // Subscription / unsubscribe / tags / suppression
  // -------------------------------------------------------------------------

  async upsertSubscription(input: UpsertSubscriptionInput): Promise<void> {
    const parsed = upsertSubscriptionSchema.parse(input)
    const contact = await this.adapter.getById(parsed.externalId)
    if (!contact) throw new Error(`adapter has no contact for externalId ${parsed.externalId}`)

    const status = this.config.requireDoubleOptIn ? 'pending_doi' : 'subscribed'
    const now = new Date()

    // Generate a DOI token up front when DOI is required. We store its hash
    // (not the raw token) on the subscription doc for audit.
    let doiToken: string | null = null
    let doiTokenHash: string | null = null
    if (status === 'pending_doi') {
      const expiresAt = new Date(now.getTime() + this.config.doiTokenLifetimeDays * 86_400_000)
      doiToken = signDoiToken({ externalId: parsed.externalId, expiresAt }, this.config.unsubscribeSecret)
      doiTokenHash = sha256Hex(doiToken)
    }

    await this.collections.subscriptions.updateOne(
      { externalId: parsed.externalId },
      {
        $set: {
          status,
          source: parsed.source,
          emailAtSubscribe: contact.email,
          subscribedAt: status === 'subscribed' ? (parsed.consentTimestamp ?? now) : null,
          updatedAt: now,
          ...(doiTokenHash ? { doiTokenHash, doiRequestedAt: now } : {}),
        },
        $setOnInsert: {
          externalId: parsed.externalId,
          createdAt: now,
          unsubscribedAt: null,
          unsubscribeReason: null,
          doiTokenHash: null,
          doiRequestedAt: null,
          doiConfirmedAt: null,
          doiIp: parsed.consentIp ?? null,
          doiUserAgent: parsed.consentUserAgent ?? null,
        },
      },
      { upsert: true },
    )

    // Send the DOI confirmation email (best-effort — failures here don't
    // unwind the subscription; the host can poll pending DOI rows + re-fire).
    if (status === 'pending_doi' && doiToken) {
      const tpl = await this.collections.templates.findOne({ slug: this.config.doiTemplateSlug })
      if (!tpl) {
        console.warn(`mailery: DOI required but template "${this.config.doiTemplateSlug}" not found — skipping confirmation email`)
        return
      }
      const dedupeKey = `doi:${parsed.externalId}:${now.toISOString().slice(0, 10)}`
      try {
        await this.sendOneOff({
          templateSlug: tpl.slug,
          externalId: parsed.externalId,
          vars: { confirmDoiUrl: `${this.config.publicUrl}/m/confirm-doi/${doiToken}` },
          dedupeKey,
        })
      } catch (err) {
        console.error('mailery: DOI confirmation send failed', err)
      }
    }
  }

  async unsubscribe(email: string, opts: Omit<UnsubscribeInput, 'email'>): Promise<void> {
    const parsed = unsubscribeInputSchema.parse({ email, ...opts })
    const normalized = parsed.email
    const now = new Date()

    await this.collections.suppressions.updateOne(
      { email: normalized, scope: parsed.scope },
      {
        $setOnInsert: {
          email: normalized,
          emailHash: sha256Hex(normalized),
          scope: parsed.scope,
          // mailer_suppressions canonical reason — see plans/02-data-model.md.
          reason: 'unsubscribed' as const,
          source: parsed.source,
          notes: parsed.notes ?? null,
          addedAt: now,
          expiresAt: null,
        },
      },
      { upsert: true },
    )

    await this.collections.subscriptions.updateOne(
      { emailAtSubscribe: normalized },
      {
        $set: {
          status: 'unsubscribed' as const,
          unsubscribedAt: now,
          unsubscribeReason: parsed.reason,
          updatedAt: now,
        },
      },
    )
  }

  async suppress(email: string, opts: Omit<SuppressInput, 'email'>): Promise<void> {
    const parsed = suppressInputSchema.parse({ email, ...opts })
    await this.collections.suppressions.updateOne(
      { email: parsed.email, scope: parsed.scope },
      {
        $setOnInsert: {
          email: parsed.email,
          emailHash: sha256Hex(parsed.email),
          scope: parsed.scope,
          reason: parsed.reason,
          source: parsed.source,
          notes: parsed.notes ?? null,
          addedAt: new Date(),
          expiresAt: parsed.expiresAt ?? null,
        },
      },
      { upsert: true },
    )
  }

  async tag(externalId: string, tag: string): Promise<void> {
    const parsed = tagInputSchema.parse({ externalId, tag })
    if (this.adapter.addTags) {
      await this.adapter.addTags(parsed.externalId, [parsed.tag])
    } else {
      await this.collections.contactTags.updateOne(
        { externalId: parsed.externalId, tag: parsed.tag },
        {
          $setOnInsert: {
            externalId: parsed.externalId,
            tag: parsed.tag,
            appliedBy: 'admin',
            appliedAt: new Date(),
          },
        },
        { upsert: true },
      )
    }
  }

  async untag(externalId: string, tag: string): Promise<void> {
    const parsed = tagInputSchema.parse({ externalId, tag })
    if (this.adapter.removeTags) {
      await this.adapter.removeTags(parsed.externalId, [parsed.tag])
    } else {
      await this.collections.contactTags.deleteOne({ externalId: parsed.externalId, tag: parsed.tag })
    }
  }

  // -------------------------------------------------------------------------
  // Flow abort
  // -------------------------------------------------------------------------

  /**
   * Abort every active run of one flow for a contact, immediately. Runs parked
   * in a `wait` exit too — their delayed wake-up jobs find the run exited and
   * no-op. Also cancels any of the flow's emails still sitting in the send
   * queue for this contact (queued or awaiting retry), so an abort means no
   * further mail, not just no further steps.
   *
   * No-op (returns zero counts) when nothing is active. Safe to call from the
   * same handler that processes the business event ("user upgraded").
   */
  async abortFlow(
    flowSlug: string,
    externalId: string,
    opts: { reason?: string } = {},
  ): Promise<{ abortedRuns: number; cancelledSends: number }> {
    const parsed = abortFlowInputSchema.parse({ flowSlug, externalId, reason: opts.reason })
    const flow = await this.collections.flows.findOne(
      { slug: parsed.flowSlug },
      { projection: { _id: 1 } },
    )
    if (!flow) throw new Error(`abortFlow: unknown flow slug "${parsed.flowSlug}"`)

    const result = await this.abortActiveRuns(
      { externalId: parsed.externalId, flowId: flow._id! },
      parsed.reason ? `aborted_by_host:${parsed.reason}` : 'aborted_by_host',
    )
    if (result.abortedRuns > 0 || result.cancelledSends > 0) {
      await this.audit({
        actor: 'host',
        action: 'flow.abort',
        resource: { collection: 'mailer_flow_runs', slug: parsed.flowSlug },
        diffSummary: `abortFlow slug=${parsed.flowSlug} externalId=${parsed.externalId} runs=${result.abortedRuns} sends=${result.cancelledSends}${parsed.reason ? ` reason=${parsed.reason}` : ''}`,
      })
    }
    return result
  }

  /**
   * Abort every active flow run for a contact across all flows. Same semantics
   * as `abortFlow` — for "stop everything" events (account deleted, churned).
   */
  async abortAllFlows(
    externalId: string,
    opts: { reason?: string } = {},
  ): Promise<{ abortedRuns: number; cancelledSends: number }> {
    const parsed = abortAllFlowsInputSchema.parse({ externalId, reason: opts.reason })

    const result = await this.abortActiveRuns(
      { externalId: parsed.externalId },
      parsed.reason ? `aborted_by_host:${parsed.reason}` : 'aborted_by_host',
    )
    if (result.abortedRuns > 0 || result.cancelledSends > 0) {
      await this.audit({
        actor: 'host',
        action: 'flow.abort_all',
        resource: { collection: 'mailer_flow_runs' },
        diffSummary: `abortAllFlows externalId=${parsed.externalId} runs=${result.abortedRuns} sends=${result.cancelledSends}${parsed.reason ? ` reason=${parsed.reason}` : ''}`,
      })
    }
    return result
  }

  private async abortActiveRuns(
    filter: { externalId: string; flowId?: ObjectId },
    exitReason: string,
  ): Promise<{ abortedRuns: number; cancelledSends: number }> {
    const runs = await this.collections.flowRuns
      .find({ ...filter, status: 'active' })
      .toArray()
    if (runs.length === 0) return { abortedRuns: 0, cancelledSends: 0 }

    for (const run of runs) {
      await exitFlowRun(run, exitReason, this.runnerContext)
    }

    // Exiting the runs stops future steps; this stops mail already produced by
    // past send steps but not yet dispatched (provider retry backoff, tripped
    // circuit breaker, stranded-send sweep). 'failed' is included because the
    // send queue re-dispatches failed sends on retry.
    const cancelled = await this.collections.sends.updateMany(
      { flowRunId: { $in: runs.map((r) => r._id!) }, status: { $in: ['queued', 'failed'] } },
      { $set: { status: 'cancelled', errorMessage: `cancelled: ${exitReason}`, updatedAt: new Date() } },
    )

    return { abortedRuns: runs.length, cancelledSends: cancelled.modifiedCount }
  }

  /**
   * GDPR right-to-erasure. Hard-deletes the contact's PII and leaves a hashed
   * suppression row to block re-import. INVARIANT 9.
   */
  async forget(externalId: string): Promise<void> {
    const sub = await this.collections.subscriptions.findOne({ externalId })
    const email = sub?.emailAtSubscribe?.toLowerCase()

    const collected = await Promise.all([
      this.collections.sends.find({ externalId }).map((s) => s.emailAtSend).toArray(),
    ])
    const emails = new Set<string>()
    if (email) emails.add(email)
    for (const e of collected[0]) if (e) emails.add(e.toLowerCase())

    await Promise.all([
      this.collections.events.deleteMany({ externalId }),
      this.collections.flowRuns.deleteMany({ externalId }),
      this.collections.sends.deleteMany({ externalId }),
      this.collections.subscriptions.deleteMany({ externalId }),
      this.collections.contactTags.deleteMany({ externalId }),
    ])
    if (email) {
      await this.collections.leads.deleteMany({ email })
    }

    for (const e of emails) {
      await this.collections.suppressions.updateOne(
        { emailHash: sha256Hex(e), scope: 'all' },
        {
          $setOnInsert: {
            email: null,
            emailHash: sha256Hex(e),
            scope: 'all',
            reason: 'gdpr_forget',
            source: 'gdpr_request',
            notes: null,
            addedAt: new Date(),
            expiresAt: null,
          },
        },
        { upsert: true },
      )
    }

    await this.audit({
      actor: 'system:gdpr',
      action: 'gdpr.forget',
      resource: { collection: 'mailer_subscriptions', id: sub?._id },
      diffSummary: `forget externalId=${externalId}`,
    })
  }

  /** GDPR data export. JSON-serializable. */
  async exportContactData(externalId: string): Promise<Record<string, unknown>> {
    const subscription = await this.collections.subscriptions.findOne({ externalId })
    const [events, flowRuns, sends, suppressions, tags] = await Promise.all([
      this.collections.events.find({ externalId }).toArray(),
      this.collections.flowRuns.find({ externalId }).toArray(),
      this.collections.sends.find({ externalId }).toArray(),
      subscription?.emailAtSubscribe
        ? this.collections.suppressions.find({ email: subscription.emailAtSubscribe }).toArray()
        : Promise.resolve([]),
      this.collections.contactTags.find({ externalId }).toArray(),
    ])
    return { subscription, events, flowRuns, sends, suppressions, tags }
  }

  // -------------------------------------------------------------------------
  // One-off transactional send (password reset etc.)
  // -------------------------------------------------------------------------

  async sendOneOff(input: SendOneOffInput): Promise<{ sendId: string }> {
    const parsed = sendOneOffInputSchema.parse(input)
    const template = await this.collections.templates.findOne({ slug: parsed.templateSlug })
    if (!template) throw new Error(`template not found: ${parsed.templateSlug}`)

    const contact = await this.adapter.getById(parsed.externalId)
    if (!contact) throw new Error(`contact not found: ${parsed.externalId}`)

    const dedupeKey = `oneoff:${parsed.dedupeKey}`
    const existing = await this.collections.sends.findOne({ dedupeKey })
    if (existing) return { sendId: String(existing._id) }

    const providerName =
      parsed.providerOverride
      ?? template.providerOverride
      ?? (template.kind === 'transactional' ? this.config.defaultTransactionalProvider : null)
      ?? this.config.defaultProvider

    const sendId = new ObjectIdCtor()
    await this.collections.sends.insertOne({
      _id: sendId,
      dedupeKey,
      externalId: parsed.externalId,
      emailAtSend: contact.email,
      templateId: template._id!,
      templateSlug: template.slug,
      flowRunId: null,
      broadcastId: null,
      manualSendBy: 'sendOneOff',
      kind: template.kind,
      provider: providerName,
      providerMessageId: null,
      fromName: template.fromName,
      fromEmail: template.fromEmail,
      subject: template.subject,
      bodyHash: '',
      status: 'queued',
      errorMessage: null,
      bounceType: null,
      bounceReason: null,
      links: [],
      vars: parsed.vars ?? {},
      openedAt: null,
      openCount: 0,
      firstClickAt: null,
      clickCount: 0,
      clickedLinks: [],
      unsubscribedAt: null,
      complainedAt: null,
      queuedAt: new Date(),
      updatedAt: new Date(),
      sentAt: null,
      deliveredAt: null,
    })

    await this.queues.send.add(
      'send',
      { sendId: String(sendId) },
      { attempts: this.config.sendRetryAttempts, backoff: { type: 'exponential', delay: 60_000 } },
    )

    return { sendId: String(sendId) }
  }

  // -------------------------------------------------------------------------
  // Audit log helper
  // -------------------------------------------------------------------------

  async audit(entry: {
    actor: string
    action: string
    resource: { collection: string; id?: string | ObjectId; slug?: string }
    before?: Record<string, unknown> | null
    after?: Record<string, unknown> | null
    diffSummary?: string
    ip?: string
    userAgent?: string
    requestId?: string
  }): Promise<void> {
    await this.collections.auditLog.insertOne({
      actor: entry.actor,
      action: entry.action,
      resource: entry.resource,
      before: entry.before ?? null,
      after: entry.after ?? null,
      diffSummary: entry.diffSummary ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      requestId: entry.requestId ?? null,
      occurredAt: new Date(),
    })
  }

  // -------------------------------------------------------------------------
  // Workers
  // -------------------------------------------------------------------------

  async startWorkers(): Promise<void> {
    if (this.workersStarted) return
    if (this.config.queue.driver === 'noop') {
      throw new Error('startWorkers requires a non-noop queue driver')
    }
    const provider = this.providers[this.config.defaultProvider]
    const sendRate = provider?.sendRatePerSecond ?? this.config.sendRatePerSecond

    await this.queueDriver.startWorkers({
      concurrency: { send: this.config.sendConcurrency },
      sendRateLimit: { max: sendRate, durationMs: 1_000 },
      retryAttempts: this.config.sendRetryAttempts,
      handlers: {
        tick: async () => {
          await runTick(this.runnerContext)
        },
        advance: async (data) => {
          if (!ObjectIdCtor.isValid(data.flowRunId)) return
          await processOneRunStep(new ObjectIdCtor(data.flowRunId), this.runnerContext)
        },
        send: async (data) => {
          if (!ObjectIdCtor.isValid(data.sendId)) return
          await dispatchSend(new ObjectIdCtor(data.sendId), this.runnerContext)
        },
        webhook: async () => {
          await this.processWebhookBacklog()
        },
      },
    })
    this.workersStarted = true
  }

  /** Process unprocessed webhook events in mailer_webhook_events. */
  private async processWebhookBacklog(): Promise<void> {
    const batch = await this.collections.webhookEvents
      .find({ processed: false })
      .limit(500)
      .toArray()

    for (const evt of batch) {
      try {
        // The stored `raw` wraps the normalized event we captured at ingest;
        // pull details back out so applyWebhookEvent has the bounce reason etc.
        const normalized = (evt.raw as any)?.normalized
        const details = normalized?.details ?? {}
        await applyWebhookEvent(
          {
            type: evt.normalizedType,
            providerEventId: evt.providerEventId,
            providerMessageId: evt.providerMessageId,
            email: evt.email,
            occurredAt: evt.occurredAt,
            details,
          },
          this.runnerContext,
        )
        await this.collections.webhookEvents.updateOne({ _id: evt._id }, { $set: { processed: true } })
      } catch (err) {
        console.error('mailery: webhook apply failed', { id: String(evt._id), err })
      }
    }
  }

  async stop(): Promise<void> {
    await this.queueDriver.close()
    this.workersStarted = false
  }

  /** Used internally by the admin router and tests; not part of the public API. */
  getRunnerContext(): RunnerContext {
    return this.runnerContext
  }
}
