#!/usr/bin/env node
/**
 * mailery CLI entry. Currently exposes a single command:
 *
 *   npx mailery setup-sendgrid --domain X --webhook-url Y [--cloudflare]
 *
 * See src/cli/setup-sendgrid.ts for the full option list.
 */

import { setupSendgrid } from './setup-sendgrid.js'
import { makeReadlinePrompter, runInteractive } from './interactive.js'

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printUsage()
    process.exit(cmd ? 0 : 1)
  }

  switch (cmd) {
    case 'setup-sendgrid': {
      const opts = parseArgs(argv.slice(1))
      const argDomains = collectStringList(opts.domain)
      const argWebhook = typeof opts['webhook-url'] === 'string' ? (opts['webhook-url'] as string) : null
      const explicitInteractive = Boolean(opts.interactive)
      const explicitNonInteractive = Boolean(opts['no-interactive'])

      // Decide interactive vs args. Interactive when: --interactive, OR no
      // required args provided AND we have a TTY. Force non-interactive with
      // --no-interactive (useful for CI).
      const wantsInteractive =
        explicitInteractive ||
        (!explicitNonInteractive && argDomains.length === 0 && !argWebhook && Boolean(process.stdin.isTTY))

      try {
        if (wantsInteractive) {
          const { prompter, close } = makeReadlinePrompter()
          let interactive
          try {
            interactive = await runInteractive(prompter, process.env)
          } finally {
            close()
          }
          if (!interactive.proceed) {
            console.log('Aborted.')
            process.exit(0)
          }
          await setupSendgrid({
            ...interactive.opts,
            env: { ...process.env, ...interactive.envOverrides },
          })
          if (interactive.exportLines.length > 0) {
            console.log('')
            console.log('Add these to your shell rc (e.g. ~/.zshrc) so future runs find them:')
            for (const line of interactive.exportLines) console.log(`  ${line}`)
          }
        } else {
          if (argDomains.length === 0) {
            console.error('error: --domain is required (repeat or comma-separate for multiple, or run without args for interactive mode)')
            printUsage()
            process.exit(2)
          }
          if (!argWebhook) {
            console.error('error: --webhook-url is required')
            printUsage()
            process.exit(2)
          }
          await setupSendgrid({
            domains: argDomains,
            subdomain: opts.subdomain ? String(opts.subdomain) : undefined,
            webhookUrl: argWebhook,
            cloudflare: Boolean(opts.cloudflare),
            cloudflareZone: opts['cloudflare-zone'] ? String(opts['cloudflare-zone']) : undefined,
            force: Boolean(opts.force),
          })
        }
      } catch (err: any) {
        console.error(`\n✗ ${err?.message ?? err}`)
        process.exit(1)
      }
      break
    }
    default:
      console.error(`unknown command: ${cmd}`)
      printUsage()
      process.exit(2)
  }
}

function parseArgs(argv: string[]): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {}
  function setKey(key: string, value: string | boolean) {
    const existing = out[key]
    if (existing === undefined) {
      out[key] = value
    } else if (Array.isArray(existing)) {
      if (typeof value === 'string') existing.push(value)
    } else if (typeof existing === 'string' && typeof value === 'string') {
      out[key] = [existing, value]
    } else {
      out[key] = value
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (!tok.startsWith('--')) continue
    const eq = tok.indexOf('=')
    if (eq > 0) {
      setKey(tok.slice(2, eq), tok.slice(eq + 1))
      continue
    }
    const key = tok.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      setKey(key, next)
      i++
    } else {
      setKey(key, true)
    }
  }
  return out
}

/** Collapse a repeated/comma-separated flag value into a clean string[]. */
function collectStringList(value: string | string[] | boolean | undefined): string[] {
  if (value === undefined || value === true || value === false) return []
  const raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
}

function printUsage() {
  console.log(`
mailery CLI

Usage:
  mailery setup-sendgrid                              (interactive — prompts you for everything)
  mailery setup-sendgrid --domain <d>[,<d>...] --webhook-url <u> [options]   (non-interactive)

Options:
  --domain <d>            Domain to authenticate. Repeat (or comma-separate)
                          to authenticate multiple in one run, e.g. when
                          isolating marketing from transactional. The event
                          webhook itself is account-level and only gets set up
                          once.
  --subdomain <s>         Sub-label for the link branding CNAME (default: em)
  --webhook-url <u>       Public URL for the SendGrid event webhook
  --cloudflare            Publish DNS records via the Cloudflare API
  --cloudflare-zone <z>   Override the inferred zone (e.g. for multi-label
                          public suffixes like .co.uk)
  --force                 Replace an existing event webhook URL if one is set
  --interactive           Force interactive mode even when args are supplied
  --no-interactive        Disable interactive mode even when args are missing
                          (the script exits with usage instead of prompting —
                          intended for CI / scripts)

Env vars:
  SENDGRID_API_KEY        Required. See https://app.sendgrid.com/settings/api_keys
                          Permissions: Mail Settings + Sender Authentication.
  CLOUDFLARE_API_TOKEN    Required when --cloudflare is set. See
                          https://dash.cloudflare.com/profile/api-tokens
                          Permissions: Zone:Read + DNS:Edit on the zone(s)
                          being published into.

Examples:
  # one domain
  mailery setup-sendgrid \\
    --domain news.example.com \\
    --webhook-url https://example.com/m/webhooks/sendgrid \\
    --cloudflare

  # marketing + transactional in one shot
  mailery setup-sendgrid \\
    --domain news.example.com \\
    --domain mail.example.com \\
    --webhook-url https://example.com/m/webhooks/sendgrid \\
    --cloudflare
`)
}

main()
