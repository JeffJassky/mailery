/**
 * Shared setup for the Programs suites (0.21).
 *
 * One harness per file (a mongod each); every test makes its own subject with
 * `subject()` so tests never share run state. The clock is frozen per test
 * (`freezeAt`) and restored in `afterEach`.
 */

import type { ObjectId } from 'mongodb'

import {
  buildProgram,
  createTestMailer,
  dispatchQueued,
  MemoryFactsAdapter,
  type ProgramSpec,
  type TestMailerHarness,
} from '../../src/testing/index.js'
import { referencedTemplateSlugs } from '../../src/server/programs/validate.js'
import { enterProgram } from '../../src/server/runner/programs/index.js'
import type { MailerConfig } from '../../src/server/config.js'
import type { Contact, Facts, ProgramDefinition } from '../../src/shared/types.js'
import { DAY, freezeAt } from '../matrix/clock.js'

/**
 * Freeze the clock at the next "test epoch": a Monday 15:00 UTC, nine weeks
 * after the previous one and after the real clock. Strictly increasing on
 * purpose — the entry and Facts Changed scans keep watermarks, so a test that
 * froze the clock *earlier* than the last scan would never see its events.
 */
let epoch = Date.parse('2027-01-04T15:00:00Z') // a Monday
export function startClock(): Date {
  while (epoch <= Date.now()) epoch += 63 * DAY
  const at = new Date(epoch)
  epoch += 63 * DAY
  return freezeAt(at)
}

export const CATEGORY = 'lifecycle.onboarding'

export const DECLARE = {
  shopify_connected: { type: 'boolean' },
  ga4_connected: { type: 'boolean' },
  agent_connected: { type: 'boolean' },
  business_type: { type: 'enum', values: ['ecommerce', 'saas', 'local', 'agency'] },
  playbooks_run: { type: 'number' },
  last_session_at: { type: 'date' },
  timezone: { type: 'string' },
} as const

export interface ProgramHarness {
  H: TestMailerHarness
  facts: MemoryFactsAdapter
}

export async function programHarness(config: Partial<MailerConfig> = {}): Promise<ProgramHarness> {
  const facts = new MemoryFactsAdapter({ declare: { ...DECLARE } as any })
  const H = await createTestMailer({
    config: {
      categories: [
        { id: CATEGORY, label: 'Getting-started tips' },
        { id: 'product.updates', label: 'Product updates' },
      ],
      factsAdapter: facts,
      ...config,
    },
  })
  return { H, facts }
}

/** The activation program most suites use. */
export function activation(over: Partial<ProgramSpec> = {}): ProgramDefinition {
  return buildProgram({
    slug: 'activation',
    exit: { eventNames: ['Upgraded'], onComplete: { fireEvent: 'Activated' } },
    actions: [
      {
        id: 'connect-shopify',
        title: 'Connect Shopify',
        cta: { label: 'Connect', url: 'https://app.example.com/connect/shopify' },
        priority: 100,
        attempts: 3,
        eligible: { fact: 'business_type', equals: 'ecommerce' },
        satisfied: { fact: 'shopify_connected' },
      },
      { id: 'connect-ga4', title: 'Connect GA4', priority: 90, attempts: 2, satisfied: { fact: 'ga4_connected' } },
      { id: 'install-agent', title: 'Install the agent', priority: 80, attempts: 2, satisfied: { fact: 'agent_connected' } },
      {
        id: 'run-playbook',
        title: 'Run a playbook',
        priority: 50,
        attempts: 1,
        requires: ['install-agent'],
        satisfied: { fact: 'playbooks_run', gte: 1 },
      },
    ],
    ...over,
  })
}

/** Seed every template the program references (marketing, program category), then the program. */
export async function seedProgramWithTemplates(
  H: TestMailerHarness,
  def: ProgramDefinition,
  opts: { enabled?: boolean } = {},
): Promise<void> {
  for (const slug of referencedTemplateSlugs(def)) {
    if (await H.mailer.collections.templates.findOne({ slug })) continue
    await H.seedTemplate({
      slug,
      kind: 'marketing',
      category: def.category,
      subject: `${slug}: {{action.title}} {{attempt.n}}/{{attempt.total}}`,
      text: `${slug} {{action.cta.url}}`,
    })
  }
  await H.seedProgram(def, opts)
}

let seq = 0

/** A fresh account with one owner contact, subscribed, with initial facts. */
export async function subject(
  P: ProgramHarness,
  initial: Facts = {},
  opts: { owners?: number } = {},
): Promise<{ subjectId: string; owners: Contact[] }> {
  seq++
  const subjectId = `acct-${seq}`
  const owners: Contact[] = []
  for (let i = 0; i < (opts.owners ?? 1); i++) {
    const c: Contact = { externalId: `owner-${seq}-${i}`, email: `owner-${seq}-${i}@example.com`, tags: [], fields: {} }
    await P.H.seedContact(c)
    owners.push(c)
  }
  P.facts.setSubject(subjectId, {
    facts: { business_type: 'ecommerce', shopify_connected: false, ga4_connected: false, agent_connected: false, playbooks_run: 0, ...initial },
    recipients: owners,
  })
  return { subjectId, owners }
}

export async function enter(P: ProgramHarness, slug: string, subjectId: string): Promise<ObjectId> {
  const { runId } = await enterProgram(P.H.ctx, slug, subjectId)
  return runId
}

export function getRun(P: ProgramHarness, slug: string, subjectId: string) {
  return P.H.mailer.collections.programRuns.findOne({ programSlug: slug, subjectId })
}

export function decisionsFor(P: ProgramHarness, slug: string, subjectId: string) {
  return P.H.mailer.collections.programDecisions.find({ programSlug: slug, subjectId }).sort({ at: 1, _id: 1 }).toArray()
}

export async function lastDecision(P: ProgramHarness, slug: string, subjectId: string) {
  const all = await decisionsFor(P, slug, subjectId)
  return all.at(-1) ?? null
}

export function programSends(P: ProgramHarness, subjectId: string) {
  return P.H.mailer.collections.sends.find({ 'program.subjectId': subjectId }).sort({ queuedAt: 1, _id: 1 }).toArray()
}

/** Provider calls addressed to any of a subject's owners. */
export function delivered(P: ProgramHarness, owners: Contact[]) {
  const emails = new Set(owners.map((o) => o.email))
  return P.H.provider.sent.filter((s) => emails.has(s.to))
}

export async function dispatch(P: ProgramHarness): Promise<void> {
  await dispatchQueued(P.H.ctx)
}
