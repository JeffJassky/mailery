/**
 * Setup-status: a small suite of synchronous checks the admin dashboard
 * surfaces as a banner. Each check returns an `ok | warn | error` verdict
 * with a short message and optional hint. The endpoint exists to catch the
 * "silent misconfiguration that breaks sends" class of bug — missing DOI
 * template, workers not running, fromDefaults on a domain that doesn't pass
 * the senderDomains registry, etc.
 */

import type { Mailer } from '../mailer.js'
import { validateSenderDomain } from '../templates/sender-domain.js'

export type CheckSeverity = 'ok' | 'warn' | 'error'

export interface SetupCheck {
  /** Stable identifier, e.g. 'mongo', 'workers_heartbeat'. */
  name: string
  /** Human-readable label, e.g. "MongoDB connection". */
  label: string
  severity: CheckSeverity
  message: string
  /** Optional remediation hint shown when the user expands the row. */
  hint?: string
}

export interface SetupStatus {
  overall: CheckSeverity
  generatedAt: string
  checks: SetupCheck[]
}

export async function runSetupChecks(mailer: Mailer): Promise<SetupStatus> {
  const checks: SetupCheck[] = []

  checks.push(await checkMongo(mailer))
  checks.push(await checkQueue(mailer))
  if (mailer.config.queue.driver !== 'noop' && !mailer.config.workerless) {
    checks.push(await checkWorkersHeartbeat(mailer))
  }
  checks.push(await checkCircuitBreaker(mailer))
  checks.push(...checkFromDefaultsAgainstRegistry(mailer))
  checks.push(...(await checkPublishedTemplates(mailer)))
  checks.push(await checkPostalAddress(mailer))
  checks.push(await checkDoiTemplate(mailer))

  const overall: CheckSeverity = checks.some((c) => c.severity === 'error')
    ? 'error'
    : checks.some((c) => c.severity === 'warn')
    ? 'warn'
    : 'ok'

  return {
    overall,
    generatedAt: new Date().toISOString(),
    checks,
  }
}

async function checkMongo(mailer: Mailer): Promise<SetupCheck> {
  try {
    await mailer.db.admin().ping()
    return { name: 'mongo', label: 'MongoDB connection', severity: 'ok', message: 'reachable' }
  } catch (err) {
    return {
      name: 'mongo',
      label: 'MongoDB connection',
      severity: 'error',
      message: `MongoDB ping failed: ${(err as Error)?.message ?? err}`,
      hint: 'Mailery is configured against an unreachable Mongo. Sends, flow advancement, and admin reads will all fail.',
    }
  }
}

async function checkQueue(mailer: Mailer): Promise<SetupCheck> {
  const driver = mailer.config.queue.driver
  if (driver === 'noop') {
    return {
      name: 'queue',
      label: 'Queue driver',
      severity: 'ok',
      message: 'driver: noop (synchronous-only mode)',
    }
  }
  try {
    await mailer.queues.send.getWaitingCount()
    return { name: 'queue', label: 'Queue driver', severity: 'ok', message: `driver: ${driver}` }
  } catch (err) {
    return {
      name: 'queue',
      label: 'Queue driver',
      severity: 'error',
      message: `${driver} queue is not responding: ${(err as Error)?.message ?? err}`,
      hint:
        driver === 'bull'
          ? 'Check Redis connectivity (queue.redis.url).'
          : 'Check the @hokify/agenda + Mongo connection.',
    }
  }
}

async function checkWorkersHeartbeat(mailer: Mailer): Promise<SetupCheck> {
  const h = await mailer.collections.health.findOne({ _id: 'singleton' })
  const tickIntervalMs = mailer.config.tickIntervalSeconds * 1000
  const staleAfterMs = Math.max(tickIntervalMs * 3, 30_000) // tolerate a couple missed ticks

  if (!h) {
    return {
      name: 'workers_heartbeat',
      label: 'Background workers',
      severity: 'warn',
      message: 'no tick has run yet',
      hint: 'If your separate worker process is started, the heartbeat will appear within one tick interval. If you forgot to run `mailer.startWorkers()`, sends will sit queued indefinitely.',
    }
  }

  const ageMs = Date.now() - new Date(h.updatedAt).getTime()
  if (ageMs > staleAfterMs) {
    return {
      name: 'workers_heartbeat',
      label: 'Background workers',
      severity: 'error',
      message: `last tick ${humanDuration(ageMs)} ago (expected within ${humanDuration(tickIntervalMs)})`,
      hint: 'Workers appear to be down. Sends and flow advancement are halted. Restart your worker process (`mailer.startWorkers()`).',
    }
  }
  return {
    name: 'workers_heartbeat',
    label: 'Background workers',
    severity: 'ok',
    message: `last tick ${humanDuration(ageMs)} ago`,
  }
}

async function checkCircuitBreaker(mailer: Mailer): Promise<SetupCheck> {
  const h = await mailer.collections.health.findOne({ _id: 'singleton' })
  if (!h || h.status === 'healthy') {
    return { name: 'circuit_breaker', label: 'Circuit breaker', severity: 'ok', message: 'healthy' }
  }
  if (h.status === 'degraded') {
    return {
      name: 'circuit_breaker',
      label: 'Circuit breaker',
      severity: 'warn',
      message: 'degraded (high failure rate)',
      hint: 'Marketing sends still flow but failure rate is above the degraded threshold. Investigate provider errors before they escalate to tripped.',
    }
  }
  return {
    name: 'circuit_breaker',
    label: 'Circuit breaker',
    severity: 'error',
    message: `tripped: ${h.trippedReason ?? 'unknown reason'}`,
    hint: 'Marketing sends are held. Investigate the underlying bounce / complaint cause, then POST /api/health/resume.',
  }
}

function checkFromDefaultsAgainstRegistry(mailer: Mailer): SetupCheck[] {
  const registry = mailer.config.senderDomains
  if (!registry || Object.keys(registry).length === 0) return []

  const out: SetupCheck[] = []
  const from = mailer.config.fromDefaults?.email
  const tx = mailer.config.transactionalFromDefaults?.email

  if (from) {
    const r = validateSenderDomain(from, 'marketing', registry)
    if (!r.ok) {
      out.push({
        name: 'from_defaults_marketing',
        label: 'fromDefaults vs senderDomains',
        severity: 'error',
        message: r.reason,
        hint: 'New marketing templates that fall back to fromDefaults will fail to publish.',
      })
    }
  }

  if (tx) {
    const r = validateSenderDomain(tx, 'transactional', registry)
    if (!r.ok) {
      out.push({
        name: 'transactional_from_defaults',
        label: 'transactionalFromDefaults vs senderDomains',
        severity: 'error',
        message: r.reason,
        hint: 'New transactional templates that fall back to transactionalFromDefaults will fail to publish.',
      })
    }
  } else if (from) {
    // No transactional defaults set; transactional creates will fall back to
    // fromDefaults. Check whether that fallback is valid for transactional.
    const r = validateSenderDomain(from, 'transactional', registry)
    if (!r.ok) {
      out.push({
        name: 'transactional_fallback',
        label: 'Transactional fallback',
        severity: 'warn',
        message: `transactionalFromDefaults is unset and fromDefaults (${from}) is invalid for transactional templates`,
        hint: 'Set transactionalFromDefaults to a transactional-kind domain, or set senderDomains entry for the existing one to "both".',
      })
    }
  }

  return out
}

async function checkPublishedTemplates(mailer: Mailer): Promise<SetupCheck[]> {
  const registry = mailer.config.senderDomains
  if (!registry || Object.keys(registry).length === 0) return []

  const published = await mailer.collections.templates
    .find({ publishedAt: { $ne: null } }, { projection: { slug: 1, kind: 1, fromEmail: 1 } })
    .toArray()

  const broken: Array<{ slug: string; reason: string }> = []
  for (const tpl of published) {
    const r = validateSenderDomain(tpl.fromEmail, tpl.kind, registry)
    if (!r.ok) broken.push({ slug: tpl.slug, reason: r.reason })
  }

  if (broken.length === 0) return []
  const list = broken.slice(0, 5).map((b) => `${b.slug} (${b.reason})`).join('; ')
  const more = broken.length > 5 ? ` …and ${broken.length - 5} more` : ''
  return [
    {
      name: 'published_template_domains',
      label: 'Published templates',
      severity: 'error',
      message: `${broken.length} published template${broken.length === 1 ? '' : 's'} use a fromEmail that no longer matches senderDomains: ${list}${more}`,
      hint: 'These templates will still send with their stored fromEmail until re-published. Edit each template and republish to surface the validation, or update senderDomains.',
    },
  ]
}

async function checkPostalAddress(mailer: Mailer): Promise<SetupCheck> {
  if (mailer.config.senderAddress) {
    return { name: 'postal_address', label: 'CAN-SPAM postal address', severity: 'ok', message: 'set' }
  }
  const marketingCount = await mailer.collections.templates.countDocuments({
    kind: 'marketing',
    publishedAt: { $ne: null },
  })
  if (marketingCount === 0) {
    return { name: 'postal_address', label: 'CAN-SPAM postal address', severity: 'ok', message: 'no published marketing templates yet' }
  }
  return {
    name: 'postal_address',
    label: 'CAN-SPAM postal address',
    severity: 'warn',
    message: `${marketingCount} published marketing template${marketingCount === 1 ? '' : 's'} but senderAddress is unset`,
    hint: 'CAN-SPAM requires a postal address in marketing emails. Set `senderAddress` in your Mailer config and reference it via `{{senderAddress}}` in your templates.',
  }
}

async function checkDoiTemplate(mailer: Mailer): Promise<SetupCheck> {
  if (!mailer.config.requireDoubleOptIn) {
    return { name: 'doi_template', label: 'DOI template', severity: 'ok', message: 'DOI not required' }
  }
  const tpl = await mailer.collections.templates.findOne({
    slug: mailer.config.doiTemplateSlug,
    publishedAt: { $ne: null },
  })
  if (tpl) {
    return { name: 'doi_template', label: 'DOI template', severity: 'ok', message: `template "${tpl.slug}" published` }
  }
  return {
    name: 'doi_template',
    label: 'DOI template',
    severity: 'error',
    message: `requireDoubleOptIn is true but no published template with slug "${mailer.config.doiTemplateSlug}"`,
    hint: 'New subscriptions will silently fail to send confirmation emails. Create and publish a template with this slug, or unset requireDoubleOptIn.',
  }
}

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}
