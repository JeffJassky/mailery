/**
 * Predicate evaluator integration tests (needs real Mongo for event-based predicates).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { evaluatePredicate } from '../../src/server/runner/predicate.js'
import type { Contact, Predicate } from '../../src/shared/types.js'
import type { FlowRunDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    seedContacts: [
      { externalId: 'u1', email: 'a@example.com', tags: ['vip', 'beta'], fields: { tier: 'Pro' } },
    ],
  })
  await H.mailer.collections.events.insertOne({
    externalId: 'u1',
    name: 'Activated',
    properties: {},
    dedupeKey: 'u1:Activated',
    occurredAt: new Date(Date.now() - 1000),
    createdAt: new Date(),
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('predicate evaluator', () => {
  const contact: Contact = { externalId: 'u1', email: 'a@example.com', tags: ['vip', 'beta'], fields: { tier: 'Pro' } }
  const fakeRun: FlowRunDoc = {
    _id: new ObjectId(),
    externalId: 'u1',
    flowId: new ObjectId(),
    flowSlug: 'x',
    flowVersion: 1,
    emailAtEntry: 'a@example.com',
    enteredAt: new Date(Date.now() - 60_000),
    status: 'active',
    currentStepIndex: 0,
    currentBranchPath: [],
    nextActionAt: new Date(),
    attemptsForCurrentStep: 0,
    history: [],
    exitedAt: null,
    exitReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it('hasTag / notHasTag', async () => {
    const ctx = { contact, run: fakeRun, collections: H.mailer.collections }
    expect(await evaluatePredicate({ hasTag: 'vip' } as Predicate, ctx)).toBe(true)
    expect(await evaluatePredicate({ hasTag: 'absent' } as Predicate, ctx)).toBe(false)
    expect(await evaluatePredicate({ notHasTag: 'absent' } as Predicate, ctx)).toBe(true)
    expect(await evaluatePredicate({ notHasTag: 'vip' } as Predicate, ctx)).toBe(false)
  })

  it('fieldEquals / fieldExists', async () => {
    const ctx = { contact, run: fakeRun, collections: H.mailer.collections }
    expect(await evaluatePredicate({ fieldEquals: { field: 'tier', value: 'Pro' } } as Predicate, ctx)).toBe(true)
    expect(await evaluatePredicate({ fieldEquals: { field: 'tier', value: 'Free' } } as Predicate, ctx)).toBe(false)
    expect(await evaluatePredicate({ fieldExists: 'tier' } as Predicate, ctx)).toBe(true)
    expect(await evaluatePredicate({ fieldExists: 'absent' } as Predicate, ctx)).toBe(false)
  })

  it('hasFiredEvent / notHasFiredEvent', async () => {
    const ctx = { contact, run: fakeRun, collections: H.mailer.collections }
    expect(await evaluatePredicate({ hasFiredEvent: 'Activated' } as Predicate, ctx)).toBe(true)
    expect(await evaluatePredicate({ hasFiredEvent: 'Cancelled' } as Predicate, ctx)).toBe(false)
    expect(await evaluatePredicate({ notHasFiredEvent: 'Cancelled' } as Predicate, ctx)).toBe(true)
  })

  it('all / any / not composition', async () => {
    const ctx = { contact, run: fakeRun, collections: H.mailer.collections }

    const compound = {
      all: [
        { hasTag: 'vip' },
        { fieldEquals: { field: 'tier', value: 'Pro' } },
        { not: { hasTag: 'banned' } },
      ],
    }
    expect(await evaluatePredicate(compound as Predicate, ctx)).toBe(true)

    const fails = {
      any: [{ hasTag: 'absent' }, { hasTag: 'also-absent' }],
    }
    expect(await evaluatePredicate(fails as Predicate, ctx)).toBe(false)
  })
})
