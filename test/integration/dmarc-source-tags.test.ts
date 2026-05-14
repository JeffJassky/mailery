/**
 * resolveSourceTags merges MailerConfig.dmarc.knownSources with the
 * mailer_dmarc_source_tags collection. DB tags override config tags so
 * operators can re-label without redeploying.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { resolveSourceTags } from '../../src/server/runner/dmarc.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    config: {
      dmarc: {
        knownSources: [
          { ip: '149.72.45.10', label: 'SendGrid (from config)' },
          { ip: '203.0.113.99', label: 'Legacy server', ignored: true },
        ],
      },
    },
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function reset() {
  await H.mailer.collections.dmarcSourceTags.deleteMany({})
}

describe('resolveSourceTags', () => {
  it('returns config-only tags when DB collection is empty', async () => {
    await reset()
    const tags = await resolveSourceTags(H.mailer.getRunnerContext())
    expect(tags.size).toBe(2)
    expect(tags.get('149.72.45.10')?.source).toBe('config')
    expect(tags.get('203.0.113.99')?.ignored).toBe(true)
  })

  it('adds DB-only tags on top of config tags', async () => {
    await reset()
    await H.mailer.collections.dmarcSourceTags.insertOne({
      ip: '198.51.100.7',
      label: 'Hubspot',
      ignored: false,
      setBy: 'admin',
      setAt: new Date(),
    })
    const tags = await resolveSourceTags(H.mailer.getRunnerContext())
    expect(tags.size).toBe(3)
    expect(tags.get('198.51.100.7')?.source).toBe('db')
    expect(tags.get('198.51.100.7')?.label).toBe('Hubspot')
    expect(tags.get('149.72.45.10')?.source).toBe('config')
  })

  it('DB tag overrides config tag for the same IP', async () => {
    await reset()
    await H.mailer.collections.dmarcSourceTags.insertOne({
      ip: '149.72.45.10',
      label: 'SendGrid (renamed by operator)',
      ignored: true,
      setBy: 'admin',
      setAt: new Date(),
    })
    const tags = await resolveSourceTags(H.mailer.getRunnerContext())
    const t = tags.get('149.72.45.10')
    expect(t?.source).toBe('db')
    expect(t?.label).toBe('SendGrid (renamed by operator)')
    expect(t?.ignored).toBe(true)
  })
})
