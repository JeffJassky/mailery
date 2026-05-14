import { describe, expect, it } from 'vitest'
import { buildDmarcRecord, setupDmarc } from '../../src/cli/setup-dmarc.js'

describe('buildDmarcRecord', () => {
  it('builds a monitor-mode record with defaults', () => {
    const v = buildDmarcRecord({
      policy: 'none',
      rua: 'dmarc@example.com',
      pct: 100,
      aspf: 'r',
      adkim: 'r',
    })
    expect(v).toBe('v=DMARC1; p=none; rua=mailto:dmarc@example.com')
  })

  it('includes ruf when set', () => {
    const v = buildDmarcRecord({
      policy: 'quarantine',
      rua: 'dmarc@example.com',
      ruf: 'forensic@example.com',
      pct: 100,
      aspf: 'r',
      adkim: 'r',
    })
    expect(v).toContain('ruf=mailto:forensic@example.com')
  })

  it('only emits pct when not 100', () => {
    const v100 = buildDmarcRecord({ policy: 'quarantine', rua: 'd@x.com', pct: 100, aspf: 'r', adkim: 'r' })
    const v10 = buildDmarcRecord({ policy: 'quarantine', rua: 'd@x.com', pct: 10, aspf: 'r', adkim: 'r' })
    expect(v100).not.toContain('pct=')
    expect(v10).toContain('pct=10')
  })

  it('only emits aspf/adkim when strict', () => {
    const relaxed = buildDmarcRecord({ policy: 'none', rua: 'd@x.com', pct: 100, aspf: 'r', adkim: 'r' })
    const strict = buildDmarcRecord({ policy: 'none', rua: 'd@x.com', pct: 100, aspf: 's', adkim: 's' })
    expect(relaxed).not.toContain('aspf')
    expect(relaxed).not.toContain('adkim')
    expect(strict).toContain('aspf=s')
    expect(strict).toContain('adkim=s')
  })
})

describe('setupDmarc input validation', () => {
  it('rejects missing domain', async () => {
    await expect(
      setupDmarc({ domain: '', ruaMailbox: 'd@x.com', logger: {} }),
    ).rejects.toThrow(/domain/i)
  })

  it('rejects missing rua-mailbox', async () => {
    await expect(
      setupDmarc({ domain: 'x.com', ruaMailbox: '', logger: {} }),
    ).rejects.toThrow(/rua-mailbox/i)
  })

  it('rejects invalid rua email', async () => {
    await expect(
      setupDmarc({ domain: 'x.com', ruaMailbox: 'not-an-email', logger: {} }),
    ).rejects.toThrow(/valid email/i)
  })

  it('rejects out-of-range pct', async () => {
    await expect(
      setupDmarc({ domain: 'x.com', ruaMailbox: 'd@x.com', pct: 0, logger: {} }),
    ).rejects.toThrow(/pct/)
  })

  it('runs without --cloudflare and reports manual-publish flow', async () => {
    const logs: string[] = []
    const result = await setupDmarc({
      domain: 'news.example.com',
      ruaMailbox: 'dmarc@example.com',
      policy: 'none',
      logger: { log: (s: unknown) => logs.push(String(s)) },
    })
    expect(result.recordHost).toBe('_dmarc.news.example.com')
    expect(result.recordValue).toContain('v=DMARC1')
    expect(result.cloudflarePushed).toBe('skipped')
    expect(logs.join('\n')).toContain('Add this record to your DNS provider')
  })

  it('publishes via Cloudflare when --cloudflare is set', async () => {
    const calls: string[] = []
    const fetchFn: typeof fetch = (url: any, init: any = {}) => {
      const u = String(url)
      calls.push(`${init.method ?? 'GET'} ${u}`)
      if (u.includes('/zones?name=')) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, result: [{ id: 'zone1' }] }), { status: 200 }))
      }
      if (u.includes('/dns_records?type=TXT')) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, result: [] }), { status: 200 }))
      }
      if (init.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ success: true, result: { id: 'rec1' } }), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    const result = await setupDmarc({
      domain: 'news.example.com',
      ruaMailbox: 'dmarc@example.com',
      cloudflare: true,
      env: { CLOUDFLARE_API_TOKEN: 'cf-test' },
      fetchFn,
      logger: {},
    })
    expect(result.cloudflarePushed).toBe('created')
    expect(calls.some((c) => c.includes('POST'))).toBe(true)
  })
})
