/**
 * Program predicates — the `fact` leaf (pure) and `evaluateProgramPredicate`
 * (fact + subject-scoped event leaves + combinators).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { evaluateFactPredicate, evaluateProgramPredicate } from '../../src/server/runner/programs/index.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import type { FactPredicate, Facts } from '../../src/shared/types.js'

const facts: Facts = {
  yes: true,
  no: false,
  n: 3,
  zero: 0,
  s: 'ecommerce',
  empty: '',
  nil: null,
  when: new Date('2027-01-10T00:00:00Z'),
}

const cases: Array<[FactPredicate, boolean]> = [
  // truthiness
  [{ fact: 'yes' }, true],
  [{ fact: 'no' }, false],
  [{ fact: 'zero' }, false],
  [{ fact: 'empty' }, false],
  [{ fact: 'nil' }, false],
  [{ fact: 'missing' }, false],
  [{ fact: 'n' }, true],
  // equals
  [{ fact: 's', equals: 'ecommerce' }, true],
  [{ fact: 's', equals: 'saas' }, false],
  [{ fact: 'no', equals: false }, true],
  [{ fact: 'nil', equals: null }, true],
  [{ fact: 'missing', equals: null }, false],
  [{ fact: 'n', equals: 3 }, true],
  [{ fact: 'n', equals: '3' }, false],
  // gte / lte numbers
  [{ fact: 'n', gte: 3 }, true],
  [{ fact: 'n', gte: 4 }, false],
  [{ fact: 'n', lte: 3 }, true],
  [{ fact: 'n', gte: 1, lte: 2 }, false],
  [{ fact: 'missing', gte: 0 }, false],
  [{ fact: 'nil', lte: 10 }, false],
  // gte / lte dates (ISO or epoch ms)
  [{ fact: 'when', gte: '2027-01-01T00:00:00Z' }, true],
  [{ fact: 'when', lte: '2027-01-01T00:00:00Z' }, false],
  [{ fact: 'when', gte: Date.parse('2027-01-10T00:00:00Z') }, true],
  // in
  [{ fact: 's', in: ['saas', 'ecommerce'] }, true],
  [{ fact: 's', in: ['saas'] }, false],
  [{ fact: 'nil', in: [null] }, true],
  // exists
  [{ fact: 'no', exists: true }, true],
  [{ fact: 'zero', exists: true }, true],
  [{ fact: 'nil', exists: true }, false],
  [{ fact: 'missing', exists: true }, false],
  [{ fact: 'missing', exists: false }, true],
  [{ fact: 'nil', exists: false }, true],
  // several operators AND together
  [{ fact: 'n', exists: true, gte: 2, in: [3, 4] }, true],
  [{ fact: 'n', exists: true, gte: 2, in: [4] }, false],
]

describe('evaluateFactPredicate', () => {
  for (const [p, want] of cases) {
    it(`${JSON.stringify(p)} → ${want}`, () => {
      expect(evaluateFactPredicate(p, facts)).toBe(want)
    })
  }
  it('date facts given as ISO strings compare by instant', () => {
    expect(evaluateFactPredicate({ fact: 'd', gte: '2027-01-01T00:00:00Z' }, { d: '2027-02-01T00:00:00.000Z' })).toBe(true)
  })
})

describe('evaluateProgramPredicate', () => {
  let H: TestMailerHarness
  const now = new Date()

  beforeAll(async () => {
    H = await createTestMailer()
    await H.mailer.collections.events.insertMany([
      { externalId: 'acct-1', name: 'Playbook Run', properties: {}, dedupeKey: 'p1', occurredAt: new Date(now.getTime() - 2 * 86_400_000), createdAt: now },
      { externalId: 'someone-else', name: 'Agent Installed', properties: {}, dedupeKey: 'p2', occurredAt: now, createdAt: now },
    ])
  }, 120_000)

  afterAll(async () => {
    if (H) await H.stop()
  })

  const ev = (pred: any, f: Facts = facts) =>
    evaluateProgramPredicate(pred, { facts: f, subjectId: 'acct-1', collections: H.mailer.collections, now, enteredAt: now })

  it('fact leaves', async () => {
    expect(await ev({ fact: 'yes' })).toBe(true)
  })
  it('all / any / not', async () => {
    expect(await ev({ all: [{ fact: 'yes' }, { fact: 'n', gte: 3 }] })).toBe(true)
    expect(await ev({ all: [{ fact: 'yes' }, { fact: 'no' }] })).toBe(false)
    expect(await ev({ any: [{ fact: 'no' }, { fact: 's', equals: 'ecommerce' }] })).toBe(true)
    expect(await ev({ not: { fact: 'no' } })).toBe(true)
  })
  it('hasFiredEvent reads events with externalId = subjectId', async () => {
    expect(await ev({ hasFiredEvent: 'Playbook Run' })).toBe(true)
    expect(await ev({ hasFiredEvent: 'Agent Installed' })).toBe(false)
  })
  it('hasFiredEvent withinDays', async () => {
    expect(await ev({ hasFiredEvent: 'Playbook Run', withinDays: 1 })).toBe(false)
    expect(await ev({ hasFiredEvent: 'Playbook Run', withinDays: 3 })).toBe(true)
  })
  it('notHasFiredEvent', async () => {
    expect(await ev({ notHasFiredEvent: 'Agent Installed' })).toBe(true)
    expect(await ev({ notHasFiredEvent: 'Playbook Run' })).toBe(false)
  })
  it('a contact-scoped leaf throws instead of silently evaluating false', async () => {
    await expect(ev({ hasTag: 'vip' })).rejects.toThrow()
  })
})
