/**
 * GET /api/events — the registry reports volume and recency per event name,
 * so a registered trigger can be checked against what actually fires.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { request } from 'http'
import type { AddressInfo } from 'net'

import { createAdminRouter } from '../../src/server/api/admin.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

let H: TestMailerHarness
let baseUrl: string
let server: ReturnType<typeof express>['listen'] extends (...a: any) => infer R ? R : never

beforeAll(async () => {
  H = await createTestMailer({})
  H.mailer.registerEvent({ name: 'Created', dedupePolicy: 'once-per-contact' })
  H.mailer.registerEvent({ name: 'Exported', dedupePolicy: 'every-time' })
  H.mailer.registerEvent({ name: 'Never Fired', dedupePolicy: 'once-per-contact' })
  const app = express()
  app.use(express.json())
  app.use('/admin/mailer', createAdminRouter(H.mailer))
  server = app.listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  server?.close()
  if (H) await H.stop()
})

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET' }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/events', () => {
  it('reports total, recent and last-seen per name, and nothing for a trigger nobody fires', async () => {
    await H.mailer.fire('Created', 'u1')
    await H.mailer.fire('Created', 'u2')
    await H.mailer.fire('Exported', 'u1')
    await H.mailer.fire('Exported', 'u1')
    // An old, unregistered row: seen, counted, but outside every window.
    const old = new Date(Date.now() - 45 * 86_400_000)
    await H.mailer.collections.events.insertOne({
      externalId: 'u9', name: 'windows', properties: {}, dedupeKey: 'legacy:u9:windows', occurredAt: old, createdAt: old,
    })

    const { status, body } = await get('/admin/mailer/api/events')
    expect(status).toBe(200)
    expect(body.registered.map((r: any) => r.name)).toEqual(['Created', 'Exported', 'Never Fired'])
    expect(body.seen).toEqual(['windows'])

    expect(body.stats.Created).toMatchObject({ total: 2, last7d: 2, last30d: 2 })
    expect(body.stats.Exported).toMatchObject({ total: 2, last7d: 2, last30d: 2 })
    expect(new Date(body.stats.Created.lastAt).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(body.stats.windows).toMatchObject({ total: 1, last7d: 0, last30d: 0 })
    expect(new Date(body.stats.windows.firstAt).getTime()).toBe(old.getTime())
    expect(body.stats['Never Fired']).toBeUndefined()
  })
})
