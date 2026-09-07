/**
 * Enabling a flow, done safely — and running it against test contacts only.
 *
 * The trigger scan starts from `flow.lastTriggerScanAt ?? flow.createdAt`
 * (triggers.ts). A flow that has never been enabled has a null watermark, so a
 * bare `enabled: true` replays every matching event since the flow document
 * was created: every signup of the past month gets the welcome email in one
 * tick, a week or more late. That is the single most dangerous write in the
 * admin surface, and until 0.16 it was one click (publish, or resume).
 *
 * `armFlow` is the path that flips `enabled` on. It stamps the watermark
 * (default: now) in the SAME update, reports how many events it is choosing
 * to skip, and writes an audit row. `publish` and `resume` in the admin API
 * go through `stampWatermarkIfNull` for the same guarantee.
 *
 * `gateFlow` publishes a canary version whose first step exits anyone
 * without a tag, so the real runner can exercise the real steps in
 * production against test contacts while every real contact enters and
 * exits at step 0 with no send. `ungateFlow` restores the newest ungated
 * version. Runs pin their version, so a contact mid-canary finishes on it.
 */

import type { Mailer } from '../mailer.js'
import type { Collections, FlowDoc } from '../models/index.js'
import type { FlowStep } from '../../shared/types.js'
import { SCAN_OVERLAP_MS } from './triggers.js'

/** A typed failure the HTTP layer can map to a status code without guessing. */
export class FlowOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message)
    this.name = 'FlowOperationError'
  }
}

export interface ArmFlowOptions {
  /** Audit actor, e.g. `agent:claude` or `human:jeff@example.com`. */
  actor: string
  /**
   * Watermark to stamp. Defaults to now, which means only events fired AFTER
   * this call enter the flow. Pass an earlier instant only when you mean for
   * the events after it to enter — the result says how many that is.
   */
  since?: Date
}

export interface ArmFlowResult {
  slug: string
  version: number
  /** True when this call flipped `enabled` on. */
  armed: boolean
  /** True when the flow was already enabled; nothing was written. */
  alreadyEnabled: boolean
  /** The watermark now on the flow. */
  watermark: Date | null
  eventName: string | null
  /** Events for the trigger name that fired before the watermark and will never enter. */
  skippedEvents: number
  /**
   * Events that WILL enter on the next tick: everything after the watermark,
   * plus anything created inside the scanner's 30-second overlap window just
   * before it.
   */
  pendingEvents: number
}

/**
 * Stamp `lastTriggerScanAt` when it is null. Used by every code path that
 * turns `enabled` on so a first enable never replays history. A flow that
 * has scanned before keeps its watermark: pausing and resuming deliberately
 * lets the events fired during the pause enter.
 */
export async function stampWatermarkIfNull(
  collections: Collections,
  flow: FlowDoc,
  now: Date = new Date(),
): Promise<Date | null> {
  if (flow.lastTriggerScanAt) return flow.lastTriggerScanAt
  await collections.flows.updateOne(
    { _id: flow._id, lastTriggerScanAt: null },
    { $set: { lastTriggerScanAt: now, updatedAt: now } },
  )
  return now
}

export async function armFlow(mailer: Mailer, slug: string, opts: ArmFlowOptions): Promise<ArmFlowResult> {
  const c = mailer.collections
  const flow = await c.flows.findOne({ slug })
  if (!flow) throw new FlowOperationError('not_found', `no flow with slug "${slug}"`, 404)
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    throw new FlowOperationError(
      'no_live_steps',
      `flow "${slug}" (v${flow.version}) has no published steps — publish it first; an empty flow completes every run instantly`,
      409,
    )
  }
  const eventName = flow.trigger?.eventName ?? null
  const now = new Date()
  const watermark = opts.since ?? now

  if (flow.enabled) {
    return {
      slug,
      version: flow.version,
      armed: false,
      alreadyEnabled: true,
      watermark: flow.lastTriggerScanAt ?? null,
      eventName,
      skippedEvents: 0,
      pendingEvents: 0,
    }
  }

  // The scan re-reads SCAN_OVERLAP_MS of history behind the watermark (its
  // own guard against a concurrent fire() committing slightly out of order),
  // so an event created inside that window before the watermark still
  // enters. Count it as pending, not skipped, so the caller is told the
  // truth: arming "now" admits the last half minute of matching events —
  // for a signup flow that is a person who signed up thirty seconds ago,
  // which is right.
  const previous = flow.lastTriggerScanAt ?? flow.createdAt
  const overlapFrom = new Date(watermark.getTime() - SCAN_OVERLAP_MS)
  const [skippedEvents, pendingEvents] = eventName
    ? await Promise.all([
        c.events.countDocuments({ name: eventName, createdAt: { $gt: previous, $lte: overlapFrom } }),
        c.events.countDocuments({ name: eventName, createdAt: { $gt: overlapFrom } }),
      ])
    : [0, 0]

  const res = await c.flows.updateOne(
    { _id: flow._id, enabled: false },
    { $set: { enabled: true, lastTriggerScanAt: watermark, updatedAt: now } },
  )
  if (res.modifiedCount === 0) {
    // Raced with another arm. Report the state rather than pretend.
    const again = await c.flows.findOne({ _id: flow._id })
    return {
      slug,
      version: flow.version,
      armed: false,
      alreadyEnabled: !!again?.enabled,
      watermark: again?.lastTriggerScanAt ?? null,
      eventName,
      skippedEvents: 0,
      pendingEvents: 0,
    }
  }

  await mailer.audit({
    actor: opts.actor,
    action: 'flow.arm',
    resource: { collection: 'mailer_flows', id: flow._id, slug },
    diffSummary:
      `Enabled v${flow.version} with lastTriggerScanAt=${watermark.toISOString()}` +
      ` (skipped ${skippedEvents} earlier ${eventName ?? 'trigger'} event(s), ${pendingEvents} pending)`,
  })

  return {
    slug,
    version: flow.version,
    armed: true,
    alreadyEnabled: false,
    watermark,
    eventName,
    skippedEvents,
    pendingEvents,
  }
}

/** The inverse: `enabled: false`. In-flight runs continue (that is what pause means). */
export async function disarmFlow(mailer: Mailer, slug: string, actor: string): Promise<{ slug: string; disarmed: boolean }> {
  const c = mailer.collections
  const flow = await c.flows.findOne({ slug })
  if (!flow) throw new FlowOperationError('not_found', `no flow with slug "${slug}"`, 404)
  if (!flow.enabled) return { slug, disarmed: false }
  await c.flows.updateOne({ _id: flow._id }, { $set: { enabled: false, updatedAt: new Date() } })
  await mailer.audit({
    actor,
    action: 'flow.pause',
    resource: { collection: 'mailer_flows', id: flow._id, slug },
    diffSummary: 'Disarmed (enabled: false); in-flight runs continue',
  })
  return { slug, disarmed: true }
}

// ---------------------------------------------------------------------------
// Canary gate
// ---------------------------------------------------------------------------

/**
 * The gate step. `canaryGate` is a marker the runner ignores (it evaluates
 * the condition like any other) and this module uses to recognise its own
 * work when removing it.
 */
export type CanaryGateStep = Extract<FlowStep, { type: 'condition' }> & { canaryGate: true }

export function isCanaryGate(step: unknown): step is CanaryGateStep {
  const s = step as Partial<CanaryGateStep> | null
  return !!s && s.type === 'condition' && (s as any).canaryGate === true
}

function gateStep(tag: string): CanaryGateStep {
  return { type: 'condition', test: { hasTag: tag }, ifFalse: 'exit', canaryGate: true }
}

async function publishVersion(
  mailer: Mailer,
  flow: FlowDoc,
  steps: FlowStep[],
  actor: string,
  summary: string,
): Promise<{ version: number }> {
  const c = mailer.collections
  const nextVersion = (flow.version ?? 0) + 1
  const now = new Date()
  await c.flowVersions.insertOne({
    flowId: flow._id!,
    version: nextVersion,
    steps,
    trigger: flow.trigger,
    publishedAt: now,
    publishedBy: actor,
  })
  // `enabled` is deliberately untouched: publishing a canary version is not
  // the same decision as turning the flow on. That is armFlow's job.
  await c.flows.updateOne(
    { _id: flow._id },
    { $set: { steps, version: nextVersion, draft: null, publishedAt: now, publishedBy: actor, updatedAt: now } },
  )
  await mailer.audit({
    actor,
    action: 'flow.publish',
    resource: { collection: 'mailer_flows', id: flow._id, slug: flow.slug },
    diffSummary: `Published v${nextVersion}: ${summary}`,
  })
  return { version: nextVersion }
}

export interface GateFlowResult {
  slug: string
  version: number
  tag: string
  enabled: boolean
}

export async function gateFlow(
  mailer: Mailer,
  slug: string,
  opts: { tag: string; actor: string },
): Promise<GateFlowResult> {
  const tag = String(opts.tag ?? '').trim()
  if (!tag) throw new FlowOperationError('tag_required', 'a canary tag is required')
  const flow = await mailer.collections.flows.findOne({ slug })
  if (!flow) throw new FlowOperationError('not_found', `no flow with slug "${slug}"`, 404)
  const live = Array.isArray(flow.steps) ? flow.steps : []
  if (live.length === 0) {
    throw new FlowOperationError('no_live_steps', `flow "${slug}" has no published steps to gate`, 409)
  }
  if (isCanaryGate(live[0])) {
    throw new FlowOperationError(
      'already_gated',
      `flow "${slug}" v${flow.version} is already gated on "${(live[0].test as { hasTag: string }).hasTag}" — ungate first`,
      409,
    )
  }
  // A flow written straight into mailer_flows (a deploy script, a seed) may
  // have no snapshot of its live version, and ungate restores from the
  // snapshots. Make sure the steps being gated can be found again.
  await mailer.collections.flowVersions.updateOne(
    { flowId: flow._id!, version: flow.version },
    {
      $setOnInsert: {
        flowId: flow._id!,
        version: flow.version,
        steps: live,
        trigger: flow.trigger,
        publishedAt: flow.publishedAt ?? flow.updatedAt ?? new Date(),
        publishedBy: flow.publishedBy ?? 'unknown',
      },
    },
    { upsert: true },
  )
  const { version } = await publishVersion(
    mailer,
    flow,
    [gateStep(tag), ...live],
    opts.actor,
    `canary gate on tag "${tag}"`,
  )
  return { slug, version, tag, enabled: flow.enabled }
}

export interface UngateFlowResult {
  slug: string
  version: number
  /** The version whose steps were restored. */
  restoredFrom: number
  enabled: boolean
}

export async function ungateFlow(mailer: Mailer, slug: string, opts: { actor: string }): Promise<UngateFlowResult> {
  const c = mailer.collections
  const flow = await c.flows.findOne({ slug })
  if (!flow) throw new FlowOperationError('not_found', `no flow with slug "${slug}"`, 404)
  const live = Array.isArray(flow.steps) ? flow.steps : []
  if (!isCanaryGate(live[0])) {
    throw new FlowOperationError('not_gated', `flow "${slug}" v${flow.version} is not gated`, 409)
  }
  const versions = await c.flowVersions.find({ flowId: flow._id! }).sort({ version: -1 }).toArray()
  const clean = versions.find((v) => Array.isArray(v.steps) && v.steps.length > 0 && !isCanaryGate(v.steps[0]))
  if (!clean) {
    throw new FlowOperationError(
      'no_ungated_version',
      `flow "${slug}" has no ungated version in mailer_flow_versions to restore`,
      409,
    )
  }
  const { version } = await publishVersion(
    mailer,
    flow,
    clean.steps,
    opts.actor,
    `restored steps of v${clean.version} (canary gate removed)`,
  )
  return { slug, version, restoredFrom: clean.version, enabled: flow.enabled }
}
