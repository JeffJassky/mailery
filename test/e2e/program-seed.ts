/**
 * Program-board fixtures for the e2e harness (`MAILERY_E2E_PROGRAM=1`).
 *
 * An "activation" program shaped like a real one — seven actions, a sunset ask,
 * a delivery window, a holdout — with a few accounts in different states, a
 * draft that differs from the published version, and two things for lint to
 * report (an unpublished template, an action without a CTA). The runs are real:
 * they come from `enterProgram`, `tickProgram` and `dispatchQueued`, not from
 * hand-written documents (apart from backdating one run's last send so a second
 * email can go out without waiting three days).
 */

import type { Mailer } from '../../src/server/index.js'
import { computeDeliveryTime } from '../../src/server/runner/delivery-window.js'
import { enterProgram } from '../../src/server/runner/programs/index.js'
import { buildProgram, buildTemplate, dispatchQueued, MemoryFactsAdapter, tickProgram } from '../../src/testing/index.js'
import type { MemoryContactAdapter } from '../../src/testing/memory-adapter.js'
import type { Contact, DeliveryWindow, Facts, ProgramAction, ProgramDefinition } from '../../src/shared/types.js'

export const BOARD_CATEGORY = 'lifecycle.onboarding'
export const BOARD_CATEGORIES = [{ id: BOARD_CATEGORY, label: 'Getting started' }]

const DAY = 24 * 60 * 60 * 1000
const WINDOW: DeliveryWindow = { weekdaysOnly: true, timeOfDay: '10:00', timezone: 'America/New_York' }

export function createFactsAdapter(): MemoryFactsAdapter {
  return new MemoryFactsAdapter({
    declare: {
      business_type: { type: 'enum', values: ['ecommerce', 'saas', 'local', 'agency'] },
      sells_products_online: { type: 'boolean' },
      access_lapsed: { type: 'boolean' },
      shopify_connected: { type: 'boolean' },
      ga4_connected: { type: 'boolean' },
      search_console_connected: { type: 'boolean' },
      business_context_set: { type: 'boolean' },
      agent_connected: { type: 'boolean' },
      playbooks_run: { type: 'number' },
      last_session_at: { type: 'date' },
      timezone: { type: 'string' },
    },
  })
}

interface TemplateSeed {
  slug: string
  subject: string
  published?: boolean
}

/** Subject lines per action, in ladder order: ask, remind, last call. */
const LADDERS: Array<{ id: string; title: string; cta?: { label: string; url: string }; subjects: string[] }> = [
  {
    id: 'connect-shopify',
    title: 'Connect Shopify',
    cta: { label: 'Connect Shopify', url: 'https://app.example.com/connect/shopify' },
    subjects: ['Connect your Shopify store to get started', 'Your store is one click from connected', 'Last call: connect Shopify'],
  },
  {
    id: 'connect-google-analytics',
    title: 'Connect Google Analytics',
    cta: { label: 'Connect Google Analytics', url: 'https://app.example.com/connect/ga4' },
    subjects: ['See what is working: connect Google Analytics', 'Google Analytics is still not connected', 'Quick reminder: Google Analytics'],
  },
  {
    id: 'connect-search-console',
    title: 'Connect Search Console',
    cta: { label: 'Connect Search Console', url: 'https://app.example.com/connect/gsc' },
    subjects: ['Know which searches bring people in', 'Search Console takes about a minute'],
  },
  {
    id: 'add-business-context',
    title: 'Add your business context',
    cta: { label: 'Add context', url: 'https://app.example.com/settings/business' },
    subjects: ['Tell us about your business', 'Better answers start with your business context'],
  },
  {
    id: 'install-agent',
    title: 'Install the agent',
    cta: { label: 'Install the agent', url: 'https://app.example.com/agent' },
    subjects: ['Put the marketing agent to work', 'The agent is ready when you are'],
  },
  {
    id: 'run-playbook-seo',
    title: 'Run the SEO playbook',
    cta: { label: 'Run the playbook', url: 'https://app.example.com/playbooks/seo' },
    subjects: ['Run your first SEO playbook', 'Your SEO playbook is waiting'],
  },
  {
    // No CTA on purpose: lint reports it.
    id: 'run-playbook-ads',
    title: 'Run the ads playbook',
    subjects: ['Run your first ads playbook', 'Your ads playbook is waiting'],
  },
]

const ASK: TemplateSeed = { slug: 'activation-still-want-these', subject: 'Still want these emails?' }
/** One template is left without a published body so lint has a warning to show. */
const UNPUBLISHED_SLUG = 'connect-search-console-2'
/** Used only by the draft. */
const DRAFT_SWAP: TemplateSeed = { slug: 'add-business-context-2b', subject: 'Two minutes to better recommendations' }

function templateSeeds(): TemplateSeed[] {
  const out: TemplateSeed[] = []
  for (const l of LADDERS) l.subjects.forEach((subject, i) => out.push({ slug: `${l.id}-${i + 1}`, subject }))
  out.push(ASK, DRAFT_SWAP)
  return out
}

function action(l: (typeof LADDERS)[number], rest: Partial<ProgramAction> & { satisfied: ProgramAction['satisfied']; priority: number }): ProgramAction {
  return {
    id: l.id,
    version: 1,
    title: l.title,
    ...(l.cta ? { cta: l.cta } : {}),
    onExhaust: 'skip',
    attempts: l.subjects.map((_s, i) => ({ deliveries: [{ channel: 'email' as const, templateSlug: `${l.id}-${i + 1}` }] })),
    ...rest,
  }
}

function activationDefinition(): ProgramDefinition {
  const by = Object.fromEntries(LADDERS.map((l) => [l.id, l])) as Record<string, (typeof LADDERS)[number]>
  return buildProgram({
    slug: 'activation',
    name: 'Activation',
    description: 'Gets a new account connected and running its first playbook.',
    category: BOARD_CATEGORY,
    entry: { eventName: 'Created' },
    exit: { eventNames: ['Upgraded'], onComplete: { fireEvent: 'Activated' } },
    holdoutPct: 10,
    policy: {
      minGapDays: 3,
      delivery: WINDOW,
      suppressIfSessionWithinHours: 12,
      sunset: { slowAfter: 3, slowFactor: 2, askAfter: 6, askTemplateSlug: ASK.slug },
    },
    actions: [
      action(by['connect-shopify']!, {
        priority: 100,
        eligible: {
          all: [
            { fact: 'access_lapsed', equals: false },
            { any: [{ not: { fact: 'business_type', exists: true } }, { fact: 'sells_products_online', equals: true }] },
          ],
        },
        satisfied: { fact: 'shopify_connected' },
      }),
      action(by['connect-google-analytics']!, { priority: 90, satisfied: { fact: 'ga4_connected' } }),
      action(by['connect-search-console']!, { priority: 80, satisfied: { fact: 'search_console_connected' } }),
      action(by['add-business-context']!, { priority: 70, satisfied: { fact: 'business_context_set' } }),
      action(by['install-agent']!, { priority: 60, cooldownDays: 30, satisfied: { fact: 'agent_connected' } }),
      action(by['run-playbook-seo']!, { priority: 50, requires: ['install-agent'], satisfied: { fact: 'playbooks_run', gte: 1 } }),
      action(by['run-playbook-ads']!, { priority: 40, requires: ['install-agent'], satisfied: { fact: 'playbooks_run', gte: 2 } }),
    ],
  })
}

/** The draft: search console jumps above analytics, and one reminder uses a different template. */
function draftDefinition(published: ProgramDefinition): ProgramDefinition {
  const draft: ProgramDefinition = JSON.parse(JSON.stringify(published))
  draft.actions.find((a) => a.id === 'connect-search-console')!.priority = 95
  draft.actions.find((a) => a.id === 'add-business-context')!.attempts[1]!.deliveries[0]!.templateSlug = DRAFT_SWAP.slug
  return draft
}

async function seedTemplates(mailer: Mailer): Promise<void> {
  for (const t of templateSeeds()) {
    const doc = await buildTemplate({
      slug: t.slug,
      name: t.subject,
      kind: 'marketing',
      category: BOARD_CATEGORY,
      subject: t.subject,
      text: `<p>Hi there,</p><p>{{action.title}}.</p>{{#if action.cta}}<p><a href="{{action.cta.url}}">{{action.cta.label}}</a></p>{{/if}}`,
    })
    if (t.slug === UNPUBLISHED_SLUG) {
      doc.body = { mjml: '', editorJson: null, html: '', plainText: '', compiledAt: null }
      doc.publishedAt = null
      doc.publishedBy = null
    }
    await mailer.collections.templates.insertOne(doc)
  }
}

interface SubjectSeed {
  id: string
  facts: Facts
}

async function addSubject(mailer: Mailer, adapter: MemoryContactAdapter, facts: MemoryFactsAdapter, s: SubjectSeed): Promise<void> {
  const owner: Contact = { externalId: `owner-${s.id}`, email: `owner-${s.id}@example.com`, tags: [], fields: { firstName: 'Alex' } }
  adapter.upsert(owner)
  await mailer.upsertSubscription({ externalId: owner.externalId, source: 'e2e' })
  facts.setSubject(s.id, {
    facts: {
      business_type: 'ecommerce',
      sells_products_online: true,
      access_lapsed: false,
      shopify_connected: false,
      ga4_connected: false,
      search_console_connected: false,
      business_context_set: false,
      agent_connected: false,
      playbooks_run: 0,
      timezone: 'America/New_York',
      ...s.facts,
    },
    recipients: [owner],
  })
}

/** Tick at the next instant the delivery window allows, then dispatch whatever it queued. */
async function tickAndSend(mailer: Mailer, subjectId: string): Promise<void> {
  const ctx = mailer.getRunnerContext()
  const now = computeDeliveryTime(new Date(), WINDOW, 'America/New_York')
  await tickProgram(ctx, 'activation', subjectId, { now })
  await dispatchQueued(ctx)
}

export async function seedProgramBoard(mailer: Mailer, adapter: MemoryContactAdapter, facts: MemoryFactsAdapter): Promise<void> {
  mailer.registerEvent({ name: 'Upgraded', dedupePolicy: 'once-per-contact' })
  await seedTemplates(mailer)

  const definition = activationDefinition()
  await mailer.saveProgramDraft(definition, { actor: 'e2e', notes: 'seed' })
  const published = await mailer.publishProgram('activation', { actor: 'e2e' })
  if (!published.ok) throw new Error(`e2e: seed program failed validation: ${JSON.stringify(published.issues)}`)
  await mailer.setProgramEnabled('activation', true, { actor: 'e2e' })
  await mailer.saveProgramDraft(draftDefinition(definition), { actor: 'e2e', notes: 'Search Console earlier; softer business-context reminder' })

  const ctx = mailer.getRunnerContext()
  const subjects: SubjectSeed[] = [
    { id: 'acct-fresh', facts: {} },
    { id: 'acct-two-sent', facts: {} },
    { id: 'acct-shopify', facts: { shopify_connected: true, last_session_at: new Date(Date.now() - 2 * DAY) } },
    { id: 'acct-saas', facts: { business_type: 'saas', sells_products_online: false, ga4_connected: true } },
  ]
  for (const s of subjects) {
    await addSubject(mailer, adapter, facts, s)
    await enterProgram(ctx, 'activation', s.id)
  }

  // acct-two-sent: one email now, then the gap is backdated so a second goes out.
  await tickAndSend(mailer, 'acct-two-sent')
  await mailer.collections.programRuns.updateOne(
    { programSlug: 'activation', subjectId: 'acct-two-sent' },
    { $set: { lastSentAt: new Date(Date.now() - 4 * DAY), nextTickAt: new Date(0) } },
  )
  await tickAndSend(mailer, 'acct-two-sent')

  await tickAndSend(mailer, 'acct-shopify')
  await tickAndSend(mailer, 'acct-saas')
  // acct-fresh stays entered but untouched.

  console.log(`e2e: program board seeded; subjects: ${subjects.map((s) => s.id).join(', ')}`)
}
