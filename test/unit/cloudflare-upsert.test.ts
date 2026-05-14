/**
 * Regression: Cloudflare returns TXT record content quoted ("v=DMARC1; ...")
 * even when the desired value isn't quoted. The previous `match.content ===
 * rec.data` equality test never matched, so every run issued a PUT.
 */
import { describe, expect, it } from 'vitest'
import { cloudflareClient } from '../../src/cli/cloudflare.js'

interface Call {
  method: string
  url: string
  body?: string
}

function fakeFetch(handlers: Record<string, (call: Call) => Response>): typeof fetch {
  return (async (url: any, init: any = {}) => {
    const key = `${init.method ?? 'GET'} ${String(url)}`
    const matcher = Object.keys(handlers).find((p) => key.includes(p))
    if (!matcher) throw new Error(`unexpected ${key}`)
    return handlers[matcher]!({ method: init.method ?? 'GET', url: String(url), body: init.body })
  }) as typeof fetch
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('cloudflareClient.upsertRecord — TXT quote normalization', () => {
  it('treats CF-quoted TXT content as equal to unquoted desired and skips PUT', async () => {
    let putCalls = 0
    const fetch = fakeFetch({
      'GET https://api.cloudflare.com/client/v4/zones/zone1/dns_records?type=TXT': () =>
        json({
          success: true,
          result: [
            {
              id: 'rec1',
              type: 'TXT',
              name: '_dmarc.example.com',
              // Cloudflare wraps in quotes when content has special chars.
              content: '"v=DMARC1; p=none; rua=mailto:d@x.com"',
              proxied: false,
            },
          ],
        }),
      'PUT https://api.cloudflare.com/client/v4/zones/zone1/dns_records/rec1': () => {
        putCalls++
        return json({ success: true, result: {} })
      },
    })

    const cf = cloudflareClient('test-token', fetch)
    const result = await cf.upsertRecord('zone1', {
      type: 'TXT',
      host: '_dmarc.example.com',
      data: 'v=DMARC1; p=none; rua=mailto:d@x.com',
    })
    expect(result).toBe('noop')
    expect(putCalls).toBe(0)
  })

  it('treats CF split-quoted TXT (>255 char DNS segments) as equal to unquoted', async () => {
    let putCalls = 0
    const long = 'a'.repeat(260) // > 255-char DNS string segment limit
    const splitForm = `"${long.slice(0, 255)}" "${long.slice(255)}"`
    const fetch = fakeFetch({
      'GET https://api.cloudflare.com/client/v4/zones/zone1/dns_records?type=TXT': () =>
        json({
          success: true,
          result: [
            {
              id: 'rec1',
              type: 'TXT',
              name: '_dmarc.example.com',
              content: splitForm,
              proxied: false,
            },
          ],
        }),
      'PUT https://api.cloudflare.com/client/v4/zones/zone1/dns_records/rec1': () => {
        putCalls++
        return json({ success: true, result: {} })
      },
    })

    const cf = cloudflareClient('test-token', fetch)
    const result = await cf.upsertRecord('zone1', {
      type: 'TXT',
      host: '_dmarc.example.com',
      data: long,
    })
    expect(result).toBe('noop')
    expect(putCalls).toBe(0)
  })

  it('still PUTs when CF-quoted content differs', async () => {
    let putCalls = 0
    const fetch = fakeFetch({
      'GET https://api.cloudflare.com/client/v4/zones/zone1/dns_records?type=TXT': () =>
        json({
          success: true,
          result: [
            {
              id: 'rec1',
              type: 'TXT',
              name: '_dmarc.example.com',
              content: '"v=DMARC1; p=quarantine; rua=mailto:d@x.com"',
              proxied: false,
            },
          ],
        }),
      'PUT https://api.cloudflare.com/client/v4/zones/zone1/dns_records/rec1': () => {
        putCalls++
        return json({ success: true, result: {} })
      },
    })

    const cf = cloudflareClient('test-token', fetch)
    const result = await cf.upsertRecord('zone1', {
      type: 'TXT',
      host: '_dmarc.example.com',
      data: 'v=DMARC1; p=none; rua=mailto:d@x.com',
    })
    expect(result).toBe('updated')
    expect(putCalls).toBe(1)
  })
})
