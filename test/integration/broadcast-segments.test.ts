/**
 * Segment evaluation for broadcasts (runner/segment.ts): which filters the
 * host adapter takes, and that every mailer-side filter really narrows —
 * `opened`, `notOpened`, `subscribedAfter` and `subscribedBefore` used to be
 * a pass for every contact, nested host-side filters likewise, and a second
 * `hasTag` replaced the first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { applyPostFilters, planSegment } from '../../src/server/runner/segment.js'
import { runTick } from '../../src/server/runner/index.js'
import { createBroadcast, parseSegment, scheduleBroadcast } from '../../src/server/api/broadcast-ops.js'
import { segmentDefinitionSchema } from '../../src/shared/schemas.js'
import type { Contact, SegmentFilter } from '../../src/shared/types.js'

const DAY = 86_400_000

let H: TestMailerHarness
let contacts: Contact[]

async function eligible(filters: SegmentFilter[]): Promise<string[]> {
  const { hostFilter, postFilters } = planSegment({ filters })
  const page = await H.adapter.query(hostFilter, { limit: 1000 })
  const out = await applyPostFilters(page.contacts, postFilters, H.ctx)
  return out.map((c) => c.externalId).sort()
}

beforeAll(async () => {
  H = await createTestMailer()
  contacts = [
    { externalId: 'a', email: 'a@example.com', tags: ['beta'], fields: { plan: 'pro', profile: { country: 'US' } } },
    { externalId: 'b', email: 'b@example.com', tags: ['beta', 'vip'], fields: { plan: 'free', profile: { country: 'DE' } } },
    { externalId: 'c', email: 'c@example.com', tags: [], fields: { plan: 'pro' } },
    { externalId: 'd', email: 'd@example.com', tags: [], fields: { plan: 'free' } },
  ]
  for (const c of contacts) await H.seedContact(c)
  const subs = H.ctx.collections.subscriptions
  await subs.updateOne({ externalId: 'a' }, { $set: { subscribedAt: new Date('2026-01-01T00:00:00Z') } })
  await subs.updateOne({ externalId: 'b' }, { $set: { subscribedAt: new Date('2026-06-01T00:00:00Z') } })
  await subs.updateOne({ externalId: 'c' }, { $set: { subscribedAt: new Date('2026-08-01T00:00:00Z') } })
  await subs.updateOne({ externalId: 'd' }, { $set: { status: 'unsubscribed', subscribedAt: null } })

  const tpl = await H.seedTemplate({ slug: 'news-may', kind: 'marketing', subject: 'May', html: '<p>May {{unsubscribeUrl}}</p>' })
  const send = (externalId: string, templateSlug: string, openedAt: Date | null) => ({
    _id: new ObjectId(),
    dedupeKey: `seed:${externalId}:${templateSlug}`,
    externalId,
    emailAtSend: `${externalId}@example.com`,
    templateId: tpl._id!,
    templateSlug,
    flowRunId: null,
    broadcastId: null,
    manualSendBy: null,
    kind: 'marketing' as const,
    provider: 'null',
    providerMessageId: null,
    fromName: 'T',
    fromEmail: 'hello@example.com',
    subject: 's',
    bodyHash: '',
    status: 'delivered' as const,
    errorMessage: null,
    bounceType: null,
    bounceReason: null,
    links: [],
    vars: {},
    openedAt,
    openCount: openedAt ? 1 : 0,
    firstClickAt: null,
    clickCount: 0,
    clickedLinks: [],
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt: new Date(),
    updatedAt: new Date(),
    sentAt: new Date(),
    deliveredAt: new Date(),
  })
  await H.ctx.collections.sends.insertMany([
    send('a', 'news-may', new Date(Date.now() - 10 * DAY)),
    send('b', 'news-apr', new Date(Date.now() - 40 * DAY)),
    send('c', 'news-may', null),
  ])

  const evt = (externalId: string, daysAgo: number) => ({
    externalId,
    name: 'Paid',
    properties: {},
    dedupeKey: `seed:${externalId}:Paid`,
    occurredAt: new Date(Date.now() - daysAgo * DAY),
    createdAt: new Date(),
  })
  await H.ctx.collections.events.insertMany([evt('a', 5), evt('b', 100)])
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('opened / notOpened', () => {
  it('narrows to contacts with an opened send, by template and window', async () => {
    expect(await eligible([{ kind: 'opened' }])).toEqual(['a', 'b'])
    expect(await eligible([{ kind: 'opened', templateSlug: 'news-may' }])).toEqual(['a'])
    expect(await eligible([{ kind: 'opened', withinDays: 30 }])).toEqual(['a'])
    expect(await eligible([{ kind: 'notOpened', withinDays: 30 }])).toEqual(['b', 'c', 'd'])
    expect(await eligible([{ kind: 'notOpened', templateSlug: 'news-may' }])).toEqual(['b', 'c', 'd'])
  })
})

describe('subscribedAfter / subscribedBefore', () => {
  it('compares the subscription date, and never matches a contact without one', async () => {
    const may = new Date('2026-05-01T00:00:00Z')
    expect(await eligible([{ kind: 'subscribedAfter', date: may }])).toEqual(['b', 'c'])
    expect(await eligible([{ kind: 'subscribedBefore', date: may }])).toEqual(['a'])
  })

  it('accepts a date stored as a string by an older version', async () => {
    expect(await eligible([{ kind: 'subscribedAfter', date: '2026-05-01T00:00:00Z' as any }])).toEqual(['b', 'c'])
  })
})

describe('events', () => {
  it('keeps firedEvent and notFiredEvent on the same event with different windows apart', async () => {
    // Ever paid, but not in the last 30 days: only b. These used to share one
    // cache slot, so the second lookup overwrote the first.
    expect(
      await eligible([
        { kind: 'firedEvent', eventName: 'Paid' },
        { kind: 'notFiredEvent', eventName: 'Paid', withinDays: 30 },
      ]),
    ).toEqual(['b'])
  })
})

describe('composition', () => {
  it('evaluates mailer-side filters nested in any/not', async () => {
    // Nested subscriptionStatus had no cache entry and matched nobody.
    expect(await eligible([{ kind: 'any', filters: [{ kind: 'subscriptionStatus', equals: 'subscribed' }] }])).toEqual(['a', 'b', 'c'])
    expect(await eligible([{ kind: 'not', filter: { kind: 'opened' } }])).toEqual(['c', 'd'])
  })

  it('evaluates host-side filters nested in any against the contact', async () => {
    // These used to be a pass for everyone.
    expect(
      await eligible([{ kind: 'any', filters: [{ kind: 'hasTag', tag: 'vip' }, { kind: 'fieldEquals', field: 'plan', value: 'pro' }] }]),
    ).toEqual(['a', 'b', 'c'])
    expect(await eligible([{ kind: 'not', filter: { kind: 'fieldIn', field: 'profile.country', values: ['US', 'DE'] } }])).toEqual(['c', 'd'])
    expect(await eligible([{ kind: 'any', filters: [{ kind: 'fieldExists', field: 'profile' }] }])).toEqual(['a', 'b'])
  })

  it('enforces every top-level hasTag, not just the last one', async () => {
    const plan = planSegment({ filters: [{ kind: 'hasTag', tag: 'beta' }, { kind: 'hasTag', tag: 'vip' }] })
    expect(plan.hostFilter).toEqual({ hasTag: 'beta' })
    expect(plan.postFilters).toEqual([{ kind: 'hasTag', tag: 'vip' }])
    expect(await eligible([{ kind: 'hasTag', tag: 'beta' }, { kind: 'hasTag', tag: 'vip' }])).toEqual(['b'])
  })

  it('never hands the host two conditions on the same field', async () => {
    const plan = planSegment({
      filters: [
        { kind: 'fieldEquals', field: 'plan', value: 'pro' },
        { kind: 'fieldIn', field: 'plan', values: ['pro', 'free'] },
      ],
    })
    expect(plan.hostFilter).toEqual({ fieldEquals: { field: 'plan', value: 'pro' } })
    expect(plan.postFilters).toHaveLength(1)
  })

  it('throws on an unknown kind instead of matching everyone', async () => {
    await expect(applyPostFilters(contacts, [{ kind: 'mystery' } as any], H.ctx)).rejects.toThrow(/unknown segment filter kind/)
  })
})

describe('validation', () => {
  it('strict refuses empty values, operator values, $-fields and unknown kinds; lenient only checks types', () => {
    const strict = segmentDefinitionSchema(true)
    const lenient = segmentDefinitionSchema(false)
    expect(strict.safeParse({ filters: [{ kind: 'hasTag', tag: '' }] }).success).toBe(false)
    expect(lenient.safeParse({ filters: [{ kind: 'hasTag', tag: '' }] }).success).toBe(true)
    expect(lenient.safeParse({ filters: [{ kind: 'fieldEquals', field: 'plan', value: { $ne: null } }] }).success).toBe(false)
    expect(lenient.safeParse({ filters: [{ kind: 'fieldExists', field: '$where' }] }).success).toBe(false)
    expect(lenient.safeParse({ filters: [{ kind: 'mystery' }] }).success).toBe(false)
    expect(strict.safeParse({ filters: [{ kind: 'any', filters: [] }] }).success).toBe(false)
  })

  it('coerces JSON dates to Date on the way in', () => {
    const seg = parseSegment({ filters: [{ kind: 'subscribedAfter', date: '2026-05-01T00:00:00.000Z' }] }, true)
    expect((seg.filters[0] as any).date).toBeInstanceOf(Date)
  })
})

describe('end to end', () => {
  it('a dispatched broadcast sends only to the segment', async () => {
    await createBroadcast(
      H.mailer,
      {
        slug: 'seg-e2e',
        name: 'Seg',
        templateSlug: 'news-may',
        segmentDefinition: {
          filters: [
            { kind: 'subscriptionStatus', equals: 'subscribed' },
            { kind: 'notOpened', templateSlug: 'news-may' },
            { kind: 'subscribedAfter', date: new Date('2026-05-01T00:00:00Z') },
          ],
        },
      },
      'test',
    )
    await scheduleBroadcast(H.mailer, 'seg-e2e', { scheduledAt: new Date(Date.now() - 1000).toISOString(), confirmedCount: 2 }, 'test')
    await runTick(H.ctx)
    const b = await H.ctx.collections.broadcasts.findOne({ slug: 'seg-e2e' })
    const sent = await H.ctx.collections.sends.find({ broadcastId: b!._id }).toArray()
    expect(sent.map((s) => s.externalId).sort()).toEqual(['b', 'c'])
  })
})
