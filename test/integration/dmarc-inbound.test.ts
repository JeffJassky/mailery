/**
 * The inbound DMARC webhook (`src/server/api/dmarc-inbound.ts`).
 *
 * This is the package's only route that accepts a file upload from an
 * unauthenticated network, so the tests are about the perimeter as much as the
 * happy path: it must not exist unless configured, must reject a caller with
 * no (or the wrong) secret, must refuse an oversized upload, and must survive a
 * hostile archive without taking the process with it.
 *
 * Requests are built as real multipart bodies over a real socket — a
 * hand-rolled `req.files` would test nothing about multer's limits, which are
 * the size control.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import AdmZip from 'adm-zip'

import { createPublicRouter } from '../../src/server/api/public.js'
import type { RouteLogger } from '../../src/server/api/wrap.js'
import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORT_XML = readFileSync(path.join(__dirname, '..', 'fixtures', 'dmarc', 'google-clean.xml'), 'utf8')

const SECRET = 'sekret-inbound-value'

let H: TestMailerHarness
const servers: Array<ReturnType<express.Express['listen']>> = []

const logged: Array<{ level: string; fields: Record<string, unknown>; msg?: string }> = []
const logger: RouteLogger = {
  error: (fields, msg) => { logged.push({ level: 'error', fields, msg }) },
  warn: (fields, msg) => { logged.push({ level: 'warn', fields, msg }) },
  info: (fields, msg) => { logged.push({ level: 'info', fields, msg }) },
}

const escaped: unknown[] = []
const onUnhandled = (err: unknown) => { escaped.push(err) }

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)
  H = await createTestMailer({
    config: { senderDomains: { 'news.example.com': { kind: 'marketing' } } },
  })
}, 120_000)

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled)
  for (const s of servers) s.close()
  if (H) await H.stop()
})

afterEach(async () => {
  logged.length = 0
  await H.mailer.collections.dmarcReports.deleteMany({})
  await H.mailer.collections.dmarcFailures.deleteMany({})
})

// --- harness -----------------------------------------------------------------

async function mount(opts: Parameters<typeof createPublicRouter>[1] = {}): Promise<string> {
  const app = express()
  app.use('/m', createPublicRouter(H.mailer, { logger, ...opts }))
  const server = app.listen(0)
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const basic = (secret: string, user = 'mailery') =>
  'Basic ' + Buffer.from(`${user}:${secret}`).toString('base64')

interface Part {
  name: string
  value?: string
  filename?: string
  content?: Buffer
}

/** Build a `multipart/form-data` body in SendGrid Inbound Parse's shape. */
function multipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = '----maileryTest' + Math.random().toString(36).slice(2)
  const chunks: Buffer[] = []
  for (const p of parts) {
    const disposition = p.filename
      ? `form-data; name="${p.name}"; filename="${p.filename}"`
      : `form-data; name="${p.name}"`
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${disposition}\r\n` +
          (p.filename ? 'Content-Type: application/octet-stream\r\n' : '') +
          '\r\n',
      ),
    )
    chunks.push(p.content ?? Buffer.from(p.value ?? ''))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

function post(
  baseUrl: string,
  p: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${baseUrl}${p}`,
      { method: 'POST', headers: { 'content-length': String(body.length), ...headers } },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** A SendGrid Inbound Parse POST carrying one report attachment. */
function inboundWith(filename: string, content: Buffer) {
  return multipart([
    { name: 'headers', value: 'From: noreply-dmarc-support@google.com' },
    { name: 'from', value: 'noreply-dmarc-support@google.com' },
    { name: 'subject', value: 'Report Domain: example.com' },
    { name: 'attachments', value: '1' },
    { name: 'attachment1', filename, content },
  ])
}

const gzReport = () => zlib.gzipSync(Buffer.from(REPORT_XML))

function zipReport(): Buffer {
  const zip = new AdmZip()
  zip.addFile('google.com!example.com!1.xml', Buffer.from(REPORT_XML))
  return zip.toBuffer()
}

const reports = () => H.mailer.collections.dmarcReports.find({}).toArray()

// ---------------------------------------------------------------------------

describe('mounting', () => {
  it('does not exist unless configured', async () => {
    const base = await mount()
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(404)
    expect(await reports()).toHaveLength(0)
  })

  it('is not mounted when the secret is an empty string', async () => {
    const base = await mount({ dmarcInbound: { secret: '' } })
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())
    const res = await post(base, '/m/inbound/dmarc', body, { 'content-type': contentType })
    expect(res.status).toBe(404)
  })

  it('honours a custom path, and nothing answers on the default one', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET, path: '/rua-8f21c3' } })
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())
    const headers = { 'content-type': contentType, authorization: basic(SECRET) }

    expect((await post(base, '/m/rua-8f21c3', body, headers)).status).toBe(200)
    expect((await post(base, '/m/inbound/dmarc', body, headers)).status).toBe(404)
  })
})

describe('authentication', () => {
  it('accepts the secret as basic-auth, ignoring the username', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET, 'anything-at-all'),
    })

    expect(res.status).toBe(200)
    expect(await reports()).toHaveLength(1)
  })

  it('accepts the secret as a bearer token', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: `Bearer ${SECRET}`,
    })

    expect(res.status).toBe(200)
  })

  it.each([
    ['no Authorization header', {}],
    ['an empty Authorization header', { authorization: '' }],
    ['a wrong basic password', { authorization: basic('not-the-secret') }],
    ['a wrong bearer token', { authorization: 'Bearer nope' }],
    ['a right secret under an unsupported scheme', { authorization: `Token ${SECRET}` }],
    ['the secret as a bare header value', { authorization: SECRET }],
    ['a truncated secret', { authorization: basic(SECRET.slice(0, -1)) }],
    ['basic auth with no colon', { authorization: 'Basic ' + Buffer.from(SECRET).toString('base64') }],
  ])('rejects %s', async (_label, extra) => {
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      ...(extra as Record<string, string>),
    })

    expect(res.status).toBe(401)
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' })
    expect(await reports()).toHaveLength(0)
    expect(logged.some((l) => l.msg?.includes('bad or missing shared secret'))).toBe(true)
  })

  it('does not send a WWW-Authenticate challenge', async () => {
    // A browser prompt on a machine endpoint helps nobody and invites a human
    // to start guessing.
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())
    const res = await new Promise<{ headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        `${base}/m/inbound/dmarc`,
        { method: 'POST', headers: { 'content-type': contentType, 'content-length': String(body.length) } },
        (r) => {
          r.resume()
          r.on('end', () => resolve({ headers: r.headers as Record<string, unknown> }))
        },
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
    expect(res.headers['www-authenticate']).toBeUndefined()
  })
})

describe('ingest', () => {
  it('stores a gzipped report', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('google.com!example.com!1.xml.gz', gzReport())

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).ingested).toEqual([
      { reportId: expect.any(String), domain: 'example.com', duplicate: false },
    ])
    const rows = await reports()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.domain).toBe('example.com')
    expect(rows[0]!.orgName).toBe('google.com')
  })

  it('stores a zipped report', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('google.com!example.com!1.zip', zipReport())

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(200)
    expect(await reports()).toHaveLength(1)
  })

  it('is idempotent — a redelivered report is not double-counted', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())
    const headers = { 'content-type': contentType, authorization: basic(SECRET) }

    await post(base, '/m/inbound/dmarc', body, headers)
    const second = await post(base, '/m/inbound/dmarc', body, headers)

    expect(second.status).toBe(200)
    expect(JSON.parse(second.body).ingested[0].duplicate).toBe(true)
    expect(await reports()).toHaveLength(1)
  })

  it('ignores a message with no report attachment, without asking for a retry', async () => {
    // A RUA mailbox also receives auto-replies and the occasional human.
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = multipart([
      { name: 'from', value: 'someone@example.com' },
      { name: 'subject', value: 'out of office' },
      { name: 'text', value: 'I am away until Monday' },
    ])

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).ingested).toBe(0)
  })

  it('ignores attachments whose extension is not a report format', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('invoice.pdf', Buffer.from('%PDF-1.4 not a report'))

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).ingested).toBe(0)
    expect(await reports()).toHaveLength(0)
  })
})

describe('domain cross-check', () => {
  it('rejects a report for a domain this deployment does not send from', async () => {
    const base = await mount({
      dmarcInbound: { secret: SECRET, allowedDomains: ['other.test'] },
    })
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(400)
    expect(res.body).toContain('does not send from')
    expect(await reports()).toHaveLength(0)
  })

  it('derives the allowlist from senderDomains, including the parent domain', async () => {
    // Configured sender domain is news.example.com; the report's
    // policy_published.domain is the organizational domain example.com.
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('r.xml.gz', gzReport())

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(200)
    expect(await reports()).toHaveLength(1)
  })
})

describe('size and malformed input', () => {
  it('rejects an upload over the configured cap', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET, maxFileSizeBytes: 2048 } })
    const { body, contentType } = inboundWith('big.xml', Buffer.alloc(8192, 0x41))

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(413)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'upload_rejected', message: 'LIMIT_FILE_SIZE' })
    expect(await reports()).toHaveLength(0)
  })

  it('rejects more attachments than the configured count', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET, maxFiles: 1 } })
    const { body, contentType } = multipart([
      { name: 'attachment1', filename: 'a.xml.gz', content: gzReport() },
      { name: 'attachment2', filename: 'b.xml.gz', content: gzReport() },
    ])

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(413)
  })

  it('rejects a corrupt archive without crashing', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('broken.zip', Buffer.from('PK then garbage'))

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toBe('ingest_failed')
    expect(await reports()).toHaveLength(0)
  })

  it('rejects a zip whose entry declares an implausible uncompressed size', async () => {
    // The declared-size gate in extractDmarcXmls, reached through the route.
    const zip = new AdmZip()
    zip.addFile('bomb.xml', Buffer.alloc(1024, 0x41))
    const buf = zip.toBuffer()
    // Rewrite the local + central-directory uncompressed size to 400MB.
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === 0x04034b50) buf.writeUInt32LE(400 * 1024 * 1024, i + 22)
      if (buf.readUInt32LE(i) === 0x02014b50) buf.writeUInt32LE(400 * 1024 * 1024, i + 24)
    }

    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('bomb.zip', buf)

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(400)
    expect(await reports()).toHaveLength(0)
  })

  it('rejects XML that is not a DMARC report', async () => {
    const base = await mount({ dmarcInbound: { secret: SECRET } })
    const { body, contentType } = inboundWith('nope.xml', Buffer.from('<hello><world/></hello>'))

    const res = await post(base, '/m/inbound/dmarc', body, {
      'content-type': contentType,
      authorization: basic(SECRET),
    })

    expect(res.status).toBe(400)
    expect(await reports()).toHaveLength(0)
  })

  it('never lets any of the above escape as an unhandled rejection', async () => {
    await new Promise((r) => setTimeout(r, 50))
    expect(escaped).toEqual([])
  })
})
