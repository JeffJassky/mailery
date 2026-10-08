/**
 * INVARIANT 4 extended by INVARIANT 22 — the blocking rule, every cell.
 *
 *   template                  blocked by
 *   transactional             all, transactional
 *   marketing, no category    all, marketing
 *   marketing, category C     all, marketing, category:C
 *
 * Three layers, because the rule has three call sites that must agree: the
 * pure `blockingScopes`, the per-send `isSuppressed` (plaintext and hashed
 * rows), and the batch `suppressedEmails` that broadcast dispatch uses. Then
 * one end-to-end pass through `dispatchSend`, so the rule is proven where the
 * mail actually leaves, not only in a helper.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { blockingScopes, isSuppressed, suppressedEmails } from '../../src/server/runner/suppression.js'
import { dispatchSend } from '../../src/server/runner/send.js'
import { sha256Hex } from '../../src/server/tokens.js'
import type { SuppressionScope, TemplateKind } from '../../src/shared/enums.js'

const C = 'lifecycle.onboarding'
const OTHER = 'product.updates'

const SCOPES: SuppressionScope[] = ['all', 'marketing', 'transactional', `category:${C}`, `category:${OTHER}`]

type Cell = { kind: TemplateKind; category: string | null }
const TEMPLATES: Cell[] = [
  { kind: 'transactional', category: null },
  { kind: 'marketing', category: null },
  { kind: 'marketing', category: C },
]

/** The table above, written out independently of the implementation. */
function expectedBlocked(t: Cell, scope: SuppressionScope): boolean {
  if (scope === 'all') return true
  if (t.kind === 'transactional') return scope === 'transactional'
  if (scope === 'marketing') return true
  return t.category !== null && scope === `category:${t.category}`
}

describe('blockingScopes — pure rule', () => {
  it('transactional → all, transactional', () => {
    expect(new Set(blockingScopes('transactional'))).toEqual(new Set(['all', 'transactional']))
  })
  it('marketing without category → all, marketing (0.20 behaviour)', () => {
    expect(new Set(blockingScopes('marketing'))).toEqual(new Set(['all', 'marketing']))
    expect(new Set(blockingScopes('marketing', null))).toEqual(new Set(['all', 'marketing']))
  })
  it('marketing with category C → all, marketing, category:C', () => {
    expect(new Set(blockingScopes('marketing', C))).toEqual(new Set(['all', 'marketing', `category:${C}`]))
  })
  it('a category on a transactional template is ignored', () => {
    expect(new Set(blockingScopes('transactional', C))).toEqual(new Set(['all', 'transactional']))
  })
  for (const t of TEMPLATES) {
    for (const scope of SCOPES) {
      it(`${t.kind}/${t.category ?? 'none'} vs ${scope} → ${expectedBlocked(t, scope) ? 'blocked' : 'allowed'}`, () => {
        expect(blockingScopes(t.kind, t.category).includes(scope)).toBe(expectedBlocked(t, scope))
      })
    }
  }
})

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    config: { categories: [{ id: C, label: 'Getting started' }, { id: OTHER, label: 'Product updates' }] },
  })
}, 120_000)

afterAll(async () => {
  if (H) await H.stop()
})

beforeEach(async () => {
  await H.mailer.collections.suppressions.deleteMany({})
})

async function suppress(email: string, scope: SuppressionScope, hashedOnly = false) {
  await H.mailer.collections.suppressions.insertOne({
    email: hashedOnly ? null : email,
    emailHash: sha256Hex(email),
    scope,
    reason: hashedOnly ? 'gdpr_forget' : 'unsubscribed',
    source: 'test',
    notes: null,
    addedAt: new Date(),
    expiresAt: null,
  })
}

describe('isSuppressed / suppressedEmails — every (kind, category, scope) cell', () => {
  for (const hashedOnly of [false, true]) {
    for (const t of TEMPLATES) {
      for (const scope of SCOPES) {
        const label = `${hashedOnly ? 'hashed ' : ''}${scope} row vs ${t.kind}/${t.category ?? 'none'}`
        it(label, async () => {
          const email = `${t.kind}-${t.category ?? 'none'}-${scope.replace(/[:.]/g, '_')}-${hashedOnly ? 'h' : 'p'}@example.com`
          await suppress(email, scope, hashedOnly)

          const single = await isSuppressed(H.mailer.collections, email, t.kind, t.category)
          expect(single.suppressed).toBe(expectedBlocked(t, scope))
          if (single.suppressed) expect(single.scope).toBe(scope)

          const batch = await suppressedEmails(H.mailer.collections, [email, 'clean@example.com'], t.kind, t.category)
          expect(batch.has(email)).toBe(expectedBlocked(t, scope))
          expect(batch.has('clean@example.com')).toBe(false)
        })
      }
    }
  }

  it('an expired category row blocks nothing', async () => {
    await H.mailer.collections.suppressions.insertOne({
      email: 'expired@example.com',
      emailHash: sha256Hex('expired@example.com'),
      scope: `category:${C}`,
      reason: 'unsubscribed',
      source: 'test',
      notes: null,
      addedAt: new Date(Date.now() - 2 * 86_400_000),
      expiresAt: new Date(Date.now() - 86_400_000),
    })
    expect((await isSuppressed(H.mailer.collections, 'expired@example.com', 'marketing', C)).suppressed).toBe(false)
  })
})

describe('dispatchSend applies the rule where the mail leaves', () => {
  let n = 0
  async function sendVia(kind: TemplateKind, category: string | null, scope: SuppressionScope | null) {
    n++
    const email = `dispatch${n}@example.com`
    await H.seedContact({ externalId: `d${n}`, email, tags: [], fields: {} })
    const slug = `t-${n}`
    await H.seedTemplate({ slug, kind, ...(category ? { category } : {}), subject: 'Hello' })
    if (scope) await suppress(email, scope)
    const { sendId } = await H.mailer.sendOneOff({ templateSlug: slug, externalId: `d${n}`, dedupeKey: `bm-${n}` })
    const before = H.provider.sent.length
    await dispatchSend((await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:bm-${n}` }))!._id as ObjectId, H.ctx)
    const row = await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:bm-${n}` })
    return { sendId, row, delivered: H.provider.sent.length > before }
  }

  it('category opt-out blocks that category', async () => {
    const r = await sendVia('marketing', C, `category:${C}`)
    expect(r.delivered).toBe(false)
    expect(r.row?.status).toBe('suppressed')
  })

  it('category opt-out does not block another category', async () => {
    const r = await sendVia('marketing', OTHER, `category:${C}`)
    expect(r.delivered).toBe(true)
  })

  it('category opt-out does not block uncategorised marketing', async () => {
    const r = await sendVia('marketing', null, `category:${C}`)
    expect(r.delivered).toBe(true)
  })

  it('category opt-out never blocks transactional mail (INVARIANT 22)', async () => {
    const r = await sendVia('transactional', null, `category:${C}`)
    expect(r.delivered).toBe(true)
  })

  it('a marketing opt-out still blocks categorised mail', async () => {
    const r = await sendVia('marketing', C, 'marketing')
    expect(r.delivered).toBe(false)
  })

  it('the category is read from the template at dispatch, not from the row at enqueue', async () => {
    n++
    const email = `late${n}@example.com`
    await H.seedContact({ externalId: `d${n}`, email, tags: [], fields: {} })
    await H.seedTemplate({ slug: `late-${n}`, kind: 'marketing', subject: 'Hello' })
    await suppress(email, `category:${C}`)
    await H.mailer.sendOneOff({ templateSlug: `late-${n}`, externalId: `d${n}`, dedupeKey: `late-${n}` })
    // Categorised after the send was queued.
    await H.mailer.collections.templates.updateOne({ slug: `late-${n}` }, { $set: { category: C } })
    const row = await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:late-${n}` })
    await dispatchSend(row!._id as ObjectId, H.ctx)
    expect((await H.mailer.collections.sends.findOne({ _id: row!._id }))?.status).toBe('suppressed')
  })
})
