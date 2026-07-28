/**
 * setupSendgrid script — exercises happy paths + key idempotency / error
 * branches against a fully mocked fetch. No real network.
 */

import { describe, it, expect } from 'vitest'

import { setupSendgrid } from '../../src/cli/setup-sendgrid.js'

const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nABC123\n-----END PUBLIC KEY-----'
const OTHER_KEY = '-----BEGIN PUBLIC KEY-----\nOTHER\n-----END PUBLIC KEY-----'
const VALID_SG_KEY = 'SG.fake'
const OUR_URL = 'https://example.com/m/webhooks/sendgrid'
const THEIR_URL = 'https://other-app.example.com/m/webhooks/sendgrid'

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

/** A fully-configured webhook entry as GET /settings/all returns it. */
function webhookEntry(over: Record<string, unknown> = {}) {
  return {
    id: 'wh_ours',
    url: OUR_URL,
    friendly_name: 'mailery example.com',
    enabled: true,
    delivered: true, open: true, click: true, bounce: true,
    dropped: true, spam_report: true, unsubscribe: true,
    deferred: false, processed: false, group_resubscribe: false, group_unsubscribe: false,
    ...over,
  }
}

interface RouteOpts {
  existingDomain?: boolean
  existingDomainsList?: any[]
  status401?: boolean
  /** Entries returned by GET /settings/all. Ignored when legacyOnly. */
  webhooks?: any[]
  /** Simulate an account/key where GET /settings/all 404s. */
  legacyOnly?: boolean
  /** Body of the legacy singleton GET (legacyOnly mode). */
  legacySettings?: Record<string, unknown>
  /** Seed for per-webhook signing keys, keyed by webhook id. '' = signing off. */
  signedKeys?: Record<string, string>
  /** Key for the pathless (legacy) signed endpoint. '' = signing off. */
  legacySignedKey?: string
}

function sgRoutes(opts: RouteOpts): any[] {
  const signedKeys: Record<string, string> = { ...(opts.signedKeys ?? {}) }
  let legacySignedKey = opts.legacySignedKey ?? ''
  const idOf = (url: string) => decodeURIComponent(url.split('/signed/')[1] ?? '')

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

    // --- signing: per-webhook form first, so it wins over /settings/{id} ---
    [/^PATCH .*\/user\/webhooks\/event\/settings\/signed\/[^/]+$/, (req: MockCall) => {
      const id = idOf(req.url)
      signedKeys[id] = PUBLIC_KEY
      return { status: 200, body: { id, public_key: PUBLIC_KEY } }
    }],
    [/^GET .*\/user\/webhooks\/event\/settings\/signed\/[^/]+$/, (req: MockCall) => {
      const id = idOf(req.url)
      return { status: 200, body: { id, public_key: signedKeys[id] ?? '' } }
    }],
    [/^PATCH .*\/user\/webhooks\/event\/settings\/signed$/, () => {
      legacySignedKey = PUBLIC_KEY
      return { status: 200, body: { public_key: PUBLIC_KEY } }
    }],
    // Real SendGrid GET returns only `{ public_key }` — no `enabled` field.
    [/^GET .*\/user\/webhooks\/event\/settings\/signed$/, () => ({
      status: 200,
      body: { public_key: legacySignedKey },
    })],

    // --- multi-webhook endpoints -----------------------------------------
    [/^GET .*\/user\/webhooks\/event\/settings\/all$/, () => {
      if (opts.legacyOnly) return { status: 404, body: { errors: [{ message: 'not found' }] } }
      return { status: 200, body: { webhooks: opts.webhooks ?? [] } }
    }],
    [/^POST .*\/user\/webhooks\/event\/settings$/, (req: MockCall) => ({
      status: 201,
      body: { id: 'wh_new', created_date: 1, updated_date: 1, ...req.body },
    })],
    [/^PATCH .*\/user\/webhooks\/event\/settings\/[^/]+$/, (req: MockCall) => ({ status: 200, body: { ...req.body } })],

    // --- legacy singleton --------------------------------------------------
    [/^GET .*\/user\/webhooks\/event\/settings$/, () => ({
      status: 200,
      body: opts.legacySettings ?? { url: '', enabled: false },
    })],
    [/^PATCH .*\/user\/webhooks\/event\/settings$/, () => ({ status: 200, body: {} })],
  ]
}

const paths = (calls: MockCall[]) => calls.map((c) => `${c.method} ${c.url.replace(SG_BASE, '')}`)

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
    it('creates a new domain auth + creates the event webhook + enables signing on it', async () => {
      const { fn, calls } = buildFetch(sgRoutes({ existingDomain: false, webhooks: [] }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })

      expect(result.domains).toHaveLength(1)
      expect(result.domains[0]!.domainAuthId).toBe(42)
      expect(result.webhookKey).toBe(PUBLIC_KEY)
      expect(result.webhookId).toBe('wh_new')
      expect(result.domains[0]!.cloudflarePushed).toBe(0)
      expect(result.domains[0]!.dnsRecords).toHaveLength(3)

      expect(paths(calls)).toEqual([
        'GET /whitelabel/domains?limit=200',
        'POST /whitelabel/domains',
        'GET /user/webhooks/event/settings/all',
        'POST /user/webhooks/event/settings',
        'GET /user/webhooks/event/settings/signed/wh_new',
        'PATCH /user/webhooks/event/settings/signed/wh_new',
      ])

      const create = calls.find((c) => c.method === 'POST' && /\/user\/webhooks\/event\/settings$/.test(c.url))
      expect(create?.body.url).toBe(OUR_URL)
      expect(create?.body.delivered).toBe(true)
      expect(create?.body.bounce).toBe(true)
      expect(create?.body.deferred).toBe(false)
      expect(create?.body.friendly_name).toBe('mailery example.com')
    })

    it('honours --webhook-name for the friendly_name on create', async () => {
      const { fn, calls } = buildFetch(sgRoutes({ existingDomain: true, webhooks: [] }))
      await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        webhookName: 'staging events',
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      const create = calls.find((c) => c.method === 'POST' && /\/user\/webhooks\/event\/settings$/.test(c.url))
      expect(create?.body.friendly_name).toBe('staging events')
    })

    it('is fully idempotent: re-running on a finished install does no PATCH/POST', async () => {
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        webhooks: [webhookEntry()],
        signedKeys: { wh_ours: PUBLIC_KEY },
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.webhookKey).toBe(PUBLIC_KEY)
      expect(result.webhookId).toBe('wh_ours')
      const mutations = calls.filter((c) => c.method === 'PATCH' || c.method === 'POST')
      expect(mutations).toEqual([])
    })

    it('updates our own webhook by id when its event toggles drifted', async () => {
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        webhooks: [webhookEntry({ bounce: false, spam_report: false })],
        signedKeys: { wh_ours: PUBLIC_KEY },
      }))
      await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      const patch = calls.find((c) => c.method === 'PATCH' && /\/user\/webhooks\/event\/settings\/wh_ours$/.test(c.url))
      expect(patch?.body.bounce).toBe(true)
      expect(patch?.body.url).toBe(OUR_URL)
      // never the legacy singleton, which would repoint the account's oldest webhook
      expect(calls.find((c) => c.method === 'PATCH' && /\/user\/webhooks\/event\/settings$/.test(c.url))).toBeUndefined()
    })

    it('matches an existing webhook whose URL differs only by a trailing slash', async () => {
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        webhooks: [webhookEntry({ url: `${OUR_URL}/` })],
        signedKeys: { wh_ours: PUBLIC_KEY },
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.webhookId).toBe('wh_ours')
      expect(calls.filter((c) => c.method === 'POST' && /\/user\/webhooks\/event\/settings$/.test(c.url))).toEqual([])
    })

    it('reuses an existing domain auth (idempotent)', async () => {
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        webhooks: [webhookEntry()],
        signedKeys: { wh_ours: PUBLIC_KEY },
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.domains[0]!.domainAuthId).toBe(42)
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/whitelabel/domains'))).toBeUndefined()
    })

    it('does NOT re-enable signing (and rotate the key) when signing is already on', async () => {
      // Regression: re-PATCHing /signed rotates SendGrid's keypair, silently
      // breaking signature verification on inbound events.
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        webhooks: [webhookEntry()],
        signedKeys: { wh_ours: PUBLIC_KEY },
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        force: true,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.webhookKey).toBe(PUBLIC_KEY)
      const signedPatch = calls.filter((c) => c.method === 'PATCH' && /\/settings\/signed(\/|$)/.test(c.url))
      expect(signedPatch).toEqual([])
    })
  })

  describe('accounts shared with other apps (multi-webhook API)', () => {
    it('creates a second webhook instead of repointing another app’s', async () => {
      const theirs = webhookEntry({ id: 'wh_theirs', url: THEIR_URL, friendly_name: 'other app' })
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        webhooks: [theirs],
        signedKeys: { wh_theirs: OTHER_KEY },
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })

      expect(result.webhookId).toBe('wh_new')
      // their webhook is never written to, by id or via the legacy singleton
      expect(calls.filter((c) => c.method !== 'GET' && /wh_theirs/.test(c.url))).toEqual([])
      expect(calls.filter((c) => c.method === 'PATCH' && /\/user\/webhooks\/event\/settings$/.test(c.url))).toEqual([])
      expect(calls.filter((c) => c.method === 'PATCH' && /\/settings\/signed$/.test(c.url))).toEqual([])
      const create = calls.find((c) => c.method === 'POST' && /\/user\/webhooks\/event\/settings$/.test(c.url))
      expect(create?.body.url).toBe(OUR_URL)
    })

    it('succeeds without --force even though another webhook already exists', async () => {
      const { fn } = buildFetch(sgRoutes({
        existingDomain: true,
        webhooks: [webhookEntry({ id: 'wh_theirs', url: THEIR_URL })],
        signedKeys: { wh_theirs: OTHER_KEY },
      }))
      await expect(setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })).resolves.toMatchObject({ webhookUrl: OUR_URL })
    })

    it('takes the signing key for OUR webhook, not the account-oldest one', async () => {
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        webhooks: [
          webhookEntry({ id: 'wh_theirs', url: THEIR_URL }),
          webhookEntry({ id: 'wh_ours' }),
        ],
        signedKeys: { wh_theirs: OTHER_KEY, wh_ours: PUBLIC_KEY },
        legacySignedKey: OTHER_KEY,
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.webhookKey).toBe(PUBLIC_KEY)
      expect(calls.some((c) => c.url.endsWith('/settings/signed/wh_ours'))).toBe(true)
      expect(calls.some((c) => c.url.endsWith('/settings/signed'))).toBe(false)
    })
  })

  describe('legacy single-webhook accounts (no /settings/all)', () => {
    it('falls back to the singleton endpoints when /settings/all 404s', async () => {
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        legacyOnly: true,
        legacySettings: { url: '', enabled: false },
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.webhookId).toBeUndefined()
      expect(result.webhookKey).toBe(PUBLIC_KEY)
      expect(paths(calls)).toEqual([
        'GET /whitelabel/domains?limit=200',
        'GET /user/webhooks/event/settings/all',
        'GET /user/webhooks/event/settings',
        'PATCH /user/webhooks/event/settings',
        'GET /user/webhooks/event/settings/signed',
        'PATCH /user/webhooks/event/settings/signed',
      ])
    })

    it('refuses to repoint the account’s only webhook without --force', async () => {
      const { fn } = buildFetch(sgRoutes({
        existingDomain: true,
        legacyOnly: true,
        legacySettings: { url: THEIR_URL, enabled: true },
      }))
      await expect(setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })).rejects.toThrow(/legacy single-webhook API[\s\S]*--force/)
    })

    it('repoints with --force', async () => {
      const { fn, calls } = buildFetch(sgRoutes({
        existingDomain: true,
        legacyOnly: true,
        legacySettings: { url: THEIR_URL, enabled: true },
        legacySignedKey: PUBLIC_KEY,
      }))
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
        force: true,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })
      expect(result.webhookUrl).toBe(OUR_URL)
      const patch = calls.find((c) => c.method === 'PATCH' && /\/user\/webhooks\/event\/settings$/.test(c.url))
      expect(patch?.body.url).toBe(OUR_URL)
    })
  })

  describe('multi-domain', () => {
    it('authenticates both news.* and mail.* but only configures the webhook once', async () => {
      const { fn, calls } = buildFetch(sgRoutes({ existingDomain: false, webhooks: [] }))
      const result = await setupSendgrid({
        domains: ['news.example.com', 'mail.example.com'],
        webhookUrl: OUR_URL,
        env: { SENDGRID_API_KEY: VALID_SG_KEY },
        fetchFn: fn,
        logger: {},
      })

      expect(result.domains.map((d) => d.domain)).toEqual(['news.example.com', 'mail.example.com'])
      // Two domain-auth POSTs, one webhook create, one signed-PATCH.
      const sgPosts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/whitelabel/domains'))
      expect(sgPosts.length).toBe(2)
      const webhookPosts = calls.filter((c) => c.method === 'POST' && /\/user\/webhooks\/event\/settings$/.test(c.url))
      expect(webhookPosts.length).toBe(1)
      const signedPatch = calls.filter((c) => c.method === 'PATCH' && /\/settings\/signed(\/|$)/.test(c.url))
      expect(signedPatch.length).toBe(1)
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
      const { fn, calls } = buildFetch([...cfRoutes, ...sgRoutes({ existingDomain: false, webhooks: [] })])
      const result = await setupSendgrid({
        domains: ['example.com'],
        webhookUrl: OUR_URL,
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
      const { fn } = buildFetch([...cfRoutes, ...sgRoutes({ existingDomain: false, webhooks: [] })])
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
