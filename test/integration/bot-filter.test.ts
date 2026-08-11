/**
 * `hasOpenedExcludingBots` actually excludes bots (issue #2).
 *
 * Before this, `openOrClickCount`'s `opened` branch incremented and `continue`d
 * past the bot check entirely, so `hasOpenedExcludingBots` was byte-for-byte
 * `hasOpened` — an API that promises filtering and delivers none, which someone
 * eventually builds a re-engagement flow on.
 *
 * The click path had the filter but no data: nothing ever wrote
 * `clickedLinks[].userAgent`, so `!c.userAgent` was true for every click and
 * everything scored human. Opens now record a UA too (`SendDoc.opens`).
 *
 * Documented behaviour asserted here:
 *   - a UA matching the pattern is a bot
 *   - a *missing* UA is a human (see `isBotUserAgent` for why)
 *   - a send counts if ANY of its opens looks human
 *   - `minOpenDelayMs` is off unless configured
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { evaluatePredicate, DEFAULT_BOT_UA_RE } from '../../src/server/runner/predicate.js'
import type { Contact, Predicate } from '../../src/shared/types.js'
import type { FlowRunDoc } from '../../src/server/models/index.js'

let H: TestMailerHarness

const contact: Contact = { externalId: 'bot-u1', email: 'bot-u1@example.com', tags: [], fields: {} }

const run: FlowRunDoc = {
  _id: new ObjectId(),
  externalId: 'bot-u1',
  flowId: new ObjectId(),
  flowSlug: 'x',
  flowVersion: 1,
  emailAtEntry: 'bot-u1@example.com',
  enteredAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  status: 'active',
  currentStepIndex: 0,
  currentBranchPath: [],
  nextActionAt: new Date(),
  attemptsForCurrentStep: 0,
  history: [],
  exitedAt: null,
  exitReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

/** Every UA the default pattern claims to catch, one send each. */
const BOT_UAS = [
  'Mimecast-Link-Protection/1.0',
  'Mozilla/5.0 SafeLinks (Microsoft ATP)',
  'proofpoint-urldefense/2.1',
  'Mozilla/5.0 HeadlessChrome/120.0.0.0',
  'Googlebot/2.1 (+http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0)',
]

const HUMAN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36'

let seq = 0

function makeSend(opts: {
  opens?: Array<{ userAgent: string | null; agoMs?: number }>
  clickUas?: Array<string | null>
  /** Omit the `opens` array entirely — a send written before the field existed. */
  legacy?: boolean
  queuedAgoMs?: number
}) {
  const queuedAt = new Date(Date.now() - (opts.queuedAgoMs ?? 60 * 60 * 1000))
  const opens = (opts.opens ?? []).map((o) => ({
    openedAt: new Date(Date.now() - (o.agoMs ?? 30 * 60 * 1000)),
    userAgent: o.userAgent,
  }))
  const openedAt = opens.length > 0 ? opens[0]!.openedAt : opts.legacy ? new Date(Date.now() - 30 * 60 * 1000) : null
  const clicks = (opts.clickUas ?? []).map((ua) => ({
    url: 'https://example.com/x',
    linkId: 'aabbccddeeff',
    clickedAt: new Date(Date.now() - 30 * 60 * 1000),
    userAgent: ua,
  }))
  const doc: any = {
    _id: new ObjectId(),
    dedupeKey: `bot:${seq++}`,
    externalId: 'bot-u1',
    emailAtSend: 'bot-u1@example.com',
    templateId: new ObjectId(),
    templateSlug: 'botfilter',
    flowRunId: null,
    broadcastId: null,
    manualSendBy: 'test',
    kind: 'marketing',
    provider: 'null',
    providerMessageId: null,
    fromName: 'T',
    fromEmail: 't@example.com',
    subject: 'hi',
    bodyHash: '',
    status: 'sent',
    errorMessage: null,
    bounceType: null,
    bounceReason: null,
    links: [],
    vars: {},
    openedAt,
    openCount: opens.length,
    firstClickAt: clicks.length > 0 ? clicks[0]!.clickedAt : null,
    clickCount: clicks.length,
    clickedLinks: clicks,
    unsubscribedAt: null,
    complainedAt: null,
    queuedAt,
    updatedAt: new Date(),
    sentAt: queuedAt,
    deliveredAt: null,
  }
  if (!opts.legacy) doc.opens = opens
  return doc
}

const ctx = (botFilter?: any) => ({ contact, run, collections: H.mailer.collections, botFilter })

const P = {
  hasOpened: { hasOpened: {} } as unknown as Predicate,
  hasOpenedExcludingBots: { hasOpenedExcludingBots: {} } as unknown as Predicate,
  hasClickedExcludingBots: { hasClickedExcludingBots: {} } as unknown as Predicate,
}

async function openCount(botFilter?: any): Promise<boolean> {
  return await evaluatePredicate(P.hasOpenedExcludingBots, ctx(botFilter))
}

beforeAll(async () => {
  H = await createTestMailer({ seedContacts: [contact] })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

beforeEach(async () => {
  await H.mailer.collections.sends.deleteMany({ externalId: 'bot-u1' })
})

// ---------------------------------------------------------------------------
// The regression itself
// ---------------------------------------------------------------------------

describe('hasOpenedExcludingBots vs hasOpened', () => {
  it('returns a strictly lower count when bot opens are present', async () => {
    for (const ua of BOT_UAS) {
      await H.mailer.collections.sends.insertOne(makeSend({ opens: [{ userAgent: ua }] }))
    }
    await H.mailer.collections.sends.insertOne(makeSend({ opens: [{ userAgent: HUMAN_UA }] }))

    // `hasOpened` sees all 7 sends; the filtered predicate sees only the human.
    expect(await evaluatePredicate(P.hasOpened, ctx())).toBe(true)
    expect(await openCount()).toBe(true)

    expect(await evaluatePredicate({ openedAtLeastN: { count: 7 } } as unknown as Predicate, ctx())).toBe(false)
    expect(await evaluatePredicate({ openedAtLeastN: { count: 1 } } as unknown as Predicate, ctx())).toBe(true)
  })

  it('is false when every open is a bot, while hasOpened is still true', async () => {
    for (const ua of BOT_UAS) {
      await H.mailer.collections.sends.insertOne(makeSend({ opens: [{ userAgent: ua }] }))
    }
    expect(await evaluatePredicate(P.hasOpened, ctx())).toBe(true)
    expect(await openCount()).toBe(false)
  })
})

describe('each user agent in the default pattern', () => {
  it.each(BOT_UAS)('excludes %s', async (ua) => {
    expect(DEFAULT_BOT_UA_RE.test(ua)).toBe(true)
    await H.mailer.collections.sends.insertOne(makeSend({ opens: [{ userAgent: ua }] }))
    expect(await openCount()).toBe(false)
  })

  it('counts an ordinary browser user agent', async () => {
    await H.mailer.collections.sends.insertOne(makeSend({ opens: [{ userAgent: HUMAN_UA }] }))
    expect(await openCount()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The unknown-UA decision — documented, not incidental
// ---------------------------------------------------------------------------

describe('a missing user agent counts as human', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('counts an open whose UA is %s', async (_label, ua) => {
    await H.mailer.collections.sends.insertOne(makeSend({ opens: [{ userAgent: ua as any }] }))
    expect(await openCount()).toBe(true)
  })

  it('counts a send written before opens[] existed, so the fix cannot empty a running flow', async () => {
    await H.mailer.collections.sends.insertOne(makeSend({ legacy: true }))
    expect(await evaluatePredicate(P.hasOpened, ctx())).toBe(true)
    expect(await openCount()).toBe(true)
  })

  it('does the same on the click path', async () => {
    await H.mailer.collections.sends.insertOne(makeSend({ clickUas: [null] }))
    expect(await evaluatePredicate(P.hasClickedExcludingBots, ctx())).toBe(true)
  })
})

describe('a send counts when any single open looks human', () => {
  it('bot open followed by a real one still counts', async () => {
    await H.mailer.collections.sends.insertOne(
      makeSend({ opens: [{ userAgent: 'Mimecast-Link-Protection/1.0' }, { userAgent: HUMAN_UA }] }),
    )
    expect(await openCount()).toBe(true)
  })

  it('same for clicks', async () => {
    await H.mailer.collections.sends.insertOne(
      makeSend({ clickUas: ['Mozilla/5.0 SafeLinks', HUMAN_UA] }),
    )
    expect(await evaluatePredicate(P.hasClickedExcludingBots, ctx())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('botFilter.userAgentPattern', () => {
  it('replaces the default pattern', async () => {
    await H.mailer.collections.sends.insertOne(
      makeSend({ opens: [{ userAgent: 'AcmeCorp-MailScanner/3' }] }),
    )
    // Not a default bot...
    expect(await openCount()).toBe(true)
    // ...until the operator says so.
    expect(await openCount({ userAgentPattern: /AcmeCorp-MailScanner/i })).toBe(false)
  })

  it('a custom pattern that omits the built-ins lets them through — replace, not merge', async () => {
    await H.mailer.collections.sends.insertOne(makeSend({ opens: [{ userAgent: 'Googlebot/2.1' }] }))
    expect(await openCount()).toBe(false)
    expect(await openCount({ userAgentPattern: /NothingMatchesThis/ })).toBe(true)
  })
})

describe('botFilter.minOpenDelayMs', () => {
  const prefetch = () => makeSend({ queuedAgoMs: 60_000, opens: [{ userAgent: null, agoMs: 58_000 }] })

  it('is off by default — an instant open still counts', async () => {
    await H.mailer.collections.sends.insertOne(prefetch())
    expect(await openCount()).toBe(true)
  })

  it('drops an open that landed within the window when enabled', async () => {
    await H.mailer.collections.sends.insertOne(prefetch())
    expect(await openCount({ minOpenDelayMs: 10_000 })).toBe(false)
  })

  it('keeps an open that landed after the window', async () => {
    await H.mailer.collections.sends.insertOne(
      makeSend({ queuedAgoMs: 60 * 60 * 1000, opens: [{ userAgent: null, agoMs: 30 * 60 * 1000 }] }),
    )
    expect(await openCount({ minOpenDelayMs: 10_000 })).toBe(true)
  })

  it('still counts the send when a prefetch is followed by a real open', async () => {
    await H.mailer.collections.sends.insertOne(
      makeSend({
        queuedAgoMs: 60 * 60 * 1000,
        opens: [
          { userAgent: null, agoMs: 60 * 60 * 1000 - 2_000 },
          { userAgent: HUMAN_UA, agoMs: 30 * 60 * 1000 },
        ],
      }),
    )
    expect(await openCount({ minOpenDelayMs: 10_000 })).toBe(true)
  })

  it('leaves the unfiltered hasOpened alone', async () => {
    await H.mailer.collections.sends.insertOne(prefetch())
    expect(await evaluatePredicate(P.hasOpened, ctx({ minOpenDelayMs: 10_000 }))).toBe(true)
  })
})
