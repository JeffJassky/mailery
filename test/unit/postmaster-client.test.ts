/**
 * Postmaster API client: token refresh caching + traffic-stats fetch shape.
 * Uses a stubbed fetcher so we don't hit Google.
 */

import { describe, expect, it } from 'vitest'

import { createPostmasterClient, type Fetcher } from '../../src/server/runner/postmaster.js'

function mockFetcher(handlers: Record<string, (init?: RequestInit) => Response>): Fetcher {
  return async (url, init) => {
    const handler = handlers[url]
    if (!handler) throw new Error(`unexpected URL: ${url}`)
    return handler(init)
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('PostmasterClient', () => {
  it('refreshes the access token once and reuses it within expiry', async () => {
    let tokenRefreshes = 0
    let trafficGets = 0
    const fetcher = mockFetcher({
      'https://oauth2.googleapis.com/token': () => {
        tokenRefreshes++
        return jsonResponse({ access_token: 'tok-1', expires_in: 3600 })
      },
      'https://gmailpostmastertools.googleapis.com/v1/domains/example.com/trafficStats?pageSize=1': () => {
        trafficGets++
        return jsonResponse({
          trafficStats: [
            { name: 'domains/example.com/trafficStats/20240115', domainReputation: 'HIGH' },
          ],
        })
      },
    })

    const client = createPostmasterClient(
      { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
      fetcher,
    )

    await client.getLatestTrafficStats('example.com')
    await client.getLatestTrafficStats('example.com')
    await client.getLatestTrafficStats('example.com')

    expect(tokenRefreshes).toBe(1) // cached
    expect(trafficGets).toBe(3)
  })

  it('throws a useful error when the OAuth refresh fails', async () => {
    const fetcher = mockFetcher({
      'https://oauth2.googleapis.com/token': () =>
        new Response('{"error":"invalid_grant"}', { status: 400 }),
    })
    const client = createPostmasterClient(
      { clientId: 'c', clientSecret: 's', refreshToken: 'bad' },
      fetcher,
    )
    await expect(client.getLatestTrafficStats('example.com')).rejects.toThrow(/invalid_grant|400/)
  })

  it('returns null when Postmaster reports no trafficStats for a domain', async () => {
    const fetcher = mockFetcher({
      'https://oauth2.googleapis.com/token': () =>
        jsonResponse({ access_token: 'tok-1', expires_in: 3600 }),
      'https://gmailpostmastertools.googleapis.com/v1/domains/quiet.example.com/trafficStats?pageSize=1': () =>
        jsonResponse({}),
    })
    const client = createPostmasterClient(
      { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
      fetcher,
    )
    const stat = await client.getLatestTrafficStats('quiet.example.com')
    expect(stat).toBeNull()
  })
})
