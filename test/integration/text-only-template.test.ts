/**
 * `bodyFormat: 'text_only'` — send the text part alone, no HTML at all.
 *
 * For mail that should read as if a person typed it. The trade is deliberate
 * and total: the open pixel needs an HTML part to live in, and click rewriting
 * would put opaque redirect URLs into text a recipient reads literally, so a
 * text_only send reports no opens and no clicks. These tests pin both halves —
 * that no HTML goes on the wire, and that multipart is unaffected.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer()
  const { mailer } = H
  await H.seedContact({ externalId: 't1', email: 'text@example.com', tags: [], fields: { firstName: 'Tess' } })
  await H.seedContact({ externalId: 't2', email: 'html@example.com', tags: [], fields: { firstName: 'Hugh' } })

  await H.seedTemplate({
    slug: 'plain-note',
    subject: 'A note',
    html: '<p>Hi {{contact.fields.firstName}} — see <a href="https://example.com/x">the report</a>.</p>',
    bodyFormat: 'text_only',
    trackOpens: true,
    trackClicks: true,
  })
  await H.seedTemplate({
    slug: 'rich-note',
    subject: 'A note',
    html: '<p>Hi {{contact.fields.firstName}} — see <a href="https://example.com/x">the report</a>.</p>',
    trackOpens: true,
    trackClicks: true,
  })

  await H.seedFlow({ slug: 'text-flow', eventName: 'Text Started', steps: [step.send('plain-note')] })
  await H.seedFlow({ slug: 'html-flow', eventName: 'Html Started', steps: [step.send('rich-note')] })
  mailer.registerEvent({ name: 'Text Started', dedupePolicy: 'once-per-contact' })
  mailer.registerEvent({ name: 'Html Started', dedupePolicy: 'once-per-contact' })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('text_only templates', () => {
  it('sends no HTML part and records no trackable links', async () => {
    const { mailer, provider } = H
    await mailer.fire('Text Started', 't1')
    await H.drain()

    const sent = provider.sent.find((m: any) => m.to === 'text@example.com')
    expect(sent).toBeTruthy()
    expect(sent!.text).toContain('Tess')
    // The whole point: nothing HTML on the wire.
    expect(sent!.html).toBeUndefined()

    const send = await mailer.collections.sends.findOne({ externalId: 't1' })
    expect(send?.status).toBe('sent')
    // trackClicks is on for this template, but text_only skips rewriting —
    // so no link rows, and the text keeps the real URL.
    expect(send?.links ?? []).toHaveLength(0)
    expect(sent!.text).toContain('https://example.com/x')
    expect(sent!.text).not.toContain('/m/click/')
  })

  it('leaves multipart templates untouched', async () => {
    const { mailer, provider } = H
    await mailer.fire('Html Started', 't2')
    await H.drain()

    const sent = provider.sent.find((m: any) => m.to === 'html@example.com')
    expect(sent).toBeTruthy()
    expect(sent!.html).toBeTruthy()
    expect(sent!.text).toBeTruthy()

    const send = await mailer.collections.sends.findOne({ externalId: 't2' })
    // Tracking still applies: the link is rewritten and recorded.
    expect(send?.links?.length).toBeGreaterThan(0)
    expect(sent!.html).toContain('/m/click/')
  })
})
