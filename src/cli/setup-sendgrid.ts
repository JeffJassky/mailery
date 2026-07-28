/**
 * `mailery setup-sendgrid` — one-shot wiring of SendGrid for a domain.
 *
 * Idempotent. Re-running converges: existing domain auths are reused, the event
 * webhook matching `--webhook-url` is updated in place (others on the account
 * are never touched), existing Cloudflare DNS records with the correct values
 * are left alone.
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
  /** Where SendGrid should POST event webhooks. One webhook per install, regardless of domain count. */
  webhookUrl: string
  /** `friendly_name` for a newly created webhook, so the SendGrid dashboard shows which app owns it. */
  webhookName?: string
  /** Publish DNS records via Cloudflare API. Requires CLOUDFLARE_API_TOKEN. */
  cloudflare?: boolean
  /** Override the parent zone if any domain isn't a subdomain of its eTLD+1. */
  cloudflareZone?: string
  /**
   * Legacy single-webhook accounts only: repoint the account's one event webhook
   * at `webhookUrl`. Ignored on accounts exposing the multi-webhook API, where a
   * new webhook is created alongside the existing ones instead.
   */
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
  /** SendGrid's id for this install's webhook. Absent on legacy single-webhook accounts. */
  webhookId?: string
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
  info('=== Event webhook ===')

  // ---- Resolve this install's event webhook -------------------------------
  // SendGrid's legacy endpoints (`/user/webhooks/event/settings`, `/settings/signed`)
  // present the account as if it had exactly one event webhook: a PATCH there
  // repoints whichever webhook is oldest by created_date. On an account shared
  // with another mailery install (or staging alongside prod) that silently
  // steals its events — no error anywhere, the other endpoint just stops being
  // called, so its suppression list quietly freezes. Prefer the multi-webhook
  // endpoints, which address webhooks by id, and match on url so each install
  // only ever touches its own. Fall back to the legacy singleton only when the
  // account/key can't see `/settings/all`.
  info('SendGrid → checking Event Webhook…')
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

  const listed = await sg.listEventWebhooks()
  const existing = listed.webhooks.find((w) => sameWebhookUrl(w.url, opts.webhookUrl))
  let webhookId: string | undefined

  if (listed.mode === 'multi' && existing && !existing.id) {
    // Without an id the only way to write is the account-wide endpoint, which
    // repoints the oldest webhook — possibly someone else's. Stop instead.
    throw new Error(
      `SendGrid listed an event webhook for ${opts.webhookUrl} but did not return an id for it, so it can't be ` +
        `updated without risking another webhook on the account. Update it from the SendGrid dashboard instead.`,
    )
  }

  if (listed.mode === 'multi' && existing) {
    webhookId = existing.id
    const label = ` #${existing.id}`
    if (eventSettingsMatch(existing, desiredEvents)) {
      info(`  = webhook${label} already configured for ${opts.webhookUrl}; nothing to change`)
    } else {
      await sg.updateEventWebhook(existing.id!, desiredEvents)
      info(`  ✓ webhook${label} updated for ${opts.webhookUrl}`)
    }
  } else if (listed.mode === 'multi') {
    const friendlyName = (opts.webhookName ?? defaultWebhookName(opts.webhookUrl, opts.domains)).slice(0, 64)
    const created = await sg.createEventWebhook({ ...desiredEvents, friendly_name: friendlyName })
    webhookId = created.id
    info(`  + created event webhook${created.id ? ` #${created.id}` : ''} → ${opts.webhookUrl} ("${friendlyName}")`)
    if (listed.webhooks.length > 0) {
      info(`  = ${listed.webhooks.length} other event webhook(s) on this account left untouched`)
      if (opts.force) info('    (--force had no effect: other webhooks are never repointed on this account)')
    }
  } else {
    // Legacy singleton account: there is only one webhook slot, so pointing it
    // at our URL takes it away from whoever had it. Refuse unless --force.
    const current = listed.webhooks[0] ?? {}
    if (current.url && !sameWebhookUrl(current.url, opts.webhookUrl)) {
      if (!opts.force) {
        throw new Error(
          `This SendGrid account only exposes the legacy single-webhook API, and its event webhook is already ` +
            `pointed at ${current.url}. Repointing it would silently stop event delivery to whatever consumes ` +
            `that URL (bounces, spam reports and unsubscribes would stop ingesting there). Pass --force to ` +
            `repoint it to ${opts.webhookUrl} anyway.`,
        )
      }
      warn(`  ! repointing the account's only event webhook away from ${current.url} (--force)`)
    }
    if (eventSettingsMatch(current, desiredEvents)) {
      info(`  = webhook already configured for ${opts.webhookUrl}; nothing to change`)
    } else {
      await sg.setEventWebhookSettings(desiredEvents)
      info(`  ✓ webhook URL set to ${opts.webhookUrl}`)
    }
  }

  // ---- Enable Signed Event Webhook + fetch this webhook's public key ------
  info('SendGrid → checking Signed Event Webhook…')
  // GET /user/webhooks/event/settings/signed[/{id}] returns `{ public_key }`
  // (plus `id` on the multi form). A non-empty key implies signing is already
  // enabled — re-PATCHing `enabled: true` rotates the keypair, silently
  // breaking signature verification everywhere the old key was deployed.
  const signed = await sg.getSignedWebhookSettings(webhookId)
  let webhookKey: string
  if (signed.public_key) {
    info('  = signing already enabled; reusing existing public key')
    webhookKey = signed.public_key
  } else {
    info('  → enabling signing')
    webhookKey = await sg.enableSignedWebhook(webhookId)
    info('  ✓ verification key fetched')
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
    webhookId,
    envSnippet,
  }
}

// ---------------------------------------------------------------------------
// SendGrid API client
// ---------------------------------------------------------------------------

interface SgEventWebhook {
  id?: string
  url?: string
  friendly_name?: string
  enabled?: boolean
  public_key?: string | null
  [k: string]: unknown
}

interface SgEventWebhookList {
  /** 'multi' when `/settings/all` answered; 'legacy' when only the singleton endpoint is available. */
  mode: 'multi' | 'legacy'
  webhooks: SgEventWebhook[]
}

interface SendGridClient {
  findDomainAuth(domain: string): Promise<SgDomainAuth | null>
  createDomainAuth(input: { domain: string; subdomain: string }): Promise<SgDomainAuth>
  validateDomainAuth(id: number): Promise<boolean>
  getSignedWebhookSettings(id?: string): Promise<{ id?: string; public_key?: string }>
  enableSignedWebhook(id?: string): Promise<string>
  listEventWebhooks(): Promise<SgEventWebhookList>
  createEventWebhook(payload: Record<string, unknown>): Promise<SgEventWebhook>
  updateEventWebhook(id: string, payload: Record<string, unknown>): Promise<void>
  /** Legacy singleton PATCH — repoints the account's oldest webhook. Fallback only. */
  setEventWebhookSettings(payload: Record<string, unknown>): Promise<void>
}

function sendgridClient(apiKey: string, fetchFn: typeof fetch): SendGridClient {
  const base = 'https://api.sendgrid.com/v3'
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }

  async function call(path: string, init: RequestInit = {}, o: { soft404?: boolean } = {}): Promise<any> {
    const res = await fetchFn(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as any) } })
    const text = await res.text()
    const body = text ? safeJson(text) : null
    if (o.soft404 && res.status === 404) return null
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

  /** Per-webhook signing key when we know the id; account-oldest fallback when we don't. */
  const signedPath = (id?: string) =>
    `/user/webhooks/event/settings/signed${id ? `/${encodeURIComponent(id)}` : ''}`

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
    async getSignedWebhookSettings(id?: string) {
      return call(signedPath(id))
    },
    async enableSignedWebhook(id?: string) {
      // PATCH returns `{ id, public_key }`; re-GET only if some proxy strips it.
      const patched = await call(signedPath(id), {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      })
      if (patched?.public_key) return patched.public_key as string
      const r = await call(signedPath(id))
      if (!r?.public_key) throw new Error('SendGrid did not return a public_key for the signed event webhook')
      return r.public_key as string
    },
    async listEventWebhooks(): Promise<SgEventWebhookList> {
      const all = await call(`/user/webhooks/event/settings/all`, {}, { soft404: true })
      const multi = Array.isArray(all) ? all : all?.webhooks
      if (Array.isArray(multi)) return { mode: 'multi', webhooks: multi as SgEventWebhook[] }
      const legacy = await call(`/user/webhooks/event/settings`)
      return { mode: 'legacy', webhooks: legacy ? [legacy as SgEventWebhook] : [] }
    },
    async createEventWebhook(payload) {
      return call(`/user/webhooks/event/settings`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }) as Promise<SgEventWebhook>
    },
    async updateEventWebhook(id, payload) {
      await call(`/user/webhooks/event/settings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
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

/** Match a SendGrid-reported webhook URL against the one we were asked to configure.
 * Exact compare apart from a trailing slash — anything looser risks adopting (and
 * then rewriting) a webhook that belongs to a different app. */
function sameWebhookUrl(a: string | undefined | null, b: string): boolean {
  if (!a) return false
  const norm = (u: string) => u.trim().replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/** `friendly_name` for a webhook we create, so the SendGrid dashboard shows its owner. */
function defaultWebhookName(webhookUrl: string, domains: string[]): string {
  let host = ''
  try {
    host = new URL(webhookUrl).host
  } catch {
    // Non-absolute URL — fall back to the first domain being authenticated.
  }
  return `mailery ${host || domains[0] || 'events'}`
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
