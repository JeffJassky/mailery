/**
 * Mailer — public facade. Hosts call `Mailer.init(config)` and get an object
 * exposing the public API (fire, upsertSubscription, unsubscribe, ...) plus
 * mountable Express routers.
 *
 * See plans/10-public-api.md for the surface.
 */

import type { Db, ClientSession, ObjectId } from 'mongodb'
import { ObjectId as ObjectIdCtor } from 'mongodb'
import type IORedis from 'ioredis'

import type {
  ContactAdapter,
  MailProvider,
} from '../shared/types.js'
import {
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
import { sha256Hex } from './tokens.js'
import {
  closeQueues,
  closeWorkers,
  createQueues,
  createWorkers,
  makeRedis,
  scheduleTick,
  type Queues,
  type Workers,
} from './queues/index.js'
import {
  dispatchSend,
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
  readonly redis: IORedis
  readonly queues: Queues
  readonly config: ResolvedConfig
  readonly events: EventRegistry

  private workers: Workers | null = null
  private runnerContext: RunnerContext

  private constructor(args: {
    config: ResolvedConfig
    db: Db
    collections: Collections
    adapter: ContactAdapter
    providers: Record<string, MailProvider>
    redis: IORedis
    queues: Queues
    events: EventRegistry
  }) {
    this.config = args.config
    this.db = args.db
    this.collections = args.collections
    this.adapter = args.adapter
    this.providers = args.providers
    this.redis = args.redis
    this.queues = args.queues
    this.events = args.events

    this.runnerContext = {
      db: this.db,
      collections: this.collections,
      adapter: this.adapter,
      providers: this.providers,
      queues: this.queues,
      config: this.config,
      handlebarsHelpers: this.config.handlebarsHelpers,
    }
  }

  static async init(input: MailerConfig): Promise<Mailer> {
    const config = resolveConfig(input)
    if (!config.providers[config.defaultProvider]) {
      throw new Error(`defaultProvider "${config.defaultProvider}" not in providers map`)
    }

    const collections = getCollections(config.db, config.collectionPrefix)
    await ensureIndexes(config.db, config.collectionPrefix)

    const redis = makeRedis(config.redis)
    const queues = createQueues(redis)
    await scheduleTick(queues, config.tickIntervalSeconds)

    return new Mailer({
      config,
      db: config.db,
      collections,
      adapter: config.adapter,
      providers: config.providers,
      redis,
      queues,
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

    await this.collections.subscriptions.updateOne(
      { externalId: parsed.externalId },
      {
        $set: {
          status,
          source: parsed.source,
          emailAtSubscribe: contact.email,
          subscribedAt: status === 'subscribed' ? (parsed.consentTimestamp ?? now) : null,
          updatedAt: now,
        },
        $setOnInsert: {
          externalId: parsed.externalId,
          createdAt: now,
          unsubscribedAt: null,
          unsubscribeReason: null,
          doiTokenHash: null,
          doiRequestedAt: status === 'pending_doi' ? now : null,
          doiConfirmedAt: null,
          doiIp: parsed.consentIp ?? null,
          doiUserAgent: parsed.consentUserAgent ?? null,
        },
      },
      { upsert: true },
    )
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
      openedAt: null,
      openCount: 0,
      firstClickAt: null,
      clickCount: 0,
      clickedLinks: [],
      unsubscribedAt: null,
      complainedAt: null,
      queuedAt: new Date(),
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
    if (this.workers) return
    const provider = this.providers[this.config.defaultProvider]
    const sendRate = provider?.sendRatePerSecond ?? this.config.sendRatePerSecond

    this.workers = createWorkers({
      redis: this.redis,
      concurrency: { send: this.config.sendConcurrency },
      sendRateLimit: { max: sendRate, durationMs: 1_000 },
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
  }

  /** Process unprocessed webhook events in mailer_webhook_events. */
  private async processWebhookBacklog(): Promise<void> {
    const batch = await this.collections.webhookEvents
      .find({ processed: false })
      .limit(500)
      .toArray()

    for (const evt of batch) {
      try {
        await applyWebhookEvent(
          {
            type: evt.normalizedType,
            providerEventId: evt.providerEventId,
            providerMessageId: evt.providerMessageId,
            email: evt.email,
            occurredAt: evt.occurredAt,
            details: {},
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
    if (this.workers) {
      await closeWorkers(this.workers)
      this.workers = null
    }
    await closeQueues(this.queues)
    await this.redis.quit()
  }

  /** Used internally by the admin router and tests; not part of the public API. */
  getRunnerContext(): RunnerContext {
    return this.runnerContext
  }
}
