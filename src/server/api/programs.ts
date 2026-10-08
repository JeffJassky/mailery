/**
 * Programs routes (0.21), mounted at `/programs` on the admin JSON API and,
 * with the token's actor, on the agent router. One implementation so the two
 * surfaces cannot drift. plans/15-programs.md §5.13, §5.14.
 *
 * Audit (INVARIANT 10): the facade audits save-draft, publish, enable,
 * disable and abort; this router audits the two it does not — `enter` and
 * forced `tick`. Abort is audited by the facade, with the request's actor
 * (`mailer.abortProgram(..., { actor })`; `host` when called from host code).
 */

import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'

import type { Mailer } from '../mailer.js'
import { programDefinitionSchema } from '../../shared/schemas.js'
import type { ProgramDefinition } from '../../shared/types.js'
import type { ProgramDoc } from '../models/index.js'

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown
function h(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next)
  }
}

const ARMS = ['treatment', 'holdout'] as const
const RUN_STATUSES = ['active', 'completed', 'exited', 'sunset'] as const

/** Deep `skip` scans the index linearly; cap it. Narrow with `status` / `arm` to go further. */
const MAX_SKIP = 10_000
const MAX_SUBJECT_LEN = 256

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).max(MAX_SKIP).default(0),
})

const draftBodySchema = z.object({
  definition: z.unknown(),
  notes: z.string().max(2000).optional(),
})

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
}

/** Accept the definition itself, or `{ definition, notes }`. */
function unwrapDraft(body: unknown): { definition: unknown; notes?: string } {
  const b = (body ?? {}) as Record<string, unknown>
  if (b && typeof b === 'object' && 'definition' in b && !('actions' in b)) {
    const parsed = draftBodySchema.safeParse(b)
    if (parsed.success) return { definition: parsed.data.definition, notes: parsed.data.notes }
  }
  return { definition: body }
}

export function createProgramsRouter(mailer: Mailer): Router {
  const r = Router()
  const c = mailer.collections
  const actorOf = (req: Request): string => String((req as any).actor ?? 'unknown')

  async function loadProgram(req: Request, res: Response): Promise<ProgramDoc | null> {
    const doc = await c.programs.findOne({ slug: String(req.params.slug) })
    if (!doc) res.status(404).json({ error: 'not_found', message: `unknown program "${String(req.params.slug)}"` })
    return doc
  }

  function subjectTooLong(res: Response) {
    return res.status(400).json({ error: 'validation_failed', message: `subjectId must be at most ${MAX_SUBJECT_LEN} characters` })
  }

  function parsePage(req: Request, res: Response): { limit: number; skip: number } | null {
    const p = pageSchema.safeParse(req.query)
    if (!p.success) {
      res.status(400).json({ error: 'validation_failed', message: zodMessage(p.error) })
      return null
    }
    return p.data
  }

  // ----- List ------------------------------------------------------------------
  r.get(
    '/',
    h(async (_req, res) => {
      const [docs, counts] = await Promise.all([
        c.programs.find().sort({ slug: 1 }).toArray(),
        c.programRuns
          .aggregate<{ _id: { slug: string; status: string }; n: number }>([
            { $group: { _id: { slug: '$programSlug', status: '$status' }, n: { $sum: 1 } } },
          ])
          .toArray(),
      ])
      const bySlug = new Map<string, Record<string, number>>()
      for (const row of counts) {
        const m = bySlug.get(row._id.slug) ?? {}
        m[row._id.status] = row.n
        bySlug.set(row._id.slug, m)
      }
      res.json(
        docs.map((d) => {
          const runs = Object.fromEntries(RUN_STATUSES.map((s) => [s, bySlug.get(d.slug)?.[s] ?? 0]))
          return {
            slug: d.slug,
            name: d.definition?.name ?? d.draft?.definition.name ?? d.slug,
            version: d.version,
            enabled: d.enabled,
            draft: !!d.draft,
            category: d.definition?.category ?? d.draft?.definition.category ?? null,
            publishedAt: d.publishedAt,
            runs: { ...runs, total: Object.values(runs).reduce((a, b) => a + b, 0) },
          }
        }),
      )
    }),
  )

  // ----- Save draft ------------------------------------------------------------
  r.post(
    '/',
    h(async (req, res) => {
      const { definition, notes } = unwrapDraft(req.body)
      const parsed = programDefinitionSchema.safeParse(definition)
      if (!parsed.success) return res.status(400).json({ error: 'validation_failed', message: zodMessage(parsed.error) })
      const existed = !!(await c.programs.findOne({ slug: parsed.data.slug }, { projection: { _id: 1 } }))
      const doc = await mailer.saveProgramDraft(parsed.data as ProgramDefinition, { actor: actorOf(req), notes })
      res.status(existed ? 200 : 201).json({ ok: true, slug: doc.slug, version: doc.version, created: !existed })
    }),
  )

  r.patch(
    '/:slug',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      const { definition, notes } = unwrapDraft(req.body)
      const withSlug =
        definition && typeof definition === 'object' && !Array.isArray(definition)
          ? { slug: doc.slug, ...(definition as Record<string, unknown>) }
          : definition
      const parsed = programDefinitionSchema.safeParse(withSlug)
      if (!parsed.success) return res.status(400).json({ error: 'validation_failed', message: zodMessage(parsed.error) })
      if (parsed.data.slug !== doc.slug) {
        return res.status(400).json({ error: 'validation_failed', message: `slug in the body ("${parsed.data.slug}") must match the path ("${doc.slug}")` })
      }
      await mailer.saveProgramDraft(parsed.data as ProgramDefinition, { actor: actorOf(req), notes })
      res.json({ ok: true, slug: doc.slug })
    }),
  )

  // ----- Publish / enable / disable -------------------------------------------
  r.post(
    '/:slug/publish',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      const result = await mailer.publishProgram(doc.slug, { actor: actorOf(req) })
      if (!result.ok) {
        return res.status(422).json({ error: 'validation_failed', message: 'the draft did not pass publish validation', issues: result.issues })
      }
      res.json({ ok: true, version: result.version })
    }),
  )

  r.post(
    '/:slug/enable',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      if (!doc.definition || doc.version < 1) {
        return res.status(409).json({ error: 'not_published', message: `program "${doc.slug}" has never been published` })
      }
      if (!mailer.config.factsAdapter) {
        return res.status(409).json({ error: 'facts_adapter_required', message: 'programs require MailerConfig.factsAdapter' })
      }
      await mailer.setProgramEnabled(doc.slug, true, { actor: actorOf(req) })
      res.json({ ok: true, enabled: true })
    }),
  )

  r.post(
    '/:slug/disable',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      await mailer.setProgramEnabled(doc.slug, false, { actor: actorOf(req) })
      res.json({ ok: true, enabled: false })
    }),
  )

  // ----- Detail ----------------------------------------------------------------
  r.get(
    '/:slug',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      const versions = await c.programVersions
        .find({ programId: doc._id! }, { projection: { version: 1, publishedAt: 1, publishedBy: 1 } })
        .sort({ version: -1 })
        .toArray()
      res.json({
        slug: doc.slug,
        version: doc.version,
        enabled: doc.enabled,
        published: doc.definition,
        publishedAt: doc.publishedAt,
        publishedBy: doc.publishedBy,
        draft: doc.draft,
        versions: versions.map((v) => ({ version: v.version, publishedAt: v.publishedAt, publishedBy: v.publishedBy })),
      })
    }),
  )

  // ----- Runs ------------------------------------------------------------------
  r.get(
    '/:slug/runs',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      const page = parsePage(req, res)
      if (!page) return
      const filter: Record<string, unknown> = { programSlug: doc.slug }
      if (req.query.status !== undefined) {
        if (!(RUN_STATUSES as readonly string[]).includes(String(req.query.status))) {
          return res.status(400).json({ error: 'validation_failed', message: `status must be one of ${RUN_STATUSES.join(', ')}` })
        }
        filter.status = String(req.query.status)
      }
      if (req.query.arm !== undefined) {
        if (!(ARMS as readonly string[]).includes(String(req.query.arm))) {
          return res.status(400).json({ error: 'validation_failed', message: `arm must be one of ${ARMS.join(', ')}` })
        }
        filter.arm = String(req.query.arm)
      }
      const [runs, total] = await Promise.all([
        c.programRuns.find(filter).sort({ enteredAt: -1, _id: -1 }).skip(page.skip).limit(page.limit).toArray(),
        c.programRuns.countDocuments(filter),
      ])
      res.json({ runs, total, limit: page.limit, skip: page.skip })
    }),
  )

  r.get(
    '/:slug/runs/:subjectId',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      if (String(req.params.subjectId).length > MAX_SUBJECT_LEN) return subjectTooLong(res)
      const page = parsePage(req, res)
      if (!page) return
      const run = await c.programRuns.findOne({ programSlug: doc.slug, subjectId: String(req.params.subjectId) })
      if (!run) return res.status(404).json({ error: 'run_not_found', message: `no run for subject "${String(req.params.subjectId)}"` })
      const [decisions, total] = await Promise.all([
        c.programDecisions.find({ runId: run._id! }).sort({ at: -1, _id: -1 }).skip(page.skip).limit(page.limit).toArray(),
        c.programDecisions.countDocuments({ runId: run._id! }),
      ])
      res.json({ run, decisions, total, limit: page.limit, skip: page.skip })
    }),
  )

  // ----- State (checklist) -----------------------------------------------------
  r.get(
    '/:slug/state',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      const subject = typeof req.query.subject === 'string' ? req.query.subject : ''
      if (!subject || subject.length > MAX_SUBJECT_LEN) {
        return res.status(400).json({ error: 'validation_failed', message: `subject (query, 1-${MAX_SUBJECT_LEN} chars) is required` })
      }
      const state = await mailer.getProgramState(doc.slug, subject)
      if (!state) return res.status(404).json({ error: 'run_not_found', message: `no run for subject "${subject}"` })
      res.json(state)
    }),
  )

  // ----- Stats -----------------------------------------------------------------
  r.get(
    '/:slug/stats',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      res.json(await computeProgramStats(mailer, doc))
    }),
  )

  // ----- Operator actions ------------------------------------------------------
  r.post(
    '/:slug/runs/:subjectId/tick',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      const subjectId = String(req.params.subjectId)
      if (subjectId.length > MAX_SUBJECT_LEN) return subjectTooLong(res)
      const run = await c.programRuns.findOne({ programSlug: doc.slug, subjectId }, { projection: { _id: 1 } })
      if (!run) return res.status(404).json({ error: 'run_not_found', message: `no run for subject "${subjectId}"` })
      const result = await mailer.tickProgram(doc.slug, subjectId)
      await mailer.audit({
        actor: actorOf(req),
        action: 'program.force_tick',
        resource: { collection: 'mailer_program_runs', id: run._id, slug: doc.slug },
        diffSummary: `subject ${subjectId}: ${result.status}`,
      })
      res.json({ ok: true, result })
    }),
  )

  r.post(
    '/:slug/runs/:subjectId/abort',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      const subjectId = String(req.params.subjectId)
      if (subjectId.length > MAX_SUBJECT_LEN) return subjectTooLong(res)
      const run = await c.programRuns.findOne({ programSlug: doc.slug, subjectId }, { projection: { _id: 1 } })
      if (!run) return res.status(404).json({ error: 'run_not_found', message: `no run for subject "${subjectId}"` })
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : `aborted by ${actorOf(req)}`
      const out = await mailer.abortProgram(doc.slug, subjectId, { reason, actor: actorOf(req) })
      res.json({ ok: true, ...out })
    }),
  )

  r.post(
    '/:slug/enter',
    h(async (req, res) => {
      const doc = await loadProgram(req, res)
      if (!doc) return
      const subjectId = typeof req.body?.subjectId === 'string' ? req.body.subjectId.trim() : ''
      if (!subjectId || subjectId.length > 256) {
        return res.status(400).json({ error: 'validation_failed', message: 'subjectId (non-empty string) is required' })
      }
      if (!doc.definition) {
        return res.status(409).json({ error: 'not_published', message: `program "${doc.slug}" has never been published` })
      }
      const out = await mailer.enterProgram(doc.slug, subjectId)
      await mailer.audit({
        actor: actorOf(req),
        action: 'program.enter',
        resource: { collection: 'mailer_program_runs', slug: doc.slug },
        diffSummary: `subject ${subjectId}: ${out.created ? 'entered' : 'already had a run'}`,
      })
      res.status(out.created ? 201 : 200).json({ ok: true, ...out })
    }),
  )

  return r
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface ProgramArmFunnel {
  evaluated: number
  chosen: number
  sent: number
  satisfied: number
}

export interface ProgramStats {
  slug: string
  version: number
  actions: Array<{ actionId: string; title: string | null; treatment: ProgramArmFunnel; holdout: ProgramArmFunnel }>
  runs: Record<
    (typeof ARMS)[number],
    { total: number; byStatus: Record<string, number>; completed: number; completionRate: number | null }
  >
}

const emptyFunnel = (): ProgramArmFunnel => ({ evaluated: 0, chosen: 0, sent: 0, satisfied: 0 })

/**
 * Per action × arm funnel. `evaluated` = decisions that listed the action as
 * an unblocked candidate; `chosen` = decisions that picked it and went on to send (silent ticks such as min-gap keep `chosen` on the row but are not counted); `sent` =
 * treatment sends with status sent|delivered, or holdout rows (the simulated
 * send) per action; `satisfied` = runs with `actions.<id>.completedAt`.
 */
export async function computeProgramStats(mailer: Mailer, doc: ProgramDoc): Promise<ProgramStats> {
  const c = mailer.collections
  const slug = doc.slug
  const rows = new Map<string, { treatment: ProgramArmFunnel; holdout: ProgramArmFunnel }>()
  const row = (id: string) => {
    let v = rows.get(id)
    if (!v) rows.set(id, (v = { treatment: emptyFunnel(), holdout: emptyFunnel() }))
    return v
  }
  const titles = new Map<string, string>()
  const defs = [doc.definition, doc.draft?.definition].filter(Boolean) as ProgramDefinition[]
  for (const d of defs) for (const a of d.actions) { row(a.id); if (!titles.has(a.id)) titles.set(a.id, a.title) }

  const [evaluated, chosen, sends, runArms, runStatus] = await Promise.all([
    c.programDecisions
      .aggregate<{ _id: { id: string; arm: string }; n: number }>([
        { $match: { programSlug: slug } },
        { $unwind: '$candidates' },
        { $match: { 'candidates.blockedBy': null } },
        { $group: { _id: { id: '$candidates.actionId', arm: '$arm' }, n: { $sum: 1 } } },
      ])
      .toArray(),
    c.programDecisions
      .aggregate<{ _id: { id: string; arm: string }; n: number }>([
        { $match: { programSlug: slug, chosen: { $ne: null }, reason: { $in: ['highest-rank', 'holdout', 'sunset'] } } },
        { $group: { _id: { id: '$chosen', arm: '$arm' }, n: { $sum: 1 } } },
      ])
      .toArray(),
    c.sends
      .aggregate<{ _id: { id: string; holdout: boolean }; n: number }>([
        {
          $match: {
            'program.slug': slug,
            $or: [{ 'program.holdout': true }, { status: { $in: ['sent', 'delivered'] } }],
          },
        },
        { $group: { _id: { id: '$program.actionId', holdout: { $eq: ['$program.holdout', true] } }, n: { $sum: 1 } } },
      ])
      .toArray(),
    c.programRuns
      .aggregate<{ _id: string; n: number }>([{ $match: { programSlug: slug } }, { $group: { _id: '$arm', n: { $sum: 1 } } }])
      .toArray(),
    c.programRuns
      .aggregate<{ _id: { arm: string; status: string }; n: number }>([
        { $match: { programSlug: slug } },
        { $group: { _id: { arm: '$arm', status: '$status' }, n: { $sum: 1 } } },
      ])
      .toArray(),
  ])

  for (const e of evaluated) row(e._id.id)[e._id.arm as 'treatment' | 'holdout'].evaluated += e.n
  for (const e of chosen) row(e._id.id)[e._id.arm as 'treatment' | 'holdout'].chosen += e.n
  for (const s of sends) if (s._id.id) row(s._id.id)[s._id.holdout ? 'holdout' : 'treatment'].sent += s.n

  // One bounded pass over this program's runs (served by { programSlug, ... }) instead of
  // a countDocuments per action x arm. Only the completedAt flag of each action is read.
  const known = new Set(rows.keys())
  const cursor = c.programRuns.find(
    { programSlug: slug },
    { projection: { arm: 1, actions: 1 } },
  )
  for await (const run of cursor) {
    const arm = run.arm as 'treatment' | 'holdout'
    if (arm !== 'treatment' && arm !== 'holdout') continue
    for (const [id, st] of Object.entries(run.actions ?? {})) {
      if (known.has(id) && (st as any)?.completedAt) row(id)[arm].satisfied += 1
    }
  }

  const runs = {} as ProgramStats['runs']
  for (const arm of ARMS) {
    const total = runArms.find((x) => x._id === arm)?.n ?? 0
    const byStatus: Record<string, number> = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0]))
    for (const x of runStatus) if (x._id.arm === arm) byStatus[x._id.status] = x.n
    const completed = byStatus.completed ?? 0
    runs[arm] = { total, byStatus, completed, completionRate: total > 0 ? completed / total : null }
  }

  return {
    slug,
    version: doc.version,
    actions: [...rows.entries()].map(([actionId, v]) => ({ actionId, title: titles.get(actionId) ?? null, ...v })),
    runs,
  }
}

