/**
 * SendGrid provider-adapter axes, against the real API.
 *
 * SCOPE: this tier is NOT a second copy of the flow matrix. Its job is to
 * confirm the provider adapter's own configuration surface actually works —
 * auth, sandbox mode, the SendArgs→MailDataRequired mapping, the response
 * mapping, and the error path. Flow, template and scheduling behaviour is
 * covered offline in `test/matrix`, and stays there.
 *
 * Default mode is `sandbox`: SendGrid authenticates the key, validates the
 * whole payload and returns 202 without delivering anything. That is enough to
 * prove every mapping axis below except what only the delivered MIME can show
 * (see `delivery.test.ts`). It costs no quota and cannot spam anyone.
 *
 * Skipped entirely unless MAILERY_LIVE_E2E and SENDGRID_API_KEY are set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { SendGridProvider } from '../../src/server/providers/sendgrid.js'
import { LIVE, liveMode, liveFromEmail, describeGate, REDIS_URL, gmailUser } from './gate.js'
import { newToken, taggedAddress, describeChecks } from './inbox.js'

// eslint-disable-next-line no-console
console.log(`[live] ${describeGate()}`)

const sandbox = liveMode() !== 'deliver'

describe.skipIf(!LIVE)('SendGrid provider adapter', () => {
  let provider: SendGridProvider

  beforeAll(() => {
    provider = new SendGridProvider({ apiKey: process.env.SENDGRID_API_KEY!, sandbox })
  })

  it('authenticates and accepts a well-formed payload', async () => {
    const token = newToken()
    const result = await provider.send({
      to: recipient(token),
      fromName: 'Mailery Live',
      fromEmail: liveFromEmail(),
      subject: `mailery live ${token}`,
      html: `<html><body>${describeChecks({
        title: 'minimal payload accepted',
        token,
        checks: [
          'the API key authenticates against SendGrid',
          'a minimal SendArgs payload is accepted (HTTP 2xx)',
          'a provider message id comes back from the x-message-id header',
        ],
      })}</body></html>`,
      text: `mailery live test — minimal payload accepted. Token: ${token}`,
    })

    expect(result.status).toBe('accepted')
    // providerId comes from the x-message-id response header; the `sg-` prefix
    // is the fallback the adapter synthesises when the header is missing.
    expect(result.providerId).toBeTruthy()
    expect(typeof result.providerId).toBe('string')
  }, 30_000)

  it('accepts the full mapping surface: replyTo, headers and messageMeta', async () => {
    // Every optional field the adapter maps, in one call. A 400 from SendGrid
    // on any of them fails this test — which is the whole point.
    const mappingToken = newToken()
    const result = await provider.send({
      to: recipient(mappingToken),
      fromName: 'Mailery Live',
      fromEmail: liveFromEmail(),
      replyTo: liveFromEmail(),
      subject: `mailery mapping ${mappingToken}`,
      html: `<html><body>${describeChecks({
        title: 'full SendArgs mapping surface',
        token: mappingToken,
        checks: [
          'replyTo maps onto the SendGrid message',
          'custom headers (List-Unsubscribe, List-Unsubscribe-Post) are accepted',
          'messageMeta maps to SendGrid customArgs for later correlation',
          'an anchor survives with provider click-tracking disabled',
        ],
      })}<a href="https://example.com/x">x</a></body></html>`,
      text: `mailery live test — full SendArgs mapping surface. Token: ${mappingToken}`,
      headers: {
        'List-Unsubscribe': '<https://example.com/unsub/abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      messageMeta: { sendId: '507f1f77bcf86cd799439011' },
    })

    expect(result.status).toBe('accepted')
  }, 30_000)

  it('accepts a unicode subject and body', async () => {
    const token = newToken()
    const result = await provider.send({
      to: recipient(token),
      fromName: 'Mailery Live',
      fromEmail: liveFromEmail(),
      subject: `mailery ünïcode ✉️ ${token}`,
      html: `<html><body><p>Grüße — 你好 ✉️</p>${describeChecks({
        title: 'unicode subject and body',
        token,
        checks: [
          'a non-ASCII subject is accepted and RFC 2047 encoded on the wire',
          'multi-byte characters in the body survive (Grüße — 你好 ✉️)',
        ],
      })}</body></html>`,
      text: `Grüße — 你好 ✉️ — mailery live test, unicode handling. Token: ${token}`,
    })

    expect(result.status).toBe('accepted')
  }, 30_000)

  /**
   * Sandbox mode does NOT check sender authentication — it accepts an
   * unverified from-domain with a 200. That is a real limitation of using
   * sandbox as the safe rung: it proves the payload is well-formed, not that
   * the message would have been sent. Only the deliver path settles this.
   */
  it.skipIf(sandbox)('rejects an unverified sender rather than silently accepting', async () => {
    await expect(
      provider.send({
        to: recipient(),
        fromName: 'Nobody',
        fromEmail: 'nobody@definitely-not-verified-mailery-test.invalid',
        subject: 'should be rejected',
        html: '<p>x</p>',
        text: 'x',
      }),
    ).rejects.toThrow()
  }, 30_000)

  it('surfaces a malformed recipient as an error', async () => {
    await expect(
      provider.send({
        to: 'not-an-email',
        fromName: 'Mailery Live',
        fromEmail: liveFromEmail(),
        subject: 'bad recipient',
        html: '<p>x</p>',
        text: 'x',
      }),
    ).rejects.toThrow()
  }, 30_000)
})

describe.skipIf(!LIVE)('SendGrid through the full send pipeline', () => {
  let H: TestMailerHarness

  beforeAll(async () => {
    H = await createTestMailer({
      provider: 'sendgrid',
      // Real workers when a Redis is available — that is the only setup that
      // exercises job delays, retries and the send rate limiter. Without one
      // the pipeline still runs, driven by drain().
      ...(REDIS_URL
        ? { queue: { driver: 'bull' as const, redis: { url: REDIS_URL } }, startWorkers: true }
        : {}),
      config: { fromDefaults: { name: 'Mailery Live', email: liveFromEmail() } },
    })
  }, 120_000)

  afterAll(async () => {
    if (H) await H.stop()
  })

  it('a flow send reaches SendGrid and records the provider message id', async () => {
    const token = newToken()
    await H.seedContact({
      externalId: 'live-1',
      email: recipient(token),
      tags: [],
      fields: { firstName: 'Live' },
    })
    await H.seedTemplate({
      slug: 'live-tpl',
      subject: `mailery pipeline ${token}`,
      fromEmail: liveFromEmail(),
      fromName: 'Mailery Live',
      html: `<html><body><p>Hello {{contact.fields.firstName}}</p>${describeChecks({
        title: 'full send pipeline through SendGrid',
        token,
        checks: [
          'a flow send renders, dispatches and reaches SendGrid end to end',
          'the send row records the provider message id and status=sent',
          'the unsubscribe URL and List-Unsubscribe header are generated per recipient',
          'Handlebars substitution happened (the greeting above says Live)',
        ],
      })}</body></html>`,
    })
    await H.seedFlow({ slug: 'live-flow', eventName: 'LiveTrigger', steps: [step.send('live-tpl')] })
    H.mailer.registerEvent({ name: 'LiveTrigger', dedupePolicy: 'every-time' })

    await H.mailer.fire('LiveTrigger', 'live-1')
    await settle(H)

    const send = await H.ctx.collections.sends.findOne({ externalId: 'live-1' })
    expect(send?.status, send?.errorMessage ?? '').toBe('sent')
    expect(send?.providerMessageId).toBeTruthy()
    expect(send?.provider).toBe('sendgrid')

    // The recording wrapper proves what mailery handed the adapter.
    const args = H.provider.toRecipient(recipient(token))[0]
    expect(args?.text).toContain('Hello Live')
    expect(args?.html).toContain('Hello Live')
    expect(args?.headers?.['List-Unsubscribe']).toMatch(/^<http/)
    expect(H.provider.records[0]?.result?.status).toBe('accepted')
  }, 180_000)
})

/** Plus-tagged live recipient, so everything lands in one inbox, isolable. */
function recipient(token = newToken()): string {
  if (gmailUser()) return taggedAddress(token)
  // Sandbox mode never delivers, so an unroutable address is fine there.
  return `mailery-live-${token}@example.com`
}

/** Wait for the pipeline, whichever way it is being driven. */
async function settle(H: TestMailerHarness): Promise<void> {
  if (!REDIS_URL) {
    await H.drain()
    return
  }
  // Real workers: poll until the send leaves the queue, up to 60s.
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const pending = await H.ctx.collections.sends.countDocuments({
      status: { $in: ['queued', 'sending'] },
    })
    const sent = await H.ctx.collections.sends.countDocuments({})
    if (sent > 0 && pending === 0) return
    await new Promise((r) => setTimeout(r, 1_000))
  }
}
