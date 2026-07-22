/**
 * HTML / plain-text matrix — the two body parts and what tracking does to them.
 *
 * Pipeline under test (src/server/templates/render.ts:1):
 *   MJML → compiled HTML → Handlebars → plain text derived → applyTracking
 *
 * Order matters and is asserted here: plain text is derived from the UNTRACKED
 * html, so the open pixel and rewritten links must never appear in the text
 * part. `applyTracking` runs in `dispatchSend` (src/server/runner/send.ts:184)
 * because it needs the persisted send id.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { defineVars } from '../../src/server/adapters/vars.js'
import type { SendArgs } from '../../src/shared/types.js'
import type { SendDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness
let counter = 0

const varsAdapter = defineVars({
  schema: z.object({ account: z.object({ name: z.string() }) }),
  resolve: () => ({ account: { name: 'Globex' } }),
})

beforeAll(async () => {
  H = await createTestMailer({ config: { varsAdapter } })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

interface BodyCase {
  body?: string
  html?: string
  subject?: string
  plainText?: string
  trackOpens?: boolean
  trackClicks?: boolean
  /** Stop before dispatch so the queued send row can be inspected. */
  dispatch?: boolean
}

interface Rendered {
  sent: SendArgs | null
  send: SendDoc
  email: string
  dispatch: () => Promise<void>
  latest: () => Promise<SendDoc>
  sentArgs: () => SendArgs | null
}

async function renderCase(c: BodyCase): Promise<Rendered> {
  const i = ++counter
  const externalId = `u${i}`
  const email = `case${i}@example.com`
  const tpl = `tpl-${i}`
  const eventName = `Trigger${i}`

  await H.seedContact({ externalId, email, tags: [], fields: { firstName: 'Alice' } })
  await H.seedTemplate({
    slug: tpl,
    subject: c.subject ?? `Subject ${i}`,
    ...(c.html ? { html: c.html } : { text: c.body ?? 'body' }),
    ...(c.plainText !== undefined ? { plainText: c.plainText } : {}),
    trackOpens: c.trackOpens ?? false,
    trackClicks: c.trackClicks ?? false,
  })
  await H.seedFlow({ slug: `flow-${i}`, eventName, steps: [step.send(tpl)] })

  H.mailer.registerEvent({ name: eventName, dedupePolicy: 'every-time' })
  await H.mailer.fire(eventName, externalId)
  await H.drain({ dispatch: c.dispatch !== false })

  const send = (await H.ctx.collections.sends.find({ externalId }).toArray())[0]!
  const sentArgs = () => H.provider.toRecipient(email)[0] ?? null

  return {
    sent: sentArgs(),
    send,
    email,
    sentArgs,
    latest: async () => (await H.ctx.collections.sends.find({ externalId }).toArray())[0]!,
    dispatch: async () => {
      await H.drain()
    },
  }
}

describe('plain-text part', () => {
  it('is auto-derived from the html and carries substituted values', async () => {
    const r = await renderCase({ body: 'Hello {{contact.fields.firstName}}, welcome.' })
    expect(r.sent!.html).toContain('Hello Alice, welcome.')
    expect(r.sent!.text).toContain('Hello Alice, welcome.')
    expect(r.sent!.text).not.toContain('<div')
  })

  it('an explicit plainText override is itself Handlebars-rendered', async () => {
    const r = await renderCase({
      body: 'HTML body for {{contact.fields.firstName}}',
      plainText: 'TEXT ONLY for {{contact.fields.firstName}} <{{contact.email}}>',
    })

    expect(r.sent!.text).toContain('TEXT ONLY for Alice')
    expect(r.sent!.text).toContain(r.email)
    expect(r.sent!.text).not.toContain('HTML body')
    expect(r.sent!.html).toContain('HTML body for Alice')
  })

  it('drops images and collapses links whose text equals the href', async () => {
    const r = await renderCase({
      html:
        '<html><body><p>Docs: <a href="https://example.com/docs">https://example.com/docs</a></p>' +
        '<img src="https://example.com/logo.png" alt="Logo" /></body></html>',
    })

    expect(r.sent!.text).toContain('https://example.com/docs')
    // hideLinkHrefIfSameAsText — the URL appears once, not as "text [url]".
    expect(r.sent!.text).not.toContain('[https://example.com/docs]')
    // Images are dropped outright — neither the src nor the alt text survives.
    expect(r.sent!.text).not.toContain('logo.png')
    expect(r.sent!.text).not.toContain('Logo')
  })
})

describe('tracking', () => {
  it('adds the open pixel to html only', async () => {
    const r = await renderCase({ body: 'Hi there', trackOpens: true })

    expect(r.sent!.html).toContain(`/m/open/${String(r.send._id)}.png`)
    expect(r.sent!.text).not.toContain('/m/open/')
    expect(r.sent!.text).not.toContain('.png')
  })

  it('rewrites links and records the linkId → url map on the send', async () => {
    const r = await renderCase({
      html: '<html><body><a href="https://example.com/pricing">Pricing</a></body></html>',
      trackClicks: true,
    })

    const send = await r.latest()
    expect(send.links).toHaveLength(1)
    expect(send.links[0]!.url).toBe('https://example.com/pricing')

    const linkId = send.links[0]!.linkId
    expect(r.sent!.html).toContain(`/m/click/${String(send._id)}/${linkId}`)
    expect(r.sent!.html).not.toContain('href="https://example.com/pricing"')
    // The text part is derived pre-tracking and keeps the real destination.
    expect(r.sent!.text).toContain('https://example.com/pricing')
  })

  it('never rewrites the unsubscribe URL', async () => {
    const r = await renderCase({
      html: '<html><body><a href="{{unsubscribeUrl}}">Unsubscribe</a>' +
        '<a href="https://example.com/other">Other</a></body></html>',
      trackClicks: true,
    })

    const send = await r.latest()
    expect(send.links.map((l) => l.url)).toEqual(['https://example.com/other'])
    expect(r.sent!.html).toContain('http://localhost:3000/m/unsub/')
    expect(r.sent!.html).not.toMatch(/m\/click\/[a-f0-9]+\/[a-f0-9]+"[^>]*>Unsubscribe/)
  })

  it('leaves mailto:, tel: and anchor links alone', async () => {
    const r = await renderCase({
      html:
        '<html><body><a href="mailto:hi@example.com">Mail</a>' +
        '<a href="tel:+15551234">Call</a><a href="#top">Top</a></body></html>',
      trackClicks: true,
    })

    expect((await r.latest()).links).toHaveLength(0)
    expect(r.sent!.html).toContain('mailto:hi@example.com')
    expect(r.sent!.html).toContain('tel:+15551234')
    expect(r.sent!.html).toContain('#top')
  })

  it('honours data-mailer-notrack', async () => {
    const r = await renderCase({
      html:
        '<html><body><a href="https://example.com/a" data-mailer-notrack="true">A</a>' +
        '<a href="https://example.com/b">B</a></body></html>',
      trackClicks: true,
    })

    expect((await r.latest()).links.map((l) => l.url)).toEqual(['https://example.com/b'])
    expect(r.sent!.html).toContain('href="https://example.com/a"')
  })

  it('adds neither artifact when both flags are off', async () => {
    const r = await renderCase({
      html: '<html><body><a href="https://example.com/x">X</a></body></html>',
      trackOpens: false,
      trackClicks: false,
    })

    expect(r.sent!.html).toContain('href="https://example.com/x"')
    expect(r.sent!.html).not.toContain('/m/click/')
    expect(r.sent!.html).not.toContain('/m/open/')
    expect((await r.latest()).links).toHaveLength(0)
  })
})

describe('the two-render pipeline', () => {
  /**
   * `handleSend` renders once to populate the send row (src/server/runner/send.ts:54)
   * WITHOUT host vars, then `dispatchSend` re-renders with them (:176) so the
   * mail reflects host state at dispatch, not at flow entry. The queued row
   * therefore carries an incomplete subject until dispatch overwrites it (:200).
   * That gap is visible in the admin UI, so pin it.
   */
  it('the queued row lacks varsAdapter values; dispatch fills them in', async () => {
    const r = await renderCase({
      subject: 'Welcome to [{{account.name}}]',
      body: 'Hi',
      dispatch: false, // stop after handleSend
    })

    expect(r.send.status).toBe('queued')
    expect(r.send.subject).toBe('Welcome to []')
    expect(r.sentArgs()).toBeNull()

    await r.dispatch()

    expect(r.sentArgs()!.subject).toBe('Welcome to [Globex]')
    expect((await r.latest()).subject).toBe('Welcome to [Globex]')
  })

  it('re-renders against the contact as it is at dispatch, not at flow entry', async () => {
    const r = await renderCase({
      subject: 'Hi {{contact.fields.firstName}}',
      body: 'Hello {{contact.fields.firstName}}',
      dispatch: false,
    })
    expect(r.send.subject).toBe('Hi Alice')

    // Rename the contact between queueing and dispatch.
    const contact = await H.adapter.getById(r.send.externalId)
    H.memoryAdapter!.upsert({ ...contact!, fields: { ...contact!.fields, firstName: 'Alicia' } })

    await r.dispatch()

    expect(r.sentArgs()!.subject).toBe('Hi Alicia')
    expect(r.sentArgs()!.html).toContain('Hello Alicia')
  })
})
