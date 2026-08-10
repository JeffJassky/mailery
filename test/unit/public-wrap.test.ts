/**
 * Unit tests for the public router's async wrapper (`src/server/api/wrap.ts`).
 *
 * Two things matter here and nowhere else:
 *   1. a rejecting handler never becomes an unhandled rejection (which, under
 *      Node's default --unhandled-rejections=throw, kills the host process —
 *      an unauthenticated DoS, since every public route is reachable by anyone)
 *   2. the `headersSent` branch. Public routes respond *before* doing their
 *      work (INVARIANT 8), so a rejection almost always arrives after the
 *      response is on the wire; anything that tries to write again there
 *      produces ERR_HTTP_HEADERS_SENT.
 *
 * The route-level behaviour is covered in
 * test/integration/public-hardening.test.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'

import { consoleRouteLogger, wrap, type RouteLogger } from '../../src/server/api/wrap.js'

// --- a recording logger ------------------------------------------------------

interface Recorded {
  fields: Record<string, unknown>
  msg?: string
}

function recordingLogger(): RouteLogger & { errors: Recorded[]; warns: Recorded[] } {
  const errors: Recorded[] = []
  const warns: Recorded[] = []
  return {
    errors,
    warns,
    error: (fields, msg) => { errors.push({ fields, msg }) },
    warn: (fields, msg) => { warns.push({ fields, msg }) },
  }
}

// --- a live express app exercising the wrapper -------------------------------

const logger = recordingLogger()
let baseUrl: string
let server: ReturnType<express.Express['listen']>

/** Rejections that escaped to the process. Must stay empty. */
const escaped: unknown[] = []
const onUnhandled = (err: unknown) => { escaped.push(err) }

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)

  const app = express()

  // Compute-then-respond, like the admin router: a rejection arrives before
  // any header is written, so the wrapper can still answer.
  app.get('/before-headers', wrap(logger, async () => {
    throw new Error('boom-before')
  }))

  // Respond-then-work, like /open, POST /unsub and /webhooks: the client
  // already has its response when the rejection happens.
  app.get('/after-headers', wrap(logger, async (_req, res) => {
    res.status(200).type('text/plain').send('already sent')
    await Promise.resolve()
    throw new Error('boom-after')
  }))

  // A synchronous throw, which is not a promise rejection at all but must be
  // handled identically.
  app.get('/sync-throw', wrap(logger, () => {
    throw new Error('boom-sync')
  }))

  app.get('/ok', wrap(logger, async (_req, res) => {
    res.status(200).json({ ok: true })
  }))

  // Host error handler that naively writes. Reached only if the wrapper
  // forwards a post-headers error, which it must not.
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(599).json({ reachedHostErrorHandler: true })
  })

  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled)
  server?.close()
})

afterEach(() => {
  logger.errors.length = 0
  logger.warns.length = 0
})

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET' }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Let any stray rejection reach the process before we assert it did not. */
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('wrap — over a real express app', () => {
  it('passes a successful handler through untouched', async () => {
    const res = await get('/ok')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(logger.errors).toHaveLength(0)
  })

  it('answers 500 when the handler rejects before responding', async () => {
    const res = await get('/before-headers')
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' })
    expect(logger.errors).toHaveLength(1)
    expect((logger.errors[0]!.fields.err as Error).message).toBe('boom-before')
    expect(logger.errors[0]!.fields.path).toBe('/before-headers')
  })

  it('answers 500 on a synchronous throw too', async () => {
    const res = await get('/sync-throw')
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' })
    expect(logger.errors).toHaveLength(1)
  })

  it('logs and swallows when the response was already sent', async () => {
    const res = await get('/after-headers')
    // The client keeps the response it was already given...
    expect(res.status).toBe(200)
    expect(res.body).toBe('already sent')
    // ...the failure is still recorded...
    expect(logger.errors).toHaveLength(1)
    expect((logger.errors[0]!.fields.err as Error).message).toBe('boom-after')
    // ...and the host's error handler is never reached, because writing there
    // post-headers is exactly the ERR_HTTP_HEADERS_SENT crash we are avoiding.
    expect(res.body).not.toContain('reachedHostErrorHandler')
  })

  it('never lets a rejection escape to the process', async () => {
    await get('/before-headers')
    await get('/after-headers')
    await get('/sync-throw')
    await settle()
    expect(escaped).toEqual([])
  })
})

describe('wrap — logger contract', () => {
  it('tolerates a logger with no methods (silent mode)', async () => {
    const handler = wrap({}, async () => { throw new Error('quiet') })
    const res = fakeRes()
    await handler(fakeReq('/x'), res as any, (() => {}) as any)
    expect(res.statusCode).toBe(500)
    expect(res.jsonBody).toEqual({ error: 'internal_error' })
  })

  it('does not call next() on either branch', async () => {
    const next = vi.fn()

    const before = wrap({}, async () => { throw new Error('a') })
    await before(fakeReq('/a'), fakeRes() as any, next as any)
    expect(next).not.toHaveBeenCalled()

    const after = wrap({}, async (_q, res: any) => {
      res.headersSent = true
      throw new Error('b')
    })
    await after(fakeReq('/b'), fakeRes() as any, next as any)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('consoleRouteLogger', () => {
  it('keeps the pre-0.15 console.error output shape', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleRouteLogger.error?.({ err: 'x' }, 'mailery: something failed')
    expect(spy).toHaveBeenCalledWith('mailery: something failed', { err: 'x' })
    spy.mockRestore()
  })
})

// --- minimal req/res doubles -------------------------------------------------

function fakeReq(path: string) {
  return { originalUrl: path } as any
}

function fakeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    jsonBody: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.jsonBody = body; return this },
  }
}
