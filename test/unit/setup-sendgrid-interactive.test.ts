/**
 * Interactive wizard for setup-sendgrid. Drives the prompter with canned
 * answers so we can verify each branch (env-var-pasting, multi-domain,
 * cloudflare path, default acceptance, abort).
 */

import { describe, it, expect } from 'vitest'

import { runInteractive, type Prompter } from '../../src/cli/interactive.js'

function scriptedPrompter(answers: string[]): { prompter: Prompter; remaining: () => number } {
  const queue = [...answers]
  const prompter: Prompter = async (_q, opts) => {
    const next = queue.shift()
    if (next === undefined) throw new Error('prompter ran out of canned answers')
    return next === '' && opts?.defaultValue ? opts.defaultValue : next
  }
  return { prompter, remaining: () => queue.length }
}

const silent = { log: () => {} }

describe('runInteractive', () => {
  it('happy path: two domains, default webhook url, no cloudflare, proceed', async () => {
    const { prompter } = scriptedPrompter([
      'news.example.com, mail.example.com', // domains
      '',                                    // webhook URL (accept default)
      'n',                                   // cloudflare
      'n',                                   // force
      '',                                    // proceed (default yes)
    ])
    const result = await runInteractive(
      prompter,
      { SENDGRID_API_KEY: 'SG.test' },
      silent,
    )
    expect(result.proceed).toBe(true)
    expect(result.opts.domains).toEqual(['news.example.com', 'mail.example.com'])
    expect(result.opts.webhookUrl).toBe('https://example.com/m/webhooks/sendgrid')
    expect(result.opts.cloudflare).toBe(false)
    expect(result.opts.force).toBe(false)
    expect(result.envOverrides).toEqual({})
    expect(result.exportLines).toEqual([])
  })

  it('prompts for SENDGRID_API_KEY when missing and emits an export line', async () => {
    const { prompter } = scriptedPrompter([
      'SG.pasted-key',
      'example.com',
      'https://example.com/m/w',
      'n',
      'n',
      'y',
    ])
    const result = await runInteractive(prompter, {}, silent)
    expect(result.envOverrides).toEqual({ SENDGRID_API_KEY: 'SG.pasted-key' })
    expect(result.exportLines).toContain('export SENDGRID_API_KEY="SG.pasted-key"')
  })

  it('cloudflare branch prompts for and exports CLOUDFLARE_API_TOKEN when missing', async () => {
    const { prompter } = scriptedPrompter([
      'example.com',
      'https://example.com/m/w',
      'y',                  // cloudflare yes
      'cf-token-pasted',    // token
      '',                   // zone override (blank — infer)
      'n',                  // force
      'y',                  // proceed
    ])
    const result = await runInteractive(prompter, { SENDGRID_API_KEY: 'SG.test' }, silent)
    expect(result.opts.cloudflare).toBe(true)
    expect(result.opts.cloudflareZone).toBeUndefined()
    expect(result.envOverrides).toEqual({ CLOUDFLARE_API_TOKEN: 'cf-token-pasted' })
    expect(result.exportLines).toContain('export CLOUDFLARE_API_TOKEN="cf-token-pasted"')
  })

  it('respects explicit Cloudflare zone override', async () => {
    const { prompter } = scriptedPrompter([
      'mail.example.co.uk',
      'https://example.co.uk/m/w',
      'y',
      // CLOUDFLARE_API_TOKEN already in env, no prompt for that
      'example.co.uk',  // zone override
      'n',
      'y',
    ])
    const result = await runInteractive(
      prompter,
      { SENDGRID_API_KEY: 'SG.test', CLOUDFLARE_API_TOKEN: 'cf-existing' },
      silent,
    )
    expect(result.opts.cloudflareZone).toBe('example.co.uk')
    expect(result.envOverrides).toEqual({}) // env already had the token
  })

  it('aborts when user answers no to proceed', async () => {
    const { prompter } = scriptedPrompter([
      'example.com',
      'https://example.com/m/w',
      'n', 'n',
      'n',  // proceed → no
    ])
    const result = await runInteractive(prompter, { SENDGRID_API_KEY: 'SG.test' }, silent)
    expect(result.proceed).toBe(false)
  })

  it('throws if user enters blank domains', async () => {
    const { prompter } = scriptedPrompter([
      'SG.k',
      '',                      // domains: empty
    ])
    await expect(runInteractive(prompter, {}, silent)).rejects.toThrow(/at least one --domain/i)
  })

  it('--force=yes propagates', async () => {
    const { prompter } = scriptedPrompter([
      'example.com',
      'https://example.com/m/w',
      'n',
      'y',   // force
      'y',
    ])
    const result = await runInteractive(prompter, { SENDGRID_API_KEY: 'SG.test' }, silent)
    expect(result.opts.force).toBe(true)
  })
})
