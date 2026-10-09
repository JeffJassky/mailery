/**
 * DMARC Monitoring runner: scheduled DNS checks, alert evaluation, the alert
 * state machine and hook delivery. Spec: plans/18-dmarc-monitoring.md §6.4–6.6.
 */

import type { DmarcAlertStateDoc } from '../models/index.js'
import type { DmarcAlert, DmarcAlertCandidate, DmarcAlertDelivery, DmarcAlertEvent, DmarcDnsCheckResult, DmarcDnsResolver } from '../../shared/dmarc-types.js'
import type { RunnerContext } from './index.js'
import { checkDmarcDns, lookupPtr, organizationalDomain } from './dmarc-dns.js'
import { resolveMonitoredDomains } from './dmarc-domains.js'
import { loadDmarcSettings } from './dmarc-settings.js'
import { buildResolvedAlert, buildTestDmarcAlert, computeDmarcAlertCandidates, finalizeDmarcAlert } from './dmarc-alerts.js'
import { resolveSourceTags } from './dmarc.js'

export interface DmarcMonitorOptions {
  resolver?: DmarcDnsResolver
  now?: Date
  /** Bypass the hourly evaluation throttle and the per-domain DNS interval. */
  force?: boolean
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const EVAL_INTERVAL_MS = HOUR
const SOURCE_KINDS = new Set<string>(['unknown_source_failing', 'known_source_failing'])

let _lastEvalAt = 0

async function monitoredDomains(ctx: RunnerContext, settings: Awaited<ReturnType<typeof loadDmarcSettings>>['settings']) {
  const reportDomains = (await ctx.collections.dmarcReports.distinct('domain')) as string[]
  return resolveMonitoredDomains(ctx.config, settings, reportDomains)
}

/**
 * Tick entry point. Does nothing — no DNS, no reads beyond one count — unless
 * `config.dmarc` is set or at least one report has been ingested.
 */
export async function runDmarcMonitor(
  ctx: RunnerContext,
  opts: DmarcMonitorOptions = {},
): Promise<{ ran: boolean; reason?: string }> {
  const active = ctx.config.dmarc !== undefined || (await ctx.collections.dmarcReports.estimatedDocumentCount()) > 0
  if (!active) return { ran: false, reason: 'inactive' }
  await runDmarcDnsChecks(ctx, opts)
  await evaluateDmarcAlerts(ctx, opts)
  return { ran: true }
}

export async function runDmarcDnsChecks(
  ctx: RunnerContext,
  opts: DmarcMonitorOptions & { domain?: string } = {},
): Promise<DmarcDnsCheckResult[]> {
  const now = opts.now ?? new Date()
  const { settings } = await loadDmarcSettings(ctx)
  const domains = (await monitoredDomains(ctx, settings)).filter((d) => !d.ignored).map((d) => d.domain)

  let targets: string[]
  if (opts.domain !== undefined) {
    const wanted = opts.domain.toLowerCase()
    if (!domains.includes(wanted)) throw new Error(`domain ${opts.domain} is not monitored`)
    targets = [wanted]
  } else {
    const hours = settings.alerts.dnsCheckIntervalHours
    if (hours === 0 && !opts.force) return []
    targets = domains
    if (!opts.force) {
      const stored = await ctx.collections.dmarcDnsChecks.find({ _id: { $in: domains } }).toArray()
      const cutoff = now.getTime() - hours * HOUR
      const fresh = new Set(stored.filter((s) => s.checkedAt.getTime() > cutoff).map((s) => s._id))
      targets = domains.filter((d) => !fresh.has(d))
    }
  }

  const domainSet = new Set(domains)
  const results: DmarcDnsCheckResult[] = []
  for (const domain of targets) {
    const org = organizationalDomain(domain)
    const result = await checkDmarcDns(domain, {
      resolver: opts.resolver,
      reportAddress: settings.reportAddress,
      now,
      orgDomainInSet: org !== domain && domainSet.has(org),
    })
    await ctx.collections.dmarcDnsChecks.updateOne(
      { _id: domain },
      { $set: { result, checkedAt: now } },
      { upsert: true },
    )
    results.push(result)
  }
  return results
}

export async function evaluateDmarcAlerts(
  ctx: RunnerContext,
  opts: DmarcMonitorOptions = {},
): Promise<{ ran: boolean; reason?: string; fired: number; open: number }> {
  const openCount = () => ctx.collections.dmarcAlerts.countDocuments({ status: 'open' })
  if (!opts.force && Date.now() - _lastEvalAt < EVAL_INTERVAL_MS) {
    return { ran: false, reason: 'throttled', fired: 0, open: await openCount() }
  }
  _lastEvalAt = Date.now()

  const now = opts.now ?? new Date()
  const { settings } = await loadDmarcSettings(ctx)
  if (!settings.alerts.enabled) return { ran: false, reason: 'disabled', fired: 0, open: await openCount() }

  const adminUrl = ctx.config.dmarc?.adminUrl ?? null
  const alerts = ctx.collections.dmarcAlerts
  const monitored = (await monitoredDomains(ctx, settings)).filter((d) => !d.ignored).map((d) => d.domain)
  const [reports, failures, tags, checks] = await Promise.all([
    ctx.collections.dmarcReports.find({ rangeEnd: { $gte: new Date(now.getTime() - 35 * DAY) } }).toArray(),
    ctx.collections.dmarcFailures.find({ receivedAt: { $gte: new Date(now.getTime() - 30 * DAY) } }).toArray(),
    resolveSourceTags(ctx),
    ctx.collections.dmarcDnsChecks.find({}).toArray(),
  ])
  const candidates = computeDmarcAlertCandidates({
    now,
    settings,
    monitoredDomains: monitored,
    reports,
    failures,
    tags,
    dnsChecks: new Map(checks.map((c) => [c._id, c.result])),
  })

  let fired = 0
  const fire = async (
    candidate: DmarcAlertCandidate,
    event: DmarcAlertEvent,
    firstDetectedAt: Date,
    newSourceIps: string[],
  ) => {
    const ptrs = await lookupPtr(candidate.sources.map((s) => s.ip), { resolver: opts.resolver })
    const withPtr: DmarcAlertCandidate = {
      ...candidate,
      sources: candidate.sources.map((s) => ({ ...s, ptr: ptrs.get(s.ip) ?? s.ptr })),
    }
    fired++
    await fireDmarcAlert(ctx, finalizeDmarcAlert(withPtr, { event, firstDetectedAt, newSourceIps, adminUrl }))
  }

  for (const c of candidates) {
    const state: DmarcAlertStateDoc = {
      _id: c.id,
      kind: c.kind,
      domain: c.domain,
      status: 'open',
      severity: c.severity,
      title: c.title,
      subjectKeys: c.subjectKeys,
      firstDetectedAt: now,
      lastDetectedAt: now,
      lastFiredAt: now,
      fireCount: 1,
      resolvedAt: null,
      lastAlert: finalizeDmarcAlert(c, { event: 'opened', firstDetectedAt: now, newSourceIps: [], adminUrl }),
      lastDelivery: null,
    }
    try {
      await alerts.insertOne(state)
      await fire(c, 'opened', now, [])
      continue
    } catch (err) {
      if ((err as { code?: number } | null)?.code !== 11000) throw err
    }

    const existing = await alerts.findOne({ _id: c.id })
    if (!existing) continue

    if (existing.status === 'resolved') {
      const r = await alerts.updateOne(
        { _id: c.id, status: 'resolved' },
        {
          $set: {
            status: 'open',
            firstDetectedAt: now,
            lastDetectedAt: now,
            lastFiredAt: now,
            fireCount: 1,
            resolvedAt: null,
            subjectKeys: c.subjectKeys,
            severity: c.severity,
            title: c.title,
          },
        },
      )
      if (r.modifiedCount > 0) await fire(c, 'opened', now, [])
      continue
    }

    const newKeys = c.subjectKeys.filter((k) => !existing.subjectKeys.includes(k))
    const remind =
      settings.alerts.realertAfterHours > 0 &&
      existing.lastFiredAt.getTime() <= now.getTime() - settings.alerts.realertAfterHours * HOUR
    if (newKeys.length > 0 || remind) {
      const r = await alerts.updateOne(
        { _id: c.id, lastFiredAt: existing.lastFiredAt },
        {
          $set: {
            subjectKeys: [...new Set([...existing.subjectKeys, ...c.subjectKeys])],
            lastFiredAt: now,
            lastDetectedAt: now,
            severity: c.severity,
            title: c.title,
          },
          $inc: { fireCount: 1 },
        },
      )
      if (r.modifiedCount > 0) {
        await fire(c, newKeys.length > 0 ? 'updated' : 'reminder', existing.firstDetectedAt, newKeys.length > 0 && SOURCE_KINDS.has(c.kind) ? newKeys : [])
      }
      continue
    }

    await alerts.updateOne(
      { _id: c.id },
      { $set: { lastDetectedAt: now, severity: c.severity, title: c.title } },
    )
  }

  const candidateIds = new Set(candidates.map((c) => c.id))
  const monitoredSet = new Set(monitored)
  const stillOpen = await alerts.find({ status: 'open' }).toArray()
  for (const doc of stillOpen) {
    if (doc.kind === 'test' || candidateIds.has(doc._id)) continue
    const r = await alerts.updateOne(
      { _id: doc._id, status: 'open' },
      { $set: { status: 'resolved', resolvedAt: now } },
    )
    if (r.modifiedCount === 0) continue
    const silent =
      doc.kind === 'policy_ready' ||
      (settings.alerts.disabledKinds as string[]).includes(doc.kind) ||
      !monitoredSet.has(doc.domain)
    if (silent) continue
    fired++
    await fireDmarcAlert(ctx, buildResolvedAlert(doc, now, adminUrl))
  }

  return { ran: true, fired, open: await openCount() }
}

export async function fireDmarcAlert(ctx: RunnerContext, alert: DmarcAlert): Promise<DmarcAlertDelivery> {
  let delivery: DmarcAlertDelivery
  const hook = ctx.config.onDmarcAlert
  if (!hook) {
    delivery = { outcome: 'no_handler', at: new Date() }
  } else {
    try {
      await Promise.resolve().then(() => hook(alert))
      delivery = { outcome: 'delivered', at: new Date() }
    } catch (err) {
      delivery = { outcome: 'failed', at: new Date(), error: err instanceof Error ? err.message : String(err) }
    }
  }

  if (alert.kind !== 'test') {
    try {
      await ctx.collections.dmarcAlerts.updateOne({ _id: alert.id }, { $set: { lastAlert: alert, lastDelivery: delivery } })
    } catch {
      /* delivery bookkeeping must not fail the run */
    }
  }
  if (ctx.audit) {
    try {
      await ctx.audit({
        actor: 'system:dmarc-monitor',
        action: `dmarc.alert.${alert.event}`,
        resource: { collection: 'mailer_dmarc_alerts', id: alert.id },
        diffSummary: alert.title,
      })
    } catch {
      /* audit failure must not block the runner */
    }
  }
  return delivery
}

export async function sendTestDmarcAlert(
  ctx: RunnerContext,
  opts: { now?: Date } = {},
): Promise<{ delivery: DmarcAlertDelivery; alert: DmarcAlert }> {
  const now = opts.now ?? new Date()
  const { settings } = await loadDmarcSettings(ctx)
  const domain = (await monitoredDomains(ctx, settings)).find((d) => !d.ignored)?.domain ?? 'example.com'
  const alert = buildTestDmarcAlert(domain, now, ctx.config.dmarc?.adminUrl ?? null)
  const delivery = await fireDmarcAlert(ctx, alert)
  return { delivery, alert }
}

/** Tests only: forget the process-local evaluation throttle. */
export function _resetDmarcMonitorThrottle(): void {
  _lastEvalAt = 0
}
