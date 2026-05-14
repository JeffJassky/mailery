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
import { resolveSourceTags } from '../runner/dmarc.js'
import { HEALTH_AGG_ID } from '../models/index.js'

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
  checks.push(await checkDnsbl(mailer))
  checks.push(await checkPostmaster(mailer))
  checks.push(await checkSnds(mailer))
  const jmrp = checkJmrp(mailer)
  if (jmrp) checks.push(jmrp)
  checks.push(await checkDmarc(mailer))
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
  // The aggregate doc's updatedAt is touched on every counter increment and
  // on every evaluate tick, so it's the canonical worker-heartbeat marker.
  const h = await mailer.collections.health.findOne(
    {},
    { sort: { updatedAt: -1 } },
  )
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
  const docs = await mailer.collections.health.find({}).toArray()
  const buckets = docs.filter((d) => d._id !== HEALTH_AGG_ID)

  if (buckets.length === 0) {
    // No telemetry yet (heartbeat-only state, no sends recorded). Claiming
    // "healthy" misleads — there's nothing to base it on.
    return {
      name: 'circuit_breaker',
      label: 'Circuit breaker',
      severity: 'ok',
      message: 'no telemetry yet',
      hint: 'The breaker tracks bounce / complaint rates per (sender domain × kind) and starts evaluating once enough sends have been recorded. Send some mail to populate.',
    }
  }

  const tripped = buckets.filter((d) => d.status === 'tripped')
  if (tripped.length > 0) {
    const summary = tripped
      .map((d) => `${d.senderDomain ?? '_unknown'}/${d.kind}`)
      .join(', ')
    return {
      name: 'circuit_breaker',
      label: 'Circuit breaker',
      severity: 'error',
      message: `tripped: ${summary}`,
      hint: 'Marketing sends are held for the listed bucket(s). Investigate the underlying bounce / complaint cause, then POST /api/health/resume (with optional senderDomain + kind to resume one bucket).',
    }
  }

  const degraded = buckets.filter((d) => d.status === 'degraded')
  if (degraded.length > 0) {
    const summary = degraded
      .map((d) => `${d.senderDomain ?? '_unknown'}/${d.kind}`)
      .join(', ')
    return {
      name: 'circuit_breaker',
      label: 'Circuit breaker',
      severity: 'warn',
      message: `degraded: ${summary}`,
      hint: 'Marketing sends still flow but failure rate is above the degraded threshold for the listed bucket(s). Investigate provider errors before they escalate to tripped.',
    }
  }

  return { name: 'circuit_breaker', label: 'Circuit breaker', severity: 'ok', message: 'healthy' }
}

async function checkDnsbl(mailer: Mailer): Promise<SetupCheck> {
  const docs = await mailer.collections.dnsblChecks.find({}).toArray()
  if (docs.length === 0) {
    return {
      name: 'dnsbl',
      label: 'DNS block-list checks',
      severity: 'ok',
      message: 'no checks run yet',
      hint: 'Checks run automatically once per dnsbl.intervalHours (default 24h). To run now, POST /api/dnsbl/recheck.',
    }
  }
  const listed = docs.filter((d) => d.result === 'listed')
  if (listed.length > 0) {
    const summary = listed
      .map((d) => `${d.target} on ${d.listLabel}`)
      .slice(0, 3)
      .join('; ')
    const more = listed.length > 3 ? ` (+${listed.length - 3} more)` : ''
    return {
      name: 'dnsbl',
      label: 'DNS block-list checks',
      severity: 'error',
      message: `${listed.length} listing(s): ${summary}${more}`,
      hint: 'A sender domain or IP is listed on a public DNSBL. Investigate the listing source — most lists publish a removal procedure on their website. Mail to the affected (domain, kind) bucket will likely land in spam until delisted.',
    }
  }
  const errored = docs.filter((d) => d.result === 'error')
  if (errored.length === docs.length) {
    return {
      name: 'dnsbl',
      label: 'DNS block-list checks',
      severity: 'warn',
      message: `all ${docs.length} checks errored`,
      hint: 'Lookups against block lists are failing — usually a DNS-resolution problem on the host running mailery, or a list rate-limiting your public resolver. Verify outbound DNS works.',
    }
  }
  return {
    name: 'dnsbl',
    label: 'DNS block-list checks',
    severity: 'ok',
    message: `clean (${docs.length} checks)`,
  }
}

async function checkPostmaster(mailer: Mailer): Promise<SetupCheck> {
  const cfg = mailer.config.postmaster
  if (!cfg?.clientId || !cfg?.clientSecret || !cfg?.refreshToken) {
    // Postmaster is opt-in (needs OAuth setup) and only meaningful at >100/day
    // to Gmail. Treat "not configured" as ok so it doesn't spam every operator
    // with a permanent warning banner.
    return {
      name: 'postmaster',
      label: 'Google Postmaster Tools',
      severity: 'ok',
      message: 'not configured (optional)',
      hint: 'Set mailer.config.postmaster with an OAuth client + refresh token to pull authoritative Gmail reputation data. Only meaningful at >100 sends/day to Gmail.',
    }
  }

  const snapshots = await mailer.collections.postmasterSnapshots.find({}).sort({ fetchedAt: -1 }).toArray()
  if (snapshots.length === 0) {
    return {
      name: 'postmaster',
      label: 'Google Postmaster Tools',
      severity: 'warn',
      message: 'configured but no data yet',
      hint: 'A pull runs once per postmaster.intervalHours (default 24h). To run now, POST /api/postmaster/refresh. Postmaster only reports for domains with >100 messages/day to Gmail; smaller senders see empty responses.',
    }
  }

  // Find the latest snapshot per domain (snapshots are already sorted by fetchedAt desc).
  const latestByDomain = new Map<string, typeof snapshots[number]>()
  for (const s of snapshots) {
    if (!latestByDomain.has(s.domain)) latestByDomain.set(s.domain, s)
  }
  const bad: string[] = []
  const low: string[] = []
  for (const s of latestByDomain.values()) {
    if (s.domainReputation === 'BAD') bad.push(s.domain)
    else if (s.domainReputation === 'LOW') low.push(s.domain)
  }

  if (bad.length > 0) {
    return {
      name: 'postmaster',
      label: 'Google Postmaster Tools',
      severity: 'error',
      message: `BAD reputation on ${bad.join(', ')}`,
      hint: 'Gmail considers these domains spammy. Most mail to Gmail addresses will land in spam folder. Marketing breaker has been tripped for affected domains. See docs/guide/warming.md §6 for recovery.',
    }
  }
  if (low.length > 0) {
    return {
      name: 'postmaster',
      label: 'Google Postmaster Tools',
      severity: 'warn',
      message: `LOW reputation on ${low.join(', ')}`,
      hint: 'Reputation has slipped below Medium. Review recent complaint + bounce activity, slow down marketing volume, and re-engage your most active segment only.',
    }
  }
  return {
    name: 'postmaster',
    label: 'Google Postmaster Tools',
    severity: 'ok',
    // Includes REPUTATION_CATEGORY_UNSPECIFIED ("no data yet") domains —
    // surface that explicitly so the operator isn't misled.
    message: (() => {
      const tiers = new Set(Array.from(latestByDomain.values()).map((d) => d.domainReputation))
      const hasUnspec = tiers.has('REPUTATION_CATEGORY_UNSPECIFIED' as any)
      return `${latestByDomain.size} domain(s) tracked${hasUnspec ? ' (some have no reputation data yet)' : ', all High/Medium'}`
    })(),
  }
}

/**
 * JMRP enrolment is a manual one-time setup on the Microsoft sender-support
 * portal — there's no API to confirm completion. We surface a persistent
 * info-level reminder whenever the operator has configured a dedicated IP,
 * regardless of whether SNDS itself is set up. Operators can suppress this
 * by setting `dnsbl.dedicatedIps = []` once they've confirmed enrolment in
 * their runbook.
 */
function checkJmrp(mailer: Mailer): SetupCheck | null {
  const hasDedicatedIp = (mailer.config.dnsbl?.dedicatedIps?.length ?? 0) > 0
  if (!hasDedicatedIp) return null
  return {
    name: 'snds_jmrp',
    label: 'Microsoft JMRP enrolment',
    severity: 'ok',
    message: 'manual setup — confirm in your runbook',
    hint: 'Outlook spam complaints only land in mailery if you enrol each sending IP in JMRP. Visit https://sendersupport.olc.protection.outlook.com/snds/JMRP.aspx and complete the form for each IP. There is no API to verify completion; mailery shows this reminder whenever dedicatedIps is non-empty.',
  }
}

async function checkSnds(mailer: Mailer): Promise<SetupCheck> {
  const cfg = mailer.config.snds
  const hasDedicatedIp = (mailer.config.dnsbl?.dedicatedIps?.length ?? 0) > 0

  if (!cfg?.accessKey) {
    if (!hasDedicatedIp) {
      return {
        name: 'snds',
        label: 'Microsoft SNDS',
        severity: 'ok',
        message: 'not applicable (no dedicated IP)',
        hint: 'SNDS reports IP-level Outlook/Hotmail reputation. Only meaningful when you send from a dedicated IP. Skip unless you do.',
      }
    }
    return {
      name: 'snds',
      label: 'Microsoft SNDS',
      severity: 'warn',
      message: 'dedicated IP configured but SNDS access key not set',
      hint: 'Sign in at https://sendersupport.olc.protection.outlook.com/snds/ , request access for your IP(s), then set mailer.config.snds.accessKey to enable daily pulls. Also enrol in JMRP at https://sendersupport.olc.protection.outlook.com/snds/JMRP.aspx so Outlook complaints flow back to your suppression list.',
    }
  }

  const snapshots = await mailer.collections.sndsSnapshots.find({}).sort({ fetchedAt: -1 }).toArray()
  if (snapshots.length === 0) {
    return {
      name: 'snds',
      label: 'Microsoft SNDS',
      severity: 'warn',
      message: 'configured but no data yet',
      hint: 'A pull runs every snds.intervalHours (default 24h). To run now, POST /api/snds/refresh. If you just enrolled, SNDS data can take 1-2 days to populate.',
    }
  }

  const latestByIp = new Map<string, typeof snapshots[number]>()
  for (const s of snapshots) {
    if (!latestByIp.has(s.ip)) latestByIp.set(s.ip, s)
  }
  const red: string[] = []
  const yellow: string[] = []
  for (const s of latestByIp.values()) {
    if (s.filterResult === 'RED') red.push(s.ip)
    else if (s.filterResult === 'YELLOW') yellow.push(s.ip)
  }

  if (red.length > 0) {
    return {
      name: 'snds',
      label: 'Microsoft SNDS',
      severity: 'error',
      message: `RED filter on ${red.join(', ')}`,
      hint: 'Outlook/Hotmail is filtering mail from these IPs as spam. Reduce volume, audit recent complaints / trap hits, fix any auth alignment problems, and wait for reputation to recover (typically 1-2 weeks).',
    }
  }
  if (yellow.length > 0) {
    return {
      name: 'snds',
      label: 'Microsoft SNDS',
      severity: 'warn',
      message: `YELLOW filter on ${yellow.join(', ')}`,
      hint: 'Outlook is putting some mail from these IPs in the junk folder. Investigate recent complaint rate and trap hits before reputation slips to RED.',
    }
  }
  return {
    name: 'snds',
    label: 'Microsoft SNDS',
    severity: 'ok',
    message: `${latestByIp.size} IP(s) tracked, all GREEN`,
  }
}

async function checkDmarc(mailer: Mailer): Promise<SetupCheck> {
  const reportCount = await mailer.collections.dmarcReports.estimatedDocumentCount()
  if (reportCount === 0) {
    return {
      name: 'dmarc',
      label: 'DMARC RUA reports',
      severity: 'ok',
      message: 'no reports ingested yet',
      hint: 'Publish DMARC `rua=mailto:<your-mailbox>` in DNS, then upload received reports via /admin/mailer/api/dmarc/upload (or drag-drop in the Health screen). RUA tells you who is sending mail as your domain — both legitimate sources and spoofers.',
    }
  }

  const since = new Date(Date.now() - 7 * 86_400_000)
  const recent = await mailer.collections.dmarcReports.find({ rangeEnd: { $gte: since } }).toArray()
  if (recent.length === 0) {
    return {
      name: 'dmarc',
      label: 'DMARC RUA reports',
      severity: 'warn',
      message: `no reports in the last 7 days (${reportCount} total)`,
      hint: 'Receivers email RUA reports daily. A gap suggests inbound delivery is broken or the rua= mailbox is no longer monitored. Check inbound mail flow.',
    }
  }

  // Merge config-defined tags with DB-defined tags so operator tags set via
  // the admin UI count. Both labeled (non-ignored) and ignored sources are
  // treated as "known" — operator already triaged them.
  const tagged = await resolveSourceTags(mailer.getRunnerContext())
  const known = new Set(Array.from(tagged.keys()))
  const since30 = new Date(Date.now() - 30 * 86_400_000)
  const failures = await mailer.collections.dmarcFailures.find({ receivedAt: { $gte: since30 } }).toArray()
  const unknownFailing = failures.filter((f) => !known.has(f.sourceIp))

  if (unknownFailing.length === 0) {
    return {
      name: 'dmarc',
      label: 'DMARC RUA reports',
      severity: 'ok',
      message: `${recent.length} report(s) this week, no failing unknown sources`,
    }
  }

  const totalFailing = unknownFailing.reduce((acc, f) => acc + f.count, 0)
  const ips = Array.from(new Set(unknownFailing.map((f) => f.sourceIp))).slice(0, 3)
  const more = unknownFailing.length > 3 ? ` (+${unknownFailing.length - 3} more)` : ''
  return {
    name: 'dmarc',
    label: 'DMARC RUA reports',
    severity: 'warn',
    message: `${totalFailing} failing message(s) from ${ips.join(', ')}${more}`,
    hint: 'These IPs sent mail claiming to be from your domain that failed DMARC alignment. Tag known-legit sources in mailer.config.dmarc.knownSources to silence them. Untagged sources are likely either forgotten SaaS tools or active spoofing.',
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
