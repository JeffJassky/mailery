/**
 * A subject is a plain-text header. Handlebars' default HTML escaping turned
 * `O'Brien` into `O&#x27;Brien` in recipients' inboxes. Subjects now render
 * unescaped, with line breaks folded to spaces.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { dispatchSend } from '../../src/server/runner/index.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer()
  await H.seedContact({ externalId: 'u1', email: 'alice@example.com', tags: [], fields: {} })
  await H.seedTemplate({
    slug: 'invite',
    kind: 'transactional',
    subject: '{{vars.inviter}} invited you to {{vars.account}}',
    text: 'Hello',
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

describe('subject escaping', () => {
  it('delivers names and punctuation in the subject as written', async () => {
    const { sendId } = await H.mailer.sendOneOff({
      templateSlug: 'invite',
      externalId: 'u1',
      vars: { inviter: "Sam O'Brien", account: 'Smith & Sons <Films>\r\nLtd' },
      dedupeKey: 'subject-escaping-1',
    })
    await dispatchSend(new ObjectId(sendId), H.mailer.getRunnerContext())

    const sent = H.provider.sent.at(-1)
    expect(sent?.subject).toBe("Sam O'Brien invited you to Smith & Sons <Films> Ltd")
  })
})
