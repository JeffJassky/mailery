/**
 * Program scheduler (§5.4 "Triggered by"): one pass does the entry scan, the
 * Facts Changed scan, then ticks due runs. Concurrency safety lives in the
 * per-run lease and the unique (programSlug, subjectId) index, so any number
 * of passes can run at once.
 */

import type { Filter, ObjectId } from 'mongodb'

import { PROGRAMS_DEFAULTS } from '../../config.js'
import type { EventDoc, ProgramDoc } from '../../models/index.js'
import type { RunnerContext } from '../index.js'
import { DAY_MS, ERROR_BACKOFF_MS, FACTS_CHANGED_EVENT, SCAN_OVERLAP_MS } from './common.js'
import { enterProgram } from './entry.js'
import { tickProgramRun } from './tick.js'
import type { ProgramSchedulerResult, ProgramTickTrigger } from './index.js'

const SCAN_BATCH = 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000
const lastPrune = new WeakMap<object, number>()

export async function runProgramSchedulerPass(ctx: RunnerContext, now: Date): Promise<ProgramSchedulerResult> {
  const C = ctx.collections
  const programs = await C.programs.find({ enabled: true, version: { $gt: 0 }, definition: { $ne: null } }).toArray()
  const result: ProgramSchedulerResult = { entered: 0, woken: 0, ticked: 0 }
  /** Why each run is being ticked this pass; absent → 'schedule'. */
  const triggers = new Map<string, ProgramTickTrigger>()

  for (const program of programs) {
    const woken = await scanFactsChanged(ctx, program, now)
    result.woken += woken.size
    for (const id of woken) triggers.set(id, 'facts_changed')
    const entered = await scanEntry(ctx, program, now)
    result.entered += entered.size
    for (const id of entered) triggers.set(id, 'entry') // entry wins over a wake
  }

  const slugs = programs.map((p) => p.slug)
  const due = await C.programRuns
    .find({ programSlug: { $in: slugs }, status: { $in: ['active', 'sunset'] }, nextTickAt: { $lte: now } })
    .sort({ nextTickAt: 1 })
    .limit(ctx.config.programs?.batchSize ?? PROGRAMS_DEFAULTS.batchSize)
    .project({ _id: 1 })
    .toArray()

  for (const row of due) {
    const runId = row._id as ObjectId
    // A parallel pass may have ticked it since the query: only tick what is still due.
    const stillDue = await C.programRuns.findOne({ _id: runId, nextTickAt: { $lte: new Date() } }, { projection: { _id: 1 } })
    if (!stillDue) continue
    try {
      const res = await tickProgramRun(ctx, runId, { trigger: triggers.get(String(runId)) ?? 'schedule' })
      if (res.status === 'ticked') result.ticked++
    } catch (err) {
      console.error(`mailery: program tick failed for run ${String(runId)}`, err)
      // Don't hot-loop on a run whose host adapter or template is broken.
      await C.programRuns
        .updateOne(
          { _id: runId, nextTickAt: { $lte: new Date() } },
          { $set: { nextTickAt: new Date(Date.now() + ERROR_BACKOFF_MS) } },
        )
        .catch(() => {})
    }
  }

  await pruneDecisions(ctx, now).catch((err) => console.error('mailery: program decision prune failed', err))
  return result
}

/**
 * Page through the events named `name` created since the watermark (less the
 * overlap), in `(createdAt, _id)` order, by keyset — never by re-reading the
 * same first page. `handle` runs once per event; the watermark is saved after
 * each page, so a burst larger than a page (or a crash) still makes progress.
 * Re-reading the overlap on the next pass is harmless: both handlers are
 * idempotent.
 */
async function scanEvents(
  ctx: RunnerContext,
  program: ProgramDoc,
  name: string,
  watermark: 'lastEntryScanAt' | 'lastFactsScanAt',
  handle: (ev: EventDoc) => Promise<void>,
): Promise<void> {
  const since = program[watermark] ?? program.createdAt
  const start = new Date(since.getTime() - SCAN_OVERLAP_MS)
  let saved = since.getTime()
  let cursor: { at: Date; id: ObjectId | null } = { at: start, id: null }
  for (;;) {
    const after: Filter<EventDoc> =
      cursor.id === null
        ? { createdAt: { $gt: cursor.at } }
        : { $or: [{ createdAt: { $gt: cursor.at } }, { createdAt: cursor.at, _id: { $gt: cursor.id } }] }
    const events = await ctx.collections.events
      .find({ name, ...after })
      .sort({ createdAt: 1, _id: 1 })
      .limit(SCAN_BATCH)
      .toArray()
    if (events.length === 0) return
    for (const ev of events) await handle(ev)
    const last = events[events.length - 1]!
    cursor = { at: last.createdAt, id: last._id as ObjectId }
    if (last.createdAt.getTime() > saved) {
      saved = last.createdAt.getTime()
      await ctx.collections.programs.updateOne({ _id: program._id }, { $set: { [watermark]: last.createdAt } })
    }
    if (events.length < SCAN_BATCH) return
  }
}

/** Entry events since the watermark → runs. Returns the run ids created now. */
async function scanEntry(ctx: RunnerContext, program: ProgramDoc, now: Date): Promise<Set<string>> {
  const entered = new Set<string>()
  const def = program.definition
  if (!def) return entered
  await scanEvents(ctx, program, def.entry.eventName, 'lastEntryScanAt', async (ev) => {
    const res = await enterProgram(ctx, program.slug, ev.externalId, { now, entryEventAt: ev.occurredAt })
    if (res.created) entered.add(String(res.runId))
  })
  return entered
}

/**
 * Facts Changed events since the watermark → wake the subject's run
 * (`nextTickAt = now`). A run whose last write is not older than the event has
 * already seen the change, so re-reading the overlap window wakes nothing twice.
 */
async function scanFactsChanged(ctx: RunnerContext, program: ProgramDoc, now: Date): Promise<Set<string>> {
  const woken = new Set<string>()
  await scanEvents(ctx, program, FACTS_CHANGED_EVENT, 'lastFactsScanAt', async (ev) => {
    const run = await ctx.collections.programRuns.findOneAndUpdate(
      {
        programSlug: program.slug,
        subjectId: ev.externalId,
        status: { $in: ['active', 'sunset'] },
        updatedAt: { $lt: ev.createdAt },
      },
      // $min: a due or leased run keeps its (earlier) time; a sleeping one wakes now.
      // wakeRequestedAt lets a tick already in progress notice the wake.
      { $min: { nextTickAt: now }, $set: { updatedAt: now, wakeRequestedAt: ev.createdAt } },
      { projection: { _id: 1 } },
    )
    if (run) woken.add(String(run._id))
  })
  return woken
}

/** `programs.decisionRetentionDays`: drop older decision rows, at most hourly. */
async function pruneDecisions(ctx: RunnerContext, now: Date): Promise<void> {
  const days = ctx.config.programs?.decisionRetentionDays ?? PROGRAMS_DEFAULTS.decisionRetentionDays
  if (!days || days <= 0) return
  const key = ctx.collections.programDecisions
  const last = lastPrune.get(key)
  if (last !== undefined && now.getTime() - last < PRUNE_EVERY_MS) return
  lastPrune.set(key, now.getTime())
  await ctx.collections.programDecisions.deleteMany({ at: { $lt: new Date(now.getTime() - days * DAY_MS) } })
}
