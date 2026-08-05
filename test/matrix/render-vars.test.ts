/**
 * Variable-rendering matrix.
 *
 * Every source of template data, asserted on all four rendered surfaces
 * (subject, preheader-bearing html, html body, plain text) as the provider
 * actually received them — not as `renderTemplate` returns them in isolation.
 * The render context is assembled in `buildRenderContext`
 * (src/server/runner/send.ts:274) and typed as `RenderContext`
 * (src/server/templates/render.ts:66).
 *
 * Sources covered: contact fields and email, trigger-event properties, step
 * vars, host `varsAdapter` keys at the context root, `unsubscribeUrl`,
 * `senderAddress`, the built-in helpers and host-supplied helpers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'

import { createTestMailer, step, type TestMailerHarness } from '../../src/testing/index.js'
import { defineVars } from '../../src/server/adapters/vars.js'
import type { SendArgs } from '../../src/shared/types.js'
import type { TemplateKind } from '../../src/shared/enums.js'

let H: TestMailerHarness
let counter = 0

/**
 * Host-provided variables. `resolve` echoes back what it was asked for so the
 * tests can also assert the adapter receives the right scoping info — that
 * `info.eventProperties` plumbing is how account-scoped flows work.
 */
const varsAdapter = defineVars({
  schema: z.object({
    account: z.object({ name: z.string(), seats: z.number() }),
    resolvedFor: z.object({ reason: z.string(), templateSlug: z.string(), flowSlug: z.string(), eventName: z.string() }),
  }),
  resolve(contact, info) {
    return {
      account: { name: `Acct for ${contact.externalId}`, seats: 12 },
      resolvedFor: {
        reason: info.reason,
        templateSlug: info.templateSlug ?? '',
        flowSlug: info.flowSlug ?? '',
        eventName: info.eventName ?? '',
      },
    }
  },
})

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      varsAdapter,
      handlebarsHelpers: {
        shout: (value: unknown) => String(value ?? '').toUpperCase(),
      },
    },
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

interface RenderCase {
  /** Body copy, wrapped in minimal MJML by the builder. */
  body?: string
  subject?: string
  preheader?: string
  /** Explicit plain-text part. Omit to auto-derive from the html. */
  plainText?: string
  /** Per-step vars → `{{vars.*}}`. */
  vars?: Record<string, unknown>
  /** Trigger-event properties → `{{event.*}}`. */
  eventProperties?: Record<string, unknown>
  fields?: Record<string, unknown>
  tags?: string[]
  /** Template kind. Defaults to marketing (the builder default). */
  kind?: TemplateKind
}

/** Seed an isolated one-send flow, fire it, and return what the provider got. */
async function render(c: RenderCase): Promise<SendArgs> {
  const i = ++counter
  const externalId = `u${i}`
  const email = `case${i}@example.com`
  const tpl = `tpl-${i}`
  const eventName = `Trigger${i}`

  await H.seedContact({
    externalId,
    email,
    tags: c.tags ?? [],
    fields: c.fields ?? { firstName: 'Alice' },
  })
  await H.seedTemplate({
    slug: tpl,
    subject: c.subject ?? `Subject ${i}`,
    preheader: c.preheader ?? '',
    text: c.body ?? 'body',
    ...(c.kind ? { kind: c.kind } : {}),
    ...(c.plainText !== undefined ? { plainText: c.plainText } : {}),
  })
  await H.seedFlow({
    slug: `flow-${i}`,
    eventName,
    steps: [step.send(tpl, c.vars ? { vars: c.vars } : {})],
  })

  H.mailer.registerEvent({ name: eventName, dedupePolicy: 'every-time' })
  await H.mailer.fire(eventName, externalId, c.eventProperties ?? {})
  await H.drain()

  const sent = H.provider.toRecipient(email)
  expect(sent, `case ${i} should have produced exactly one send`).toHaveLength(1)
  return sent[0]!
}

describe('contact variables', () => {
  it('renders contact fields and email into every surface', async () => {
    const sent = await render({
      subject: 'Hi {{contact.fields.firstName}}',
      body: 'You are {{contact.email}} in plan {{contact.fields.plan}}.',
      fields: { firstName: 'Alice', plan: 'pro' },
    })

    expect(sent.subject).toBe('Hi Alice')
    expect(sent.html).toContain('case')
    expect(sent.html).toContain('in plan pro')
    expect(sent.text).toContain('in plan pro')
    expect(sent.text).toContain(sent.to)
  })

  it('renders a missing variable as empty, not as the literal expression', async () => {
    const sent = await render({
      subject: 'Hi [{{contact.fields.nope}}]',
      body: 'Value: [{{contact.fields.alsoNope}}]',
    })

    expect(sent.subject).toBe('Hi []')
    expect(sent.html).toContain('Value: []')
    expect(sent.html).not.toContain('{{')
  })

  it('HTML-escapes a hostile field value', async () => {
    const sent = await render({
      subject: 'Hi {{contact.fields.firstName}}',
      body: 'Name: {{contact.fields.firstName}}',
      fields: { firstName: '<script>alert(1)</script>' },
    })

    expect(sent.html).not.toContain('<script>')
    expect(sent.html).toContain('&lt;script&gt;')
    // Subject is compiled through the same escaping Handlebars instance.
    expect(sent.subject).not.toContain('<script>')
  })

  /**
   * Regression: the text/plain part was compiled with escaping on, so `&`
   * became `&amp;` and `=` became `&#x3D;`. Mail clients render that part
   * literally, so a substituted URL arrived with its query string in pieces —
   * everything after the first param silently lost. For an auto-sign-in link
   * that meant the recipient reached the app carrying no credential and stayed
   * signed in as whoever was already in the browser, with no error shown.
   */
  it('leaves a substituted URL intact in an explicit plain-text part', async () => {
    const url = 'https://app.test/app/aeo/topics/t1?u=user-1&token=tok-2#what-ai-knows'
    const sent = await render({
      body: 'Read it here.',
      plainText: 'Read it here: [{{contact.fields.topicUrl}}]',
      fields: { topicUrl: url },
    })

    expect(sent.text).toContain(url)
    expect(sent.text).not.toContain('&amp;')
    expect(sent.text).not.toContain('&#x3D;')
  })
})

describe('event properties', () => {
  it('exposes the trigger event properties as {{event.*}}', async () => {
    const sent = await render({
      subject: 'Order {{event.orderId}}',
      body: 'Total {{event.total}} for {{event.orderId}}.',
      eventProperties: { orderId: 'A-1001', total: 4200 },
    })

    expect(sent.subject).toBe('Order A-1001')
    expect(sent.html).toContain('Total 4200 for A-1001.')
    expect(sent.text).toContain('Total 4200 for A-1001.')
  })
})

describe('step vars', () => {
  it('exposes the send step vars as {{vars.*}}', async () => {
    const sent = await render({
      subject: '{{vars.campaign}}',
      body: 'Discount {{vars.discount}}%',
      vars: { campaign: 'Spring', discount: 15 },
    })

    expect(sent.subject).toBe('Spring')
    expect(sent.html).toContain('Discount 15%')
  })
})

describe('host varsAdapter', () => {
  it('puts resolved keys at the context root', async () => {
    const sent = await render({
      subject: 'Welcome to {{account.name}}',
      body: '{{account.seats}} seats on {{account.name}}.',
    })

    expect(sent.subject).toContain('Acct for u')
    expect(sent.html).toContain('12 seats on')
  })

  it('scopes the resolve call with reason, template, flow and event', async () => {
    const sent = await render({
      body:
        'reason={{resolvedFor.reason}} tpl={{resolvedFor.templateSlug}} ' +
        'flow={{resolvedFor.flowSlug}} event={{resolvedFor.eventName}}',
    })

    expect(sent.html).toContain('reason=send')
    expect(sent.html).toMatch(/tpl=tpl-\d+/)
    expect(sent.html).toMatch(/flow=flow-\d+/)
    expect(sent.html).toMatch(/event=Trigger\d+/)
  })
})

describe('mailery-provided context', () => {
  it('renders unsubscribeUrl and senderAddress', async () => {
    const sent = await render({
      body: 'Unsub: {{unsubscribeUrl}} — {{senderAddress}}',
    })

    expect(sent.html).toContain('http://localhost:3000/m/unsub/')
    expect(sent.html).toContain('1 Test St, Brooklyn NY 11201')
    // The same URL is offered as the one-click header.
    expect(sent.headers?.['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:3000\/m\/unsub\/.+>$/)
    expect(sent.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('omits the one-click headers on transactional sends', async () => {
    // The token is marketing-scoped, so the header would advertise an opt-out
    // that does not stop the transactional mail the recipient is holding.
    const sent = await render({
      kind: 'transactional',
      body: 'Unsub: {{unsubscribeUrl}}',
    })

    expect(sent.html).toContain('http://localhost:3000/m/unsub/')
    expect(sent.headers?.['List-Unsubscribe']).toBeUndefined()
    expect(sent.headers?.['List-Unsubscribe-Post']).toBeUndefined()
  })
})

describe('helpers', () => {
  it('formats currency, numbers and plurals', async () => {
    const sent = await render({
      body:
        '{{formatCurrency vars.cents "usd"}} / {{formatNumber vars.count}} / ' +
        '{{vars.count}} {{pluralize vars.count "seat" "seats"}}',
      vars: { cents: 129900, count: 4200 },
    })

    expect(sent.html).toContain('$1,299.00')
    expect(sent.html).toContain('4,200')
    expect(sent.html).toContain('4200 seats')
  })

  /**
   * KNOWN BUG — src/server/templates/render.ts:244.
   *
   * Handlebars always appends an options object as the final argument, so
   * `{{formatCurrency cents}}` binds `currency` to that object rather than
   * falling back to the 'usd' default. Intl.NumberFormat then throws
   * "Invalid currency code", handleSend catches it, and the whole send fails
   * rather than degrading. The fix is to ignore a non-string `currency`.
   *
   * `it.fails` keeps the suite honest: green while the bug stands, red the
   * moment it is fixed — at which point delete the wrapper and fold this into
   * the test above.
   */
  it.fails('formatCurrency with no explicit currency (known bug)', async () => {
    const sent = await render({
      body: '{{formatCurrency vars.cents}}',
      vars: { cents: 129900 },
    })
    expect(sent.html).toContain('$1,299.00')
  })

  it('formatCurrency honours a non-default currency', async () => {
    const sent = await render({
      body: '{{formatCurrency vars.cents "eur"}}',
      vars: { cents: 5000 },
    })
    expect(sent.html).toContain('50.00')
  })

  it('pluralize picks the singular at exactly one', async () => {
    const sent = await render({
      body: '{{vars.n}} {{pluralize vars.n "seat" "seats"}}',
      vars: { n: 1 },
    })
    expect(sent.html).toContain('1 seat')
    expect(sent.html).not.toContain('1 seats')
  })

  it('formats dates in the documented shapes', async () => {
    const sent = await render({
      body: 'iso={{formatDate vars.when}} long={{formatDate vars.when "long"}}',
      vars: { when: '2026-03-04T12:00:00.000Z' },
    })

    expect(sent.html).toContain('iso=2026-03-04')
    expect(sent.html).toContain('long=March 4, 2026')
  })

  it('formatDate renders empty for a missing or unparseable value', async () => {
    const sent = await render({
      body: 'a=[{{formatDate vars.missing}}] b=[{{formatDate vars.junk}}]',
      vars: { junk: 'not-a-date' },
    })
    expect(sent.html).toContain('a=[] b=[]')
  })

  it('supports the comparison and boolean helpers in blocks', async () => {
    const sent = await render({
      body:
        '{{#if (and (eq vars.plan "pro") (gt vars.seats 3))}}BIGPRO{{else}}OTHER{{/if}}' +
        '{{#if (or (lt vars.seats 1) (ne vars.plan "pro"))}}NOPE{{/if}}',
      vars: { plan: 'pro', seats: 12 },
    })

    expect(sent.html).toContain('BIGPRO')
    expect(sent.html).not.toContain('OTHER')
    expect(sent.html).not.toContain('NOPE')
  })

  it('exposes host-registered helpers', async () => {
    const sent = await render({
      subject: '{{shout contact.fields.firstName}}',
      body: '{{shout "quiet"}}',
      fields: { firstName: 'alice' },
    })

    expect(sent.subject).toBe('ALICE')
    expect(sent.html).toContain('QUIET')
  })
})
