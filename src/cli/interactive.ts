/**
 * Interactive wizard for `mailery setup-sendgrid`. Walks the user through:
 *   - Required env vars (offers to paste them in, then prints export lines)
 *   - Domains (accept multiple via repeated entry or comma-separation)
 *   - Webhook URL (with a default derived from the first domain's apex)
 *   - Cloudflare toggle + zone override
 *   - Force flag
 *
 * Renders a summary before any API call and asks for confirmation. All
 * questions are funneled through a `Prompter` so tests can inject canned
 * answers without touching stdin.
 */

import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import type { SetupSendgridOpts } from './setup-sendgrid.js'

export type Prompter = (question: string, opts?: { defaultValue?: string }) => Promise<string>

export interface InteractiveResult {
  opts: Omit<SetupSendgridOpts, 'fetchFn' | 'logger' | 'env'>
  envOverrides: Record<string, string>
  exportLines: string[]
  proceed: boolean
}

export function makeReadlinePrompter(): { prompter: Prompter; close: () => void } {
  const rl = readline.createInterface({ input, output })
  const prompter: Prompter = async (q, opts) => {
    const suffix = opts?.defaultValue ? ` [${opts.defaultValue}]` : ''
    const raw = await rl.question(`${q}${suffix}: `)
    const trimmed = raw.trim()
    return trimmed.length === 0 && opts?.defaultValue ? opts.defaultValue : trimmed
  }
  return { prompter, close: () => rl.close() }
}

export async function runInteractive(
  prompter: Prompter,
  env: Record<string, string | undefined>,
  logger: { log: (...a: unknown[]) => void } = console,
): Promise<InteractiveResult> {
  const log = (m: string) => logger.log(m)
  const exportLines: string[] = []
  const envOverrides: Record<string, string> = {}

  log('')
  log('mailery setup-sendgrid (interactive)')
  log('────────────────────────────────────')
  log('')

  // ---- SendGrid API key ---------------------------------------------------
  if (!env.SENDGRID_API_KEY) {
    log('SENDGRID_API_KEY is not set in your environment.')
    log('  Create one at https://app.sendgrid.com/settings/api_keys')
    log('  Permissions: Mail Settings (Full Access) + Sender Authentication (Full Access).')
    log('')
    const key = await prompter('Paste your SendGrid API key (starts with SG.)')
    if (!key) throw new Error('SENDGRID_API_KEY is required')
    envOverrides.SENDGRID_API_KEY = key
    exportLines.push(`export SENDGRID_API_KEY="${key}"`)
  }

  // ---- Domains ------------------------------------------------------------
  log('')
  log('Which sender domain(s) do you want to authenticate?')
  log('  Examples:')
  log('    news.example.com                          (one)')
  log('    news.example.com, mail.example.com        (two — comma-separated, in one line)')
  log('  Splitting marketing from transactional onto separate domains is recommended.')
  log('')
  const domainsRaw = await prompter('Domains')
  const domains = domainsRaw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
  if (domains.length === 0) throw new Error('at least one --domain is required')

  // ---- Webhook URL --------------------------------------------------------
  const defaultWebhook = `https://${apex(domains[0]!)}/m/webhooks/sendgrid`
  log('')
  log('SendGrid will POST event webhooks to this URL.')
  log('  This must be reachable from the public internet (not behind admin auth).')
  log('')
  const webhookUrl = await prompter('Webhook URL', { defaultValue: defaultWebhook })

  // ---- Cloudflare ---------------------------------------------------------
  log('')
  const cloudflareRaw = await prompter('Publish DNS records via Cloudflare API? (y/N)', { defaultValue: 'n' })
  const cloudflare = /^y/i.test(cloudflareRaw)
  let cloudflareZone: string | undefined

  if (cloudflare) {
    if (!env.CLOUDFLARE_API_TOKEN) {
      log('')
      log('CLOUDFLARE_API_TOKEN is not set in your environment.')
      log('  Create one at https://dash.cloudflare.com/profile/api-tokens')
      log('  Use the "Edit zone DNS" template, restricted to your zone(s).')
      log('  Permissions: Zone:Read + DNS:Edit.')
      log('')
      const token = await prompter('Paste your Cloudflare API token')
      if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required when publishing via Cloudflare')
      envOverrides.CLOUDFLARE_API_TOKEN = token
      exportLines.push(`export CLOUDFLARE_API_TOKEN="${token}"`)
    }
    log('')
    const zoneOverride = await prompter('Override Cloudflare zone (blank to infer per-domain)', { defaultValue: '' })
    if (zoneOverride.length > 0) cloudflareZone = zoneOverride
  }

  // ---- Force --------------------------------------------------------------
  log('')
  const forceRaw = await prompter(
    'If a different webhook URL is already configured on this SendGrid account, overwrite it? (y/N)',
    { defaultValue: 'n' },
  )
  const force = /^y/i.test(forceRaw)

  // ---- Summary + confirm --------------------------------------------------
  log('')
  log('About to run setup with:')
  log(`  domains:       ${domains.join(', ')}`)
  log(`  webhook URL:   ${webhookUrl}`)
  log(`  cloudflare:    ${cloudflare ? 'yes' : 'no'}`)
  if (cloudflareZone) log(`  cloudflare zone: ${cloudflareZone}`)
  log(`  force:         ${force ? 'yes' : 'no'}`)
  log('')
  const confirmRaw = await prompter('Proceed? (Y/n)', { defaultValue: 'y' })
  const proceed = !/^n/i.test(confirmRaw)

  return {
    opts: { domains, webhookUrl, cloudflare, cloudflareZone, force },
    envOverrides,
    exportLines,
    proceed,
  }
}

/** Strip a leading sub-label so we get the apex (best-effort for webhook URL default). */
function apex(domain: string): string {
  const labels = domain.split('.').filter(Boolean)
  if (labels.length <= 2) return domain
  return labels.slice(-2).join('.')
}
