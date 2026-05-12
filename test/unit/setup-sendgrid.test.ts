/**
 * setupSendgrid script — exercises happy paths + key idempotency / error
 * branches against a fully mocked fetch. No real network.
 */

import { describe, it, expect } from 'vitest'

import { setupSendgrid } from '../../src/cli/setup-sendgrid.js'

const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nABC123\n-----END PUBLIC KEY-----'
const VALID_SG_KEY = 'SG.fake'

interface MockCall {
  method: string
  url: string
  body?: any
}

function buildFetch(routes: Array<[RegExp, (req: MockCall) => { status: number; body: any } | { status: number; bodyText: string }]>) {
  const calls: MockCall[] = []
  const fn: typeof fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? safeJson(String(init.body)) : undefined
    const call: MockCall = { method, url, body }
    calls.push(call)
    for (const [pat, handler] of routes) {
      if (pat.test(`${method} ${url}`)) {
        const result = handler(call)
        const text = 'bodyText' in result ? result.bodyText : JSON.stringify(result.body)
        return new Response(text, { status: result.status, headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response(`no mock for ${method} ${url}`, { status: 599 })
  }) as typeof fetch
  return { fn, calls }
}

function safeJson(s: string) { try { return JSON.parse(s) } catch { return s } }

const SG_BASE = 'https://api.sendgrid.com/v3'
const SAMPLE_DNS = {
  mail_cname: { host: 'em.example.com', type: 'cname', data: 'u1.wl.sendgrid.net', valid: false },
  dkim1: { host: 's1._domainkey.example.com', type: 'cname', data: 's1.domainkey.u1.wl.sendgrid.net', valid: false },
  dkim2: { host: 's2._domainkey.example.com', type: 'cname', data: 's2.domainkey.u1.wl.sendgrid.net', valid: false },
}

function sgRoutes(opts: { existingDomain?: boolean; existingWebhookUrl?: string | null; signingEnabled?: boolean; eventSettings?: Record<string, unknown>; existingDomainsList?: any[]; status401?: boolean }): any[] {
  let signingEnabled = opts.signingEnabled ?? true
  return [
    [/^GET .*\/whitelabel\/domains\?limit=200/, () => {
      if (opts.status401) return { status: 401, body: { errors: [{ message: 'unauthorized' }] } }
      return {
        status: 200,
        body: opts.existingDomainsList ?? (opts.existingDomain
          ? [{ id: 42, domain: 'example.com', subdomain: 'em', username: 'u1', valid: true, dns: SAMPLE_DNS }]
          : []),
      }
    }],
    [/^POST .*\/whitelabel\/domains$/, (req: MockCall) => ({
      status: 201,
      body: { id: req.body?.domain === 'mail.example.com' ? 43 : 42, domain: req.body?.domain ?? 'example.com', subdomain: 'em', username: 'u1', valid: false, dns: SAMPLE_DNS },
    })],
    [/^POST .*\/whitelabel\/domains\/\d+\/validate$/, () => ({ status: 200, body: { valid: true } })],
    [/^PATCH .*\/user\/webhooks\/event\/settings\/signed$/, () => { signingEnabled = true; return { status: 200, body: { enabled: true, public_key: PUBLIC_KEY } } }],
    // Real SendGrid GET returns only `{ public_key }` — no `enabled` field.
    // Empty string when signing is off; populated when on.
    [/^GET .*\/user\/webhooks\/event\/settings\/signed$/, () => ({
      status: 200,
      body: { public_key: signingEnabled ? PUBLIC_KEY : '' },
    })],
    [/^GET .*\/user\/webhooks\/event\/settings$/, () => ({
      status: 200,
      body: opts.eventSettings ?? (opts.existingWebhookUrl !== undefined ? { url: opts.existingWebhookUrl, enabled: !!opts.existingWebhookUrl } : { url: '', enabled: false }),
    })],
    [/^PATCH .*\/user\/webhooks\/event\/settings$/, () => ({ status: 200, body: {} })],
  ]
}

describe('setupSendgrid', () => {
  describe('env var validation', () => {
    it('requires SENDGRID_API_KEY with a how-to hint', async () => {
      await expect(setupSendgrid({
        domains: ['example.com'], webhookUrl: 'https://x/m/w', env: {},
      })).rejects.toThrow(/SENDGRID_API_KEY env var is required[\s\S]*api_keys/)
    })

    it('rejects SENDGRID_API_KEY that does not look like a SendGrid key', async () => {
      await expect(setupSendgrid({
        domains: ['example.com'], webhookUrl: 'https://x/m/w',
        env: { SENDGRID_API_KEY: 'not-a-real-key' },
      })).rejects.toThrow(/does not look like a SendGrid API key/)
    })

    it('requires CLOUDFLARE_API_TOKEN only when --cloudflare is set, with a how-to hint', async () => {
      await expect(setupSendgrid({
        domains: ['example.com'], webhookUrl: 'https://x/m/w', cloudflare: true,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
      })).rejects.toThrow(/CLOUDFLARE_API_TOKEN env var is required[\s\S]*api-tokens/)
    })

    it('passes a 401 from SendGrid through with a clearer permission hint', async () => {
      const { fn } = buildFetch(sgRoutes({ status401: true }))
      await expect(setupSendgrid({
        domains: ['example.com'], webhookUrl: 'https://x/m/w',
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn, logger: {},
      })).rejects.toThrow(/SendGrid rejected the request.*permissions/)
    })

    it('requires at least one --domain', async () => {
      await expect(setupSendgrid({
        domains: [], webhookUrl: 'https://x/m/w',
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
      })).rejects.toThrow(/at least one --domain/i)
    })
  })

  describe('single-domain flow', () => {
    it('creates a new domain auth + enables signing + sets URL (no Cloudflare)', async () => {
      const { fn, calls } = buildFetch(sgRoutes({ existingDomain: false, existingWebhookUrl: '', signingEnabled: false }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: 'https://example.com/m/webhooks/sendgrid',
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })

      expect(result.domains).toHaveLength(1)
      expect(result.domains[0]!.domainAuthId).toBe(42)
      expect(result.webhookKey).toBe(PUBLIC_KEY)
      expect(result.domains[0]!.cloudflarePushed).toBe(0)
      expect(result.domains[0]!.dnsRecords).toHaveLength(3)

      const methods = calls.map((c) => `${c.method} ${c.url.replace(SG_BASE, '')}`)
      expect(methods).toEqual([
        'GET /whitelabel/domains?limit=200',
        'POST /whitelabel/domains',
        'GET /user/webhooks/event/settings/signed',
        'PATCH /user/webhooks/event/settings/signed',
        'GET /user/webhooks/event/settings/signed',
        'GET /user/webhooks/event/settings',
        'PATCH /user/webhooks/event/settings',
      ])

      const webhookPatch = calls.find((c) => c.method === 'PATCH' && /\/user\/webhooks\/event\/settings$/.test(c.url))
      expect(webhookPatch?.body.url).toBe('https://example.com/m/webhooks/sendgrid')
      expect(webhookPatch?.body.delivered).toBe(true)
      expect(webhookPatch?.body.bounce).toBe(true)
      expect(webhookPatch?.body.deferred).toBe(false)
    })

    it('is fully idempotent: re-running on a finished install does no PATCH/POST', async () => {
      const finishedEventSettings = {
        url: 'https://example.com/m/webhooks/sendgrid',
        enabled: true,
        delivered: true, open: true, click: true, bounce: true,
        dropped: true, spam_report: true, unsubscribe: true,
        deferred: false, processed: false, group_resubscribe: false, group_unsubscribe: false,
      }
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        signingEnabled: true,
        eventSettings: finishedEventSettings,
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: 'https://example.com/m/webhooks/sendgrid',
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.webhookKey).toBe(PUBLIC_KEY)
      const mutations = calls.filter((c) => c.method === 'PATCH' || c.method === 'POST')
      expect(mutations).toEqual([])
    })

    it('reuses an existing domain auth (idempotent)', async () => {
      const { fn, calls } = buildFetch(sgRoutes({ existingDomain: true, existingWebhookUrl: 'https://example.com/m/webhooks/sendgrid' }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: 'https://example.com/m/webhooks/sendgrid',
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.domains[0]!.domainAuthId).toBe(42)
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/whitelabel/domains'))).toBeUndefined()
    })

    it('refuses to overwrite an existing webhook URL without --force', async () => {
      const { fn } = buildFetch(sgRoutes({ existingDomain: true, existingWebhookUrl: 'https://OLD.example.com/m/webhooks/sendgrid' }))
      await expect(setupSendgrid({
        domains: ['example.com'],
        webhookUrl: 'https://NEW.example.com/m/webhooks/sendgrid',
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })).rejects.toThrow(/already configured.*--force/)
    })

    it('does NOT re-enable signing (and rotate the key) when --force is set but signing is already on', async () => {
      // Regression: --force is documented as "replace existing webhook URL".
      // It used to also re-PATCH /signed which rotates SendGrid's keypair,
      // silently breaking signature verification on inbound events.
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        existingWebhookUrl: 'https://OLD.example.com/m/webhooks/sendgrid',
        signingEnabled: true,
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: 'https://NEW.example.com/m/webhooks/sendgrid',
        force: true,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.webhookKey).toBe(PUBLIC_KEY)
      const signedPatch = calls.filter((c) => c.method === 'PATCH' && /\/user\/webhooks\/event\/settings\/signed$/.test(c.url))
      expect(signedPatch).toEqual([])
    })

    it('overwrites with --force', async () => {
      const { fn, calls } = buildFetch(sgRoutes({ existingDomain: true, existingWebhookUrl: 'https://OLD.example.com/m/webhooks/sendgrid' }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: 'https://NEW.example.com/m/webhooks/sendgrid',
        force: true,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.webhookUrl).toBe('https://NEW.example.com/m/webhooks/sendgrid')
      const webhookPatch = calls.find((c) => c.method === 'PATCH' && /\/user\/webhooks\/event\/settings$/.test(c.url))
      expect(webhookPatch?.body.url).toBe('https://NEW.example.com/m/webhooks/sendgrid')
    })
  })

  describe('multi-domain', () => {
    it('authenticates both news.* and mail.* but only configures the webhook once', async () => {
      const { fn, calls } = buildFetch(sgRoutes({ existingDomain: false, existingWebhookUrl: '', signingEnabled: false }))
      const result = await setupSendgrid({
        domains: ['news.example.com', 'mail.example.com'],
        webhookUrl: 'https://example.com/m/webhooks/sendgrid',
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })

      expect(result.domains.map((d) => d.domain)).toEqual(['news.example.com', 'mail.example.com'])
      // Two domain-auth POSTs, one signed-PATCH, one event-PATCH.
      const sgPosts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/whitelabel/domains'))
      expect(sgPosts.length).toBe(2)
      const signedPatch = calls.filter((c) => c.method === 'PATCH' && /\/signed$/.test(c.url))
      expect(signedPatch.length).toBe(1)
      const eventPatch = calls.filter((c) => c.method === 'PATCH' && /\/user\/webhooks\/event\/settings$/.test(c.url))
      expect(eventPatch.length).toBe(1)
    })
  })

  describe('Cloudflare', () => {
    it('publishes records, validates the domain, and forces proxied:false on every record', async () => {
      const cfRoutes: any[] = [
        [/^GET .*\/zones\?name=example.com$/, () => ({ status: 200, body: { success: true, result: [{ id: 'zone-1' }] } })],
        [/^GET .*\/zones\/zone-1\/dns_records\?type=cname/, (req: MockCall) => {
          if (req.url.includes('name=em.example.com')) {
            return { status: 200, body: { success: true, result: [{ id: 'r1', content: 'u1.wl.sendgrid.net', proxied: false }] } }
          }
          return { status: 200, body: { success: true, result: [] } }
        }],
        [/^POST .*\/zones\/zone-1\/dns_records$/, () => ({ status: 200, body: { success: true, result: {} } })],
      ]
      const { fn, calls } = buildFetch([...cfRoutes, ...sgRoutes({ existingDomain: false, existingWebhookUrl: '' })])
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: 'https://example.com/m/webhooks/sendgrid',
        cloudflare: true,
        env: { SENDGRID_API_KEY: VALID_SG_KEY, CLOUDFLARE_API_TOKEN: 'cf-token' },
        fetchFn: fn,
        logger: {},
      })

      expect(result.domains[0]!.cloudflarePushed).toBe(2)
      expect(result.domains[0]!.alreadyValidated).toBe(true)

      const cfPosts = calls.filter((c) => c.method === 'POST' && /cloudflare\.com.*\/dns_records$/.test(c.url))
      expect(cfPosts.length).toBe(2)
      for (const p of cfPosts) {
        expect(p.body.proxied).toBe(false)
      }
    })

    it('surfaces Cloudflare 401 with a clear permission message', async () => {
      const cfRoutes: any[] = [
        [/^GET .*\/zones\?name=/, () => ({ status: 401, body: { success: false, errors: [{ message: 'invalid token' }] } })],
      ]
      const { fn } = buildFetch([...cfRoutes, ...sgRoutes({ existingDomain: false, existingWebhookUrl: '' })])
      await expect(setupSendgrid({
        domains: ['example.com'],
        webhookUrl: 'https://x/m/w',
        cloudflare: true,
        env: { SENDGRID_API_KEY: VALID_SG_KEY, CLOUDFLARE_API_TOKEN: 'cf-bad' },
        fetchFn: fn, logger: {},
      })).rejects.toThrow(/Cloudflare rejected the request.*permissions/)
    })
  })
})
