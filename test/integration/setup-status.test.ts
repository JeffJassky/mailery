/**
 * Setup-status check exercise. Validates that each check fires under the
 * conditions it's designed to catch, and that the overall severity rolls up
 * correctly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { runSetupChecks } from '../../src/server/api/setup-status.js'
import { runTick } from '../../src/server/runner/index.js'
import type { TemplateDoc } from '../../src/server/models/index.js'

function publishedTemplate(slug: string, kind: 'marketing' | 'transactional', fromEmail: string): TemplateDoc {
  const now = new Date()
  return {
    slug,
    name: slug,
    description: '',
    kind,
    fromName: 'Test',
    fromEmail,
    replyTo: null,
    subject: 'Hi',
    preheader: '',
    body: { mjml: '<mjml></mjml>', editorJson: null, html: '<html></html>', plainText: 'Hi', compiledAt: now },
    draft: null,
    publishedAt: now,
    publishedBy: 'test',
    providerOverride: null,
    trackOpens: true,
    trackClicks: true,
    createdAt: now,
    updatedAt: now,
  } as TemplateDoc
}

describe('runSetupChecks', () => {
  describe('clean install', () => {
    let H: TestMailerHarness
    beforeAll(async () => {
      H = await createTestMailer({ config: { senderAddress: undefined } })
    }, 60_000)
    afterAll(async () => { await H?.stop() })
    beforeEach(async () => {
      await H.mailer.collections.templates.deleteMany({})
      await H.mailer.collections.health.deleteMany({})
    })

    it('all checks pass on a freshly created mailer (noop driver, no templates)', async () => {
      const status = await runSetupChecks(H.mailer)
      expect(status.overall).toBe('ok')
      expect(status.checks.find((c) => c.name === 'mongo')?.severity).toBe('ok')
      expect(status.checks.find((c) => c.name === 'queue')?.severity).toBe('ok')
      // workers_heartbeat is skipped when driver is noop
      expect(status.checks.find((c) => c.name === 'workers_heartbeat')).toBeUndefined()
      expect(status.checks.find((c) => c.name === 'postal_address')?.severity).toBe('ok')
    })

    it('warns when a marketing template is published but senderAddress is unset', async () => {
      await H.mailer.collections.templates.insertOne(publishedTemplate('news', 'marketing', 'hi@example.com'))
      const status = await runSetupChecks(H.mailer)
      const postal = status.checks.find((c) => c.name === 'postal_address')!
      expect(postal.severity).toBe('warn')
      expect(status.overall).toBe('warn')
    })
  })

  describe('with senderDomains registry', () => {
    let H: TestMailerHarness
    beforeAll(async () => {
      H = await createTestMailer({
        config: {
          senderAddress: '12 Main St, Brooklyn NY 11201',
          fromDefaults: { name: 'Test', email: 'hi@news.example.com' },
          // intentionally unset transactionalFromDefaults — fallback check
          senderDomains: {
            'news.example.com': { kind: 'marketing' },
            'mail.example.com': { kind: 'transactional' },
          },
        },
      })
    }, 60_000)
    afterAll(async () => { await H?.stop() })
    beforeEach(async () => {
      await H.mailer.collections.templates.deleteMany({})
    })

    it('warns when transactionalFromDefaults is unset and fromDefaults is marketing-only', async () => {
      const status = await runSetupChecks(H.mailer)
      const fallback = status.checks.find((c) => c.name === 'transactional_fallback')
      expect(fallback?.severity).toBe('warn')
    })

    it('errors on published templates with fromEmail that no longer matches the registry', async () => {
      await H.mailer.collections.templates.insertOne(
        publishedTemplate('stale', 'marketing', 'hi@oldnewsletter.com'),
      )
      const status = await runSetupChecks(H.mailer)
      const broken = status.checks.find((c) => c.name === 'published_template_domains')
      expect(broken?.severity).toBe('error')
      expect(broken?.message).toContain('stale')
      expect(status.overall).toBe('error')
    })
  })

  describe('DOI', () => {
    let H: TestMailerHarness
    beforeAll(async () => {
      H = await createTestMailer({ config: { requireDoubleOptIn: true } })
    }, 60_000)
    afterAll(async () => { await H?.stop() })

    it('errors when requireDoubleOptIn is on but no published doi template exists', async () => {
      const status = await runSetupChecks(H.mailer)
      const doi = status.checks.find((c) => c.name === 'doi_template')!
      expect(doi.severity).toBe('error')
      expect(status.overall).toBe('error')
    })
  })

  describe('workers heartbeat (non-noop driver simulated via health doc)', () => {
    let H: TestMailerHarness
    beforeAll(async () => {
      H = await createTestMailer({})
    }, 60_000)
    afterAll(async () => { await H?.stop() })

    it('runTick writes a fresh heartbeat into the health collection', async () => {
      await H.mailer.collections.health.deleteMany({})
      await runTick(H.mailer.getRunnerContext())
      const doc = await H.mailer.collections.health.findOne({ _id: 'agg' })
      expect(doc).toBeTruthy()
      expect(doc!.updatedAt).toBeInstanceOf(Date)
      expect(Date.now() - new Date(doc!.updatedAt).getTime()).toBeLessThan(5000)
    })
  })
})
