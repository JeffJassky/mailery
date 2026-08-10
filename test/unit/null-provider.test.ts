/**
 * NullProvider — the in-memory provider used by tests, the test harness and
 * local dev (src/server/providers/null.ts).
 *
 * The send half is trivially assertable. The inbound half matters more than it
 * looks: `verifyWebhook` guards the public webhook route, and this provider
 * holds no signing key, so it can never establish that a payload is authentic.
 * It must therefore fail closed — otherwise any unsigned body posted to the
 * webhook route is treated as genuine in exactly the dev/staging setups where
 * that is easiest to miss.
 *
 * The webhook cases go through the `MailProvider` interface rather than the
 * concrete class, because the route calls it that way — with a raw body and
 * headers — even though this implementation ignores both.
 */

import { describe, it, expect } from 'vitest'

import { NullProvider } from '../../src/server/providers/null.js'
import type { MailProvider, SendArgs } from '../../src/shared/types.js'

describe('NullProvider.verifyWebhook', () => {
  it('fails closed on an unsigned payload', async () => {
    const provider: MailProvider = new NullProvider()
    expect(await provider.verifyWebhook(Buffer.from('[]'), {})).toBe(false)
  })

  it('fails closed even when the request carries signature-looking headers', async () => {
    const provider: MailProvider = new NullProvider()
    const headers = {
      'x-twilio-email-event-webhook-signature': 'not-a-real-signature',
      'x-twilio-email-event-webhook-timestamp': '1772000000',
    }
    expect(await provider.verifyWebhook(Buffer.from('[{"event":"bounce"}]'), headers)).toBe(false)
  })

  it('never throws — the public router turns a throw into a 500', async () => {
    const provider: MailProvider = new NullProvider()
    await expect(provider.verifyWebhook(Buffer.alloc(0), {})).resolves.toBe(false)
  })

  it('parses no events, so there is no inbound behaviour to preserve', () => {
    const provider: MailProvider = new NullProvider()
    expect(provider.parseWebhookEvents('[{"event":"bounce"}]', {})).toEqual([])
  })
})

describe('NullProvider.send', () => {
  it('records sends without dispatching, and reset() clears them', async () => {
    const provider = new NullProvider()
    const args: SendArgs = {
      to: 'someone@example.com',
      fromName: 'Example',
      fromEmail: 'hello@example.com',
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
    }

    const result = await provider.send(args)
    expect(result.status).toBe('accepted')
    expect(result.providerId).toMatch(/^null-/)
    expect(provider.sent).toEqual([args])

    provider.reset()
    expect(provider.sent).toEqual([])
  })
})
