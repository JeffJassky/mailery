/**
 * `mailery setup-sendgrid` — one-shot wiring of SendGrid for a domain.
 *
 * Idempotent. Re-running converges: existing domain auths are reused, existing
 * webhook config is preserved unless `--force` is passed, existing Cloudflare
 * DNS records with the correct values are left alone.
 *
 *   npx mailery setup-sendgrid \
 *     --domain news.example.com \
 *     --webhook-url https://example.com/m/webhooks/sendgrid \
 *     --cloudflare
 *
 * Required env:
 *   SENDGRID_API_KEY     — full-access (or at minimum Mail Settings + Sender Auth)
 *   CLOUDFLARE_API_TOKEN — only if --cloudflare; needs Zone:Read + DNS:Edit on the zone
 */

import { cloudflareClient, inferZone } from './cloudflare.js'

export interface SetupSendgridOpts {
  /** One or more domains to authenticate, e.g. ["news.example.com", "mail.example.com"]. */
  domains: string[]
  /** Sub-label SendGrid uses for the link branding CNAME (default 'em'). */
  subdomain?: string
  /** Where SendGrid should POST event webhooks. Account-level — only configured once regardless of domain count. */
  webhookUrl: string
  /** Publish DNS records via Cloudflare API. Requires CLOUDFLARE_API_TOKEN. */
  cloudflare?: boolean
  /** Override the parent zone if any domain isn't a subdomain of its eTLD+1. */
  cloudflareZone?: string
  /** Replace an existing webhook URL if one is already set. */
  force?: boolean
  /** Logger; defaults to console. Pass {} to silence. */
  logger?: { log?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
  /** Override fetch (for tests). */
  fetchFn?: typeof fetch
  /** Override env (for tests). */
  env?: Record<string, string | undefined>
}

export interface DomainSetupResult {
  domain: string
  domainAuthId: number
  alreadyValidated: boolean
  dnsRecords: Array<{ type: string; host: string; data: string }>
  cloudflarePushed: number
}

export interface SetupSendgridResult {
  domains: DomainSetupResult[]
  webhookKey: string
  webhookUrl: string
  envSnippet: string
}

interface SgDomainAuth {
  id: number
  domain: string
  subdomain: string
  username: string
  valid: boolean
  dns: Record<string, { host: string; type: string; data: string; valid: boolean }>
}

export async function setupSendgrid(opts: SetupSendgridOpts): Promise<SetupSendgridResult> {
  const env = opts.env ?? process.env
  const log = opts.logger ?? console
  const info = (m: string) => log.log?.(m)
  const warn = (m: string) => log.warn?.(m)
  const f = opts.fetchFn ?? globalThis.fetch

  const sgKey = env.SENDGRID_API_KEY
  if (!sgKey) {
    throw new Error(
      'SENDGRID_API_KEY env var is required.\n' +
        '  Create one at: https://app.sendgrid.com/settings/api_keys\n' +
        '  Needs at least: "Mail Settings" (Full Access) and "Sender Authentication" (Full Access).\n' +
        '  Then add to your shell rc (e.g. ~/.zshrc):  export SENDGRID_API_KEY="SG.xxx"',
    )
  }
  if (!/^SG\./.test(sgKey)) {
    throw new Error(
      'SENDGRID_API_KEY does not look like a SendGrid API key (expected to start with "SG."). ' +
        'Double-check you copied the full key from https://app.sendgrid.com/settings/api_keys.',
    )
  }

  if (opts.cloudflare && !env.CLOUDFLARE_API_TOKEN) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN env var is required when --cloudflare is set.\n' +
        '  Create one at: https://dash.cloudflare.com/profile/api-tokens\n' +
        '  Use the "Edit zone DNS" template, restricted to the specific zone you\'re publishing into.\n' +
        '  Permissions: Zone:Read + DNS:Edit.\n' +
        '  Then add to your shell rc:  export CLOUDFLARE_API_TOKEN="cf-xxx"',
    )
  }

  if (!opts.domains || opts.domains.length === 0) {
    throw new Error('At least one --domain is required')
  }

  const sg = sendgridClient(sgKey, f)
  const cf = opts.cloudflare ? cloudflareClient(env.CLOUDFLARE_API_TOKEN!, f) : null

  // ---- Per-domain: authentication + DNS publish ---------------------------
  const domainResults: DomainSetupResult[] = []
  for (const domain of opts.domains) {
    info('')
    info(`=== ${domain} ===`)
    info(`SendGrid → checking domain authentication for ${domain}…`)
    const existing = await sg.findDomainAuth(domain)
    let auth: SgDomainAuth
    if (existing) {
      info(`  → reusing existing domain auth #${existing.id}`)
      auth = existing
    } else {
      info(`  → creating new domain auth`)
      auth = await sg.createDomainAuth({
        domain,
        subdomain: opts.subdomain ?? 'em',
      })
    }

    const dnsRecords = Object.values(auth.dns).map((r) => ({ type: r.type, host: r.host, data: r.data }))
    let cloudflarePushed = 0

    if (cf) {
      info(`Cloudflare → publishing ${dnsRecords.length} record(s)…`)
      const zoneName = opts.cloudflareZone ?? inferZone(domain)
      const zoneId = await cf.findZoneId(zoneName)
      if (!zoneId) {
        throw new Error(`Cloudflare zone "${zoneName}" not found on this account`)
      }
      for (const rec of dnsRecords) {
        const result = await cf.upsertRecord(zoneId, rec)
        if (result === 'created') {
          cloudflarePushed++
          info(`  + ${rec.type} ${rec.host} → ${rec.data}`)
        } else if (result === 'updated') {
          cloudflarePushed++
          info(`  ~ ${rec.type} ${rec.host} (updated to ${rec.data})`)
        } else {
          info(`  = ${rec.type} ${rec.host} (already correct)`)
        }
      }

      info('SendGrid → triggering validation…')
      const validated = await sg.validateDomainAuth(auth.id)
      if (validated) {
        info('  ✓ domain authenticated')
      } else {
        warn('  ! validation not yet successful — DNS may still be propagating. Re-run in a few minutes.')
      }
      auth.valid = validated
    } else {
      info('— skipping Cloudflare publish (no --cloudflare). Add these records to your DNS provider:')
      for (const rec of dnsRecords) {
        info(`  ${rec.type.padEnd(7)} ${rec.host.padEnd(50)} ${rec.data}`)
      }
    }

    domainResults.push({
      domain,
      domainAuthId: auth.id,
      alreadyValidated: auth.valid,
      dnsRecords,
      cloudflarePushed,
    })
  }

  info('')
  info('=== Event webhook (account-level) ===')

  // ---- Account-level: Enable Signed Event Webhook + fetch public key -----
  info('SendGrid → checking Signed Event Webhook…')
  // SendGrid's GET /user/webhooks/event/settings/signed only returns
  // `{ public_key }`. A non-empty key implies signing is already enabled —
  // re-PATCHing `enabled: true` rotates the keypair, silently breaking
  // signature verification everywhere the old key was deployed.
  const signed = await sg.getSignedWebhookSettings()
  let webhookKey: string
  if (signed.public_key) {
    info('  = signing already enabled; reusing existing public key')
    webhookKey = signed.public_key
  } else {
    info('  → enabling signing')
    webhookKey = await sg.enableSignedWebhook()
    info('  ✓ verification key fetched')
  }

  // ---- Step 4: Configure Event Webhook URL + event toggles ----------------
  info('SendGrid → checking Event Webhook…')
  const currentEvents = await sg.getEventWebhookSettings()
  const desiredEvents = {
    url: opts.webhookUrl,
    enabled: true,
    delivered: true,
    open: true,
    click: true,
    bounce: true,
    dropped: true,
    spam_report: true,
    unsubscribe: true,
    deferred: false,
    processed: false,
    group_resubscribe: false,
    group_unsubscribe: false,
  }
  if (currentEvents.url && currentEvents.url !== opts.webhookUrl && !opts.force) {
    throw new Error(
      `Event webhook is already configured for ${currentEvents.url}. ` +
        `Pass --force to overwrite (this will redirect all future events to ${opts.webhookUrl}).`,
    )
  }
  if (eventSettingsMatch(currentEvents, desiredEvents)) {
    info(`  = webhook already configured for ${opts.webhookUrl}; nothing to change`)
  } else {
    await sg.setEventWebhookSettings(desiredEvents)
    info(`  ✓ webhook URL set to ${opts.webhookUrl}`)
  }

  const envSnippet = [
    `# Add to your environment (or .env file):`,
    `SENDGRID_WEBHOOK_VERIFICATION_KEY="${webhookKey.replace(/\n/g, '\\n')}"`,
  ].join('\n')

  info('')
  info('--- Done. Add to your environment ---')
  info(envSnippet)

  return {
    domains: domainResults,
    webhookKey,
    webhookUrl: opts.webhookUrl,
    envSnippet,
  }
}

// ---------------------------------------------------------------------------
// SendGrid API client
// ---------------------------------------------------------------------------

interface SendGridClient {
  findDomainAuth(domain: string): Promise<SgDomainAuth | null>
  createDomainAuth(input: { domain: string; subdomain: string }): Promise<SgDomainAuth>
  validateDomainAuth(id: number): Promise<boolean>
  getSignedWebhookSettings(): Promise<{ enabled?: boolean; public_key?: string }>
  enableSignedWebhook(): Promise<string>
  getEventWebhookSettings(): Promise<{ url?: string; enabled?: boolean; [k: string]: unknown }>
  setEventWebhookSettings(payload: Record<string, unknown>): Promise<void>
}

function sendgridClient(apiKey: string, fetchFn: typeof fetch): SendGridClient {
  const base = 'https://api.sendgrid.com/v3'
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetchFn(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as any) } })
    const text = await res.text()
    const body = text ? safeJson(text) : null
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `SendGrid rejected the request (HTTP ${res.status}). Your SENDGRID_API_KEY is missing the required permissions ` +
          'or is invalid. The key needs "Mail Settings" (Full Access) and "Sender Authentication" (Full Access). ' +
          'Manage keys at https://app.sendgrid.com/settings/api_keys.',
      )
    }
    if (!res.ok) {
      const message = body?.errors?.[0]?.message ?? text ?? res.statusText
      throw new Error(`SendGrid ${init.method ?? 'GET'} ${path} → ${res.status}: ${message}`)
    }
    return body
  }

  return {
    async findDomainAuth(domain: string) {
      const list: SgDomainAuth[] = (await call(`/whitelabel/domains?limit=200`)) ?? []
      return list.find((d) => d.domain === domain) ?? null
    },
    async createDomainAuth({ domain, subdomain }) {
      return call(`/whitelabel/domains`, {
        method: 'POST',
        body: JSON.stringify({ domain, subdomain, automatic_security: true }),
      }) as Promise<SgDomainAuth>
    },
    async validateDomainAuth(id: number) {
      const r = await call(`/whitelabel/domains/${id}/validate`, { method: 'POST' })
      return Boolean(r?.valid)
    },
    async getSignedWebhookSettings() {
      return call(`/user/webhooks/event/settings/signed`)
    },
    async enableSignedWebhook() {
      await call(`/user/webhooks/event/settings/signed`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      })
      const r = await call(`/user/webhooks/event/settings/signed`)
      if (!r?.public_key) throw new Error('SendGrid did not return a public_key for the signed event webhook')
      return r.public_key as string
    },
    async getEventWebhookSettings() {
      return call(`/user/webhooks/event/settings`)
    },
    async setEventWebhookSettings(payload) {
      await call(`/user/webhooks/event/settings`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJson(s: string): any {
  try { return JSON.parse(s) } catch { return null }
}

/** Compare current SendGrid event webhook settings to the desired payload.
 * Treats missing keys on `current` as "not yet set" rather than equal-to-false,
 * so a partially-configured webhook still triggers a PATCH. */
function eventSettingsMatch(current: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(desired)) {
    if (current[k] !== v) return false
  }
  return true
}
