/**
 * Unsubscribe tokens carry the template's category (0.21).
 *
 * Wire format: `c` is added beside the signed `s: 'marketing'`. A 0.20
 * verifier (rollback) ignores `c` and opts the recipient out of all
 * marketing — the safe direction. A 0.21 verifier resolves the effective
 * scope through `tokenScope()`. Tokens minted before 0.21 have no `c` and
 * keep meaning `marketing` until they expire.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import type { ObjectId } from 'mongodb'

import { signUnsubscribeToken, tokenScope, verifyUnsubscribeToken } from '../../src/server/tokens.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/send.js'

const SECRET = 'test-secret-that-is-long-enough-for-hmac'
const C = 'lifecycle.onboarding'
const future = () => new Date(Date.now() + 86_400_000)

function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  return Buffer.from(padded, 'base64').toString('utf8')
}
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** Sign an arbitrary body the way tokens.ts does — for forging "valid but odd" tokens. */
function signRaw(body: object): string {
  const bodyB64 = b64url(JSON.stringify(body))
  const sig = crypto.createHmac('sha256', SECRET).update(bodyB64).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${bodyB64}.${sig}`
}

describe('token round-trip', () => {
  it('a categorised token verifies to category scope', () => {
    const t = signUnsubscribeToken({ email: 'a@example.com', scope: 'marketing', category: C, expiresAt: future() }, SECRET)
    const v = verifyUnsubscribeToken(t, SECRET)
    expect(v).not.toBeNull()
    expect(v!.category).toBe(C)
    expect(v!.scope).toBe('marketing')
    expect(tokenScope(v!)).toBe(`category:${C}`)
  })

  it('signs scope "marketing" plus `c`, so a 0.20 verifier reads it as a marketing opt-out', () => {
    const t = signUnsubscribeToken({ email: 'a@example.com', scope: 'marketing', category: C, expiresAt: future() }, SECRET)
    const body = JSON.parse(b64urlDecode(t.split('.')[0]!))
    expect(body.s).toBe('marketing')
    expect(body.c).toBe(C)
  })

  it('an old token (no category) still means marketing', () => {
    const t = signRaw({ e: 'old@example.com', s: 'marketing', x: future().getTime() })
    const v = verifyUnsubscribeToken(t, SECRET)
    expect(v).not.toBeNull()
    expect(v!.category).toBeUndefined()
    expect(tokenScope(v!)).toBe('marketing')
  })

  it('an all-scope token without category still means all', () => {
    const t = signUnsubscribeToken({ email: 'a@example.com', scope: 'all', expiresAt: future() }, SECRET)
    expect(tokenScope(verifyUnsubscribeToken(t, SECRET)!)).toBe('all')
  })

  it('carries sendId and category together', () => {
    const sendId = 'a'.repeat(24)
    const t = signUnsubscribeToken({ email: 'a@example.com', scope: 'marketing', category: C, sendId, expiresAt: future() }, SECRET)
    const v = verifyUnsubscribeToken(t, SECRET)!
    expect(v.sendId).toBe(sendId)
    expect(v.category).toBe(C)
  })

  it('an expired categorised token is rejected', () => {
    const t = signUnsubscribeToken(
      { email: 'a@example.com', scope: 'marketing', category: C, expiresAt: new Date(Date.now() - 1000) },
      SECRET,
    )
    expect(verifyUnsubscribeToken(t, SECRET)).toBeNull()
  })

  it('a tampered category is rejected (body changed, signature kept)', () => {
    const t = signUnsubscribeToken({ email: 'a@example.com', scope: 'marketing', category: C, expiresAt: future() }, SECRET)
    const [bodyB64, sig] = t.split('.') as [string, string]
    const body = JSON.parse(b64urlDecode(bodyB64))
    body.c = 'product.updates'
    expect(verifyUnsubscribeToken(`${b64url(JSON.stringify(body))}.${sig}`, SECRET)).toBeNull()
  })

  it('stripping the category to widen the opt-out is rejected too', () => {
    const t = signUnsubscribeToken({ email: 'a@example.com', scope: 'marketing', category: C, expiresAt: future() }, SECRET)
    const [bodyB64, sig] = t.split('.') as [string, string]
    const body = JSON.parse(b64urlDecode(bodyB64))
    delete body.c
    expect(verifyUnsubscribeToken(`${b64url(JSON.stringify(body))}.${sig}`, SECRET)).toBeNull()
  })

  it('a validly signed token with a malformed category id is rejected', () => {
    const t = signRaw({ e: 'a@example.com', s: 'marketing', x: future().getTime(), c: 'Not A Category!' })
    expect(verifyUnsubscribeToken(t, SECRET)).toBeNull()
  })

  it('a non-string category is rejected', () => {
    const t = signRaw({ e: 'a@example.com', s: 'marketing', x: future().getTime(), c: 42 })
    expect(verifyUnsubscribeToken(t, SECRET)).toBeNull()
  })

  it('a wrong secret is rejected', () => {
    const t = signUnsubscribeToken({ email: 'a@example.com', scope: 'marketing', category: C, expiresAt: future() }, SECRET)
    expect(verifyUnsubscribeToken(t, 'another-secret-entirely-different')).toBeNull()
  })
})

describe('rendered mail carries the right token', () => {
  let H: TestMailerHarness

  beforeAll(async () => {
    H = await createTestMailer({ config: { categories: [{ id: C, label: 'Getting started' }] } })
    await H.seedContact({ externalId: 'u1', email: 'alice@example.com', tags: [], fields: {} })
    await H.seedTemplate({ slug: 'cat', kind: 'marketing', category: C, subject: 'Hi', text: 'Bye {{unsubscribeUrl}}' })
    await H.seedTemplate({ slug: 'plain', kind: 'marketing', subject: 'Hi', text: 'Bye {{unsubscribeUrl}}' })
  }, 120_000)

  afterAll(async () => {
    if (H) await H.stop()
  })

  async function send(slug: string) {
    await H.mailer.sendOneOff({ templateSlug: slug, externalId: 'u1', dedupeKey: `tok-${slug}` })
    const row = await H.mailer.collections.sends.findOne({ dedupeKey: `oneoff:tok-${slug}` })
    await dispatchSend(row!._id as ObjectId, H.ctx)
    const args = H.provider.sent.at(-1)!
    const header = args.headers?.['List-Unsubscribe'] ?? ''
    const token = decodeURIComponent(header.match(/\/unsub\/([^>]+)>/)?.[1] ?? '')
    return { args, token, row }
  }

  it('categorised template → List-Unsubscribe token scoped to its category', async () => {
    const { token } = await send('cat')
    const v = verifyUnsubscribeToken(token, H.mailer.config.unsubscribeSecret)
    expect(v).not.toBeNull()
    expect(tokenScope(v!)).toBe(`category:${C}`)
  })

  it('the body link and the header link agree', async () => {
    const { args, token } = await send('cat')
    expect(args.text).toContain(`/unsub/${token}`)
  })

  it('categorised mail carries List-ID: <category>.<sender domain>', async () => {
    const { args } = await send('cat')
    // Builder default fromEmail is hello@example.com.
    expect(args.headers?.['List-ID']).toBe(`<${C}.example.com>`)
  })

  it('uncategorised mail carries no List-ID (headers unchanged from 0.20)', async () => {
    const { args } = await send('plain')
    expect(args.headers?.['List-ID']).toBeUndefined()
    expect(Object.keys(args.headers ?? {}).sort()).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post'])
  })

  it('uncategorised template → marketing token without `c`, exactly as 0.20', async () => {
    const { token } = await send('plain')
    const v = verifyUnsubscribeToken(token, H.mailer.config.unsubscribeSecret)!
    expect(v.category).toBeUndefined()
    expect(tokenScope(v)).toBe('marketing')
    const body = JSON.parse(b64urlDecode(token.split('.')[0]!))
    expect(Object.keys(body).sort()).toEqual(['e', 'i', 's', 'x'])
  })
})
