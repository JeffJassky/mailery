/**
 * Delivered-mail assertions — the handful of things only a real inbox can
 * settle. Requires MAILERY_LIVE_E2E=deliver plus Gmail IMAP credentials;
 * skipped in sandbox mode, where nothing is ever delivered.
 *
 * Deliberately small. What lives here is exactly what a recording provider
 * cannot answer:
 *   - did BOTH body parts survive as a multipart/alternative
 *   - did our custom headers survive the provider
 *   - did SendGrid leave our links and unsubscribe URL alone (we do our own
 *     tracking — src/server/providers/sendgrid.ts:55 disables theirs)
 *   - does a unicode subject decode back to what we wrote
 *
 * Caveat: Gmail proxies remote images, so a delivered message may self-trigger
 * the open pixel. Never assert `openCount === 0` after a live delivery.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { DELIVERS, liveFromEmail, REDIS_URL } from './gate.js'
import { newToken, taggedAddress, waitForMessage, describeChecks } from './inbox.js'

describe.skipIf(!DELIVERS)('delivered mail', () => {
  let H: TestMailerHarness

  beforeAll(async () => {
    H = await createTestMailer({
      provider: 'sendgrid',
      ...(REDIS_URL
        ? { queue: { driver: 'bull' as const, redis: { url: REDIS_URL } }, startWorkers: true }
        : {}),
      config: { fromDefaults: { name: 'Mailery Live', email: liveFromEmail() } },
    })
  }, 120_000)

  afterAll(async () => {
    if (H) await H.stop()
  })

  it('arrives with both body parts, intact headers and unrewritten links', async () => {
    const token = newToken()
    const to = taggedAddress(token)

    await H.seedContact({ externalId: 'd1', email: to, tags: [], fields: { firstName: 'Delivered' } })
    await H.seedTemplate({
      slug: 'delivery-tpl',
      subject: `mailery delivery ünïcode ✉️ ${token}`,
      fromEmail: liveFromEmail(),
      fromName: 'Mailery Live',
      html:
        '<html><body><p>Hello {{contact.fields.firstName}}</p>' +
        describeChecks({
          title: 'full delivery path',
          token,
          checks: [
            'multipart/alternative — both an HTML and a plain-text part arrive',
            'unicode in the subject line round-trips (ünïcode ✉️)',
            'List-Unsubscribe and List-Unsubscribe-Post headers survive SendGrid',
            'our own click tracking is applied (the Pricing link below points at /m/click/)',
            "the provider's own click tracking is NOT layered on top — every href points at our domain",
            'the unsubscribe link is never rewritten by either party',
            'the open-tracking pixel (/m/open/<sendId>.png) is present',
            'Handlebars variables were substituted (the greeting above says Delivered)',
          ],
        }) +
        '<p><a href="https://example.com/pricing">Pricing</a></p>' +
        '<p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p></body></html>',
      trackOpens: true,
      trackClicks: true,
    })
    await H.seedFlow({ slug: 'delivery-flow', eventName: 'Deliver', steps: [step.send('delivery-tpl')] })
    H.mailer.registerEvent({ name: 'Deliver', dedupePolicy: 'every-time' })

    await H.mailer.fire('Deliver', 'd1')
    if (!REDIS_URL) await H.drain()

    const send = await H.ctx.collections.sends.findOne({ externalId: 'd1' })
    expect(send?.status, send?.errorMessage ?? '').toBe('sent')

    const msg = await waitForMessage(token, { timeoutMs: 180_000 })

    // Both parts present — the assertion no mock can make.
    expect(msg.isMultipartAlternative, 'expected a multipart/alternative').toBe(true)
    expect(msg.html).toContain('Hello Delivered')
    expect(msg.text).toContain('Hello Delivered')

    // Unicode subject round-trips through RFC 2047 encoding.
    expect(msg.subject).toContain('ünïcode ✉️')
    expect(msg.subject).toContain(token)

    // ...and multi-byte characters in the BODY survive quoted-printable
    // transfer encoding. Mojibake here ("Ã¼nÃ¯code") means the round trip is
    // broken somewhere between render and inbox.
    expect(msg.html).toContain('ünïcode ✉️')
    expect(msg.html).not.toContain('Ã¼')

    // Our one-click unsubscribe headers survived the provider.
    expect(msg.headers['list-unsubscribe']).toMatch(/m\/unsub\//)
    expect(msg.headers['list-unsubscribe-post']).toContain('One-Click')

    // Our own click tracking is present and SendGrid's is NOT layered on top.
    // Asserted against href targets rather than the raw body: the body prose
    // legitimately mentions provider domains, and a substring check over the
    // whole document would match that instead of a real rewrite.
    expect(msg.html).toContain('/m/click/')
    expect(msg.html).not.toMatch(/href="[^"]*sendgrid\.net/i)
    expect(msg.html).not.toMatch(/href="[^"]*sendgrid\.com/i)

    // The unsubscribe link is never rewritten, by us or by them.
    expect(msg.html).toMatch(/href="[^"]*\/m\/unsub\//)

    // Our open pixel made it through.
    expect(msg.html).toContain(`/m/open/${String(send!._id)}.png`)
  }, 300_000)

  it('a plain-text-only template still arrives readable', async () => {
    const token = newToken()
    const to = taggedAddress(token)

    await H.seedContact({ externalId: 'd2', email: to, tags: [], fields: { firstName: 'Plain' } })
    await H.seedTemplate({
      slug: 'plain-tpl',
      subject: `mailery plain ${token}`,
      fromEmail: liveFromEmail(),
      fromName: 'Mailery Live',
      text:
        'Hi {{contact.fields.firstName}}, this is the body. ' +
        'mailery live test — explicit plain-text override. This email checks that ' +
        'a template supplying its own plainText delivers THAT text as the text/plain ' +
        'part (not text auto-derived from the HTML), that the override is itself ' +
        'run through Handlebars, and that the HTML part is unaffected. ' +
        `Correlation token: ${token}`,
      plainText:
        'Hi {{contact.fields.firstName}}, TEXT PART.\n\n' +
        'mailery live test — explicit plain-text override.\n' +
        'This is the template\'s own plainText, not text derived from the HTML.\n' +
        'If you are reading this as the text alternative, the override worked.\n' +
        `Correlation token: ${token}\n`,
    })
    await H.seedFlow({ slug: 'plain-flow', eventName: 'DeliverPlain', steps: [step.send('plain-tpl')] })
    H.mailer.registerEvent({ name: 'DeliverPlain', dedupePolicy: 'every-time' })

    await H.mailer.fire('DeliverPlain', 'd2')
    if (!REDIS_URL) await H.drain()

    const msg = await waitForMessage(token, { timeoutMs: 180_000 })
    expect(msg.text).toContain('TEXT PART')
    expect(msg.html).toContain('this is the body')
  }, 300_000)
})
