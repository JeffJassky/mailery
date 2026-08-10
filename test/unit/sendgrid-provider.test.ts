/**
 * SendGrid provider adapter — the half that needs no network.
 *
 * `verifyWebhook` and `parseWebhookEvents` are pure given their inputs, so
 * they belong in the always-on suite rather than the gated live tier. Between
 * them they cover the inbound side of the adapter's configuration surface:
 * signature verification with the ECDSA key from SendGrid's Signed Event
 * Webhook, and the event-shape normalization every downstream consumer relies
 * on (src/server/providers/sendgrid.ts:99).
 */

import crypto from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'

import { SendGridProvider } from '../../src/server/providers/sendgrid.js'

const API_KEY = 'SG.not-a-real-key-nothing-here-touches-the-network'

let publicKeyPem: string
let privateKey: crypto.KeyObject

beforeAll(() => {
  // SendGrid signs with ECDSA P-256; mint an equivalent pair locally.
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  privateKey = pair.privateKey
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
})

function sign(timestamp: string, body: Buffer): string {
  const signer = crypto.createSign('sha256')
  signer.update(Buffer.concat([Buffer.from(timestamp, 'utf8'), body]))
  return signer.sign(privateKey, 'base64')
}

const SIG_HEADER = 'x-twilio-email-event-webhook-signature'
const TS_HEADER = 'x-twilio-email-event-webhook-timestamp'

/**
 * Unix-seconds timestamp `offsetSeconds` away from now. Signature verification
 * now also enforces a replay window, so these tests have to sign against the
 * real clock rather than a frozen constant.
 */
function ts(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds)
}

describe('verifyWebhook', () => {
  it('accepts a correctly signed payload', async () => {
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })
    const body = Buffer.from(JSON.stringify([{ event: 'delivered' }]))
    const t = ts()

    expect(await provider.verifyWebhook(body, { [TS_HEADER]: t, [SIG_HEADER]: sign(t, body) })).toBe(true)
  })

  it('rejects a tampered body', async () => {
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })
    const body = Buffer.from(JSON.stringify([{ event: 'delivered' }]))
    const t = ts()
    const signature = sign(t, body)

    const tampered = Buffer.from(JSON.stringify([{ event: 'bounce' }]))
    expect(await provider.verifyWebhook(tampered, { [TS_HEADER]: t, [SIG_HEADER]: signature })).toBe(false)
  })

  it('rejects a replayed signature under a different timestamp', async () => {
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })
    const body = Buffer.from('[]')
    const signature = sign(ts(), body)

    expect(await provider.verifyWebhook(body, { [TS_HEADER]: ts(1), [SIG_HEADER]: signature })).toBe(false)
  })

  it('rejects when the signature or timestamp header is missing', async () => {
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })
    const body = Buffer.from('[]')
    const t = ts()
    const signature = sign(t, body)

    expect(await provider.verifyWebhook(body, { [TS_HEADER]: t })).toBe(false)
    expect(await provider.verifyWebhook(body, { [SIG_HEADER]: signature })).toBe(false)
  })

  it('rejects everything when no verification key is configured', async () => {
    // Fail closed: an unconfigured key must never mean "trust the caller".
    const provider = new SendGridProvider({ apiKey: API_KEY })
    const body = Buffer.from('[]')
    const t = ts()

    expect(
      await provider.verifyWebhook(body, {
        [TS_HEADER]: t,
        [SIG_HEADER]: sign(t, body),
      }),
    ).toBe(false)
  })

  it('rejects garbage rather than throwing', async () => {
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })
    expect(
      await provider.verifyWebhook(Buffer.from('[]'), {
        [TS_HEADER]: ts(),
        [SIG_HEADER]: 'not-base64-!!!',
      }),
    ).toBe(false)
  })
})

describe('verifyWebhook replay window', () => {
  const body = Buffer.from(JSON.stringify([{ event: 'delivered' }]))

  function signedHeaders(offsetSeconds: number): Record<string, string> {
    const t = ts(offsetSeconds)
    return { [TS_HEADER]: t, [SIG_HEADER]: sign(t, body) }
  }

  it('accepts a valid signature inside the default window', async () => {
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })

    expect(await provider.verifyWebhook(body, signedHeaders(0))).toBe(true)
    // Still fresh at four minutes — the default window is five.
    expect(await provider.verifyWebhook(body, signedHeaders(-240))).toBe(true)
  })

  it('rejects a valid signature whose timestamp is stale', async () => {
    // The replay case: signature is genuine, the request is an hour old.
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })

    expect(await provider.verifyWebhook(body, signedHeaders(-3600))).toBe(false)
    // Just past the 300s default.
    expect(await provider.verifyWebhook(body, signedHeaders(-301))).toBe(false)
  })

  it('rejects a valid signature dated implausibly far in the future', async () => {
    // Skew cuts both ways; a far-future timestamp would otherwise buy an
    // attacker an arbitrarily long replay window.
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })

    expect(await provider.verifyWebhook(body, signedHeaders(3600))).toBe(false)
    expect(await provider.verifyWebhook(body, signedHeaders(301))).toBe(false)
  })

  it('honours a widened tolerance', async () => {
    const provider = new SendGridProvider({
      apiKey: API_KEY,
      webhookVerificationKey: publicKeyPem,
      webhookToleranceSeconds: 7200,
    })

    expect(await provider.verifyWebhook(body, signedHeaders(-3600))).toBe(true)
    expect(await provider.verifyWebhook(body, signedHeaders(-7201))).toBe(false)
  })

  it('accepts a stale payload when the tolerance is disabled', async () => {
    // Escape hatch for hosts whose proxy delays delivery past the window.
    for (const disabled of [0, false] as const) {
      const provider = new SendGridProvider({
        apiKey: API_KEY,
        webhookVerificationKey: publicKeyPem,
        webhookToleranceSeconds: disabled,
      })

      expect(await provider.verifyWebhook(body, signedHeaders(-86_400))).toBe(true)
      expect(await provider.verifyWebhook(body, signedHeaders(86_400))).toBe(true)
    }
  })

  it('still requires a valid signature when the tolerance is disabled', async () => {
    const provider = new SendGridProvider({
      apiKey: API_KEY,
      webhookVerificationKey: publicKeyPem,
      webhookToleranceSeconds: false,
    })
    const headers = signedHeaders(-86_400)

    expect(
      await provider.verifyWebhook(Buffer.from(JSON.stringify([{ event: 'bounce' }])), headers),
    ).toBe(false)
  })

  it('rejects when the timestamp header is missing entirely', async () => {
    // Nothing to bound the window with, and nothing signed — fail closed.
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })
    const t = ts()

    expect(await provider.verifyWebhook(body, { [SIG_HEADER]: sign(t, body) })).toBe(false)
  })

  it('rejects a non-numeric timestamp rather than coercing it', async () => {
    const provider = new SendGridProvider({ apiKey: API_KEY, webhookVerificationKey: publicKeyPem })

    for (const bogus of ['not-a-number', '', '1e12', ` ${ts()} `]) {
      expect(
        await provider.verifyWebhook(body, {
          [TS_HEADER]: bogus,
          [SIG_HEADER]: sign(bogus, body),
        }),
      ).toBe(false)
    }
  })
})

describe('parseWebhookEvents', () => {
  const provider = () => new SendGridProvider({ apiKey: API_KEY })

  it('maps each SendGrid event type to the normalized type', () => {
    const events = provider().parseWebhookEvents(
      [
        { event: 'delivered', sg_event_id: 'a', email: 'A@Example.com', timestamp: 1772000000 },
        { event: 'open', sg_event_id: 'b', email: 'b@example.com', timestamp: 1772000001 },
        { event: 'click', sg_event_id: 'c', email: 'c@example.com', timestamp: 1772000002, url: 'https://x.test/p' },
        { event: 'spamreport', sg_event_id: 'd', email: 'd@example.com', timestamp: 1772000003 },
        { event: 'unsubscribe', sg_event_id: 'e', email: 'e@example.com', timestamp: 1772000004 },
        { event: 'group_unsubscribe', sg_event_id: 'f', email: 'f@example.com', timestamp: 1772000005 },
        { event: 'dropped', sg_event_id: 'g', email: 'g@example.com', timestamp: 1772000006 },
      ],
    )

    expect(events.map((e) => e.type)).toEqual([
      'delivered',
      'open',
      'click',
      'spam_report',
      'unsubscribe',
      'unsubscribe',
      'bounce',
    ])
  })

  it('distinguishes hard from soft bounces', () => {
    const events = provider().parseWebhookEvents(
      [
        { event: 'bounce', type: 'bounce', sg_event_id: 'h', email: 'h@example.com', timestamp: 1772000000, reason: 'no such user' },
        { event: 'bounce', type: 'blocked', sg_event_id: 'i', email: 'i@example.com', timestamp: 1772000000, reason: 'mailbox full' },
      ],
    )

    expect(events[0]!.details.bounceType).toBe('hard')
    expect(events[0]!.details.bounceReason).toBe('no such user')
    expect(events[1]!.details.bounceType).toBe('soft')
  })

  it('lowercases the email and converts the unix timestamp', () => {
    const [event] = provider().parseWebhookEvents(
      [{ event: 'delivered', sg_event_id: 'x', email: 'MiXeD@Example.COM', timestamp: 1772000000 }],
    )

    expect(event!.email).toBe('mixed@example.com')
    expect(event!.occurredAt.toISOString()).toBe(new Date(1772000000 * 1000).toISOString())
  })

  it('drops unknown event types instead of passing them through', () => {
    const events = provider().parseWebhookEvents(
      [
        { event: 'processed', sg_event_id: 'p', email: 'p@example.com', timestamp: 1772000000 },
        { event: 'deferred', sg_event_id: 'q', email: 'q@example.com', timestamp: 1772000000 },
        { event: 'delivered', sg_event_id: 'r', email: 'r@example.com', timestamp: 1772000000 },
      ],
    )

    expect(events.map((e) => e.providerEventId)).toEqual(['r'])
  })

  it('falls back through sg_event_id → smtp-id → a synthesized id', () => {
    const events = provider().parseWebhookEvents(
      [
        { event: 'delivered', 'smtp-id': 'smtp-1', email: 'a@example.com', timestamp: 1772000000 },
        { event: 'delivered', email: 'b@example.com', timestamp: 1772000000 },
      ],
    )

    expect(events[0]!.providerEventId).toBe('smtp-1')
    expect(events[1]!.providerEventId).toBe('delivered-1772000000-b@example.com')
  })

  it('returns an empty array for a non-array payload', () => {
    expect(provider().parseWebhookEvents({ not: 'an array' })).toEqual([])
    expect(provider().parseWebhookEvents(null)).toEqual([])
  })

  it('carries click and engagement detail through', () => {
    const [event] = provider().parseWebhookEvents(
      [
        {
          event: 'click',
          sg_event_id: 'c',
          email: 'c@example.com',
          timestamp: 1772000000,
          url: 'https://x.test/pricing',
          useragent: 'Mozilla/5.0',
          ip: '203.0.113.4',
        },
      ],
    )

    expect(event!.details.clickedUrl).toBe('https://x.test/pricing')
    expect(event!.details.userAgent).toBe('Mozilla/5.0')
    expect(event!.details.ipAddress).toBe('203.0.113.4')
  })
})

describe('provider configuration', () => {
  it('defaults the send rate and honours an override', () => {
    expect(new SendGridProvider({ apiKey: API_KEY }).sendRatePerSecond).toBe(10)
    expect(new SendGridProvider({ apiKey: API_KEY, sendRatePerSecond: 50 }).sendRatePerSecond).toBe(50)
  })

  it('defaults the webhook replay window to five minutes and honours overrides', () => {
    expect(new SendGridProvider({ apiKey: API_KEY }).webhookToleranceSeconds).toBe(300)
    expect(
      new SendGridProvider({ apiKey: API_KEY, webhookToleranceSeconds: 60 }).webhookToleranceSeconds,
    ).toBe(60)
    expect(
      new SendGridProvider({ apiKey: API_KEY, webhookToleranceSeconds: false }).webhookToleranceSeconds,
    ).toBe(0)
  })

  it('identifies itself as sendgrid', () => {
    expect(new SendGridProvider({ apiKey: API_KEY }).name).toBe('sendgrid')
  })
})
