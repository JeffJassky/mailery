/**
 * Every route mailery registers must read the same to Express 4 and Express 5.
 * The peer range allows both, and a 4.x host builds our routers with its own
 * Router(): optional groups (`{/:x}`), `?`, `+`, `*` and regex groups mean
 * different things — or nothing — across the two majors. 0.16.2 shipped a
 * click redirect with `{/:sig}`, which never matched under Express 4, so
 * every tracked link in every email 404'd. Plain `/literal/:param` segments
 * are the only portable vocabulary.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Router } from 'express'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { createPublicRouter } from '../../src/server/api/public.js'
import { createAdminRouter } from '../../src/server/api/admin.js'
import { createAgentRouter } from '../../src/server/api/agent.js'

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer()
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

const PORTABLE = /^[A-Za-z0-9_\-./:]+$/

/** Route paths reachable from a router, descending into mounted sub-routers. */
function routePaths(router: Router, prefix = ''): string[] {
  const out: string[] = []
  for (const layer of (router as any).stack ?? []) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
      for (const p of paths) out.push(prefix + String(p))
    } else if (layer.handle?.stack) {
      out.push(...routePaths(layer.handle, `${prefix}<mount>`))
    }
  }
  return out
}

describe('route path syntax is portable across Express 4 and 5', () => {
  it('public, admin and agent routers use only /literal/:param segments', () => {
    const routers: Array<[string, Router]> = [
      ['public', createPublicRouter(H.mailer)],
      ['admin', createAdminRouter(H.mailer)],
      ['agent', createAgentRouter(H.mailer, { tokens: [{ token: 'route-syntax-test-token-0123456789abcdef0123456789', actor: 'test' }] })],
    ]
    const offenders: string[] = []
    let seen = 0
    for (const [name, router] of routers) {
      for (const p of routePaths(router)) {
        seen++
        const bare = p.replace(/<mount>/g, '')
        if (!PORTABLE.test(bare)) offenders.push(`${name}: ${p}`)
      }
    }
    expect(seen).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })

  it('registers the click redirect with and without a signature segment', () => {
    const paths = routePaths(createPublicRouter(H.mailer))
    expect(paths).toContain('/click/:sendId/:linkId/:sig')
    expect(paths).toContain('/click/:sendId/:linkId')
  })
})
