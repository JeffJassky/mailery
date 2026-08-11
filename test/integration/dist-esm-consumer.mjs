/**
 * A real ESM consumer of the *built* bundle.
 *
 * This file is deliberately plain `.mjs` and is deliberately run in its own
 * `node` process by `dist-esm-smoke.test.ts` rather than being imported from
 * the test. Both of those are the point:
 *
 *   - `.mjs` run directly by node is the exact module semantics a host app
 *     gets from `import { createPublicRouter } from 'mailery'`. Anything that
 *     only works because a transform (vitest's, tsx's) rewrote the module is
 *     precisely the class of bug this exists to catch — see issue #12, where
 *     `require('fast-xml-parser')` in a `"type": "module"` package compiled to
 *     esbuild's `__require` shim and threw for every ESM consumer, while the
 *     `src`-only suite stayed green because vitest gave it a real CommonJS
 *     `require`.
 *   - a separate process means the assertion is about node's loader, not
 *     about vitest's.
 *
 * Usage:  node dist-esm-consumer.mjs <abs path to dist/index.js> <abs path to a DMARC xml>
 * Output: exactly one line of JSON on stdout. Any throw is caught and
 *         reported as `{ ok: false, stage, error }` so the test can print
 *         something better than a stack trace.
 */

import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const [distPath, fixturePath] = process.argv.slice(2)

function emit(result) {
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}

function fail(stage, err) {
  emit({ ok: false, stage, error: String(err?.stack ?? err?.message ?? err) })
}

// --- 1. import the built bundle as ESM ---------------------------------------

let mailery
try {
  mailery = await import(pathToFileURL(distPath).href)
} catch (err) {
  fail('import', err)
}

let express
try {
  express = (await import('express')).default
} catch (err) {
  fail('import-express', err)
}

const { createPublicRouter } = mailery
if (typeof createPublicRouter !== 'function') {
  fail('exports', new Error('createPublicRouter is not exported from the built bundle'))
}

// --- 2. mount the real public route over a stub Mailer -----------------------
//
// Only Mongo is stubbed. Everything between the socket and the parser —
// express, multer, the shared-secret check, the domain gate, gunzip, and
// `parseDmarcReport` itself — is the real bundled code. Standing up a real
// mongod here would make this a slow test of the driver, not of the bundle;
// the writes are already covered by test/integration/dmarc.test.ts.

const SECRET = 'dist-smoke-secret'
const inserted = { reports: [], failures: [] }

const collections = {
  dmarcReports: {
    insertOne: async (doc) => {
      inserted.reports.push(doc)
      return { acknowledged: true }
    },
  },
  dmarcFailures: {
    insertMany: async (docs) => {
      inserted.failures.push(...docs)
      return { acknowledged: true }
    },
  },
}

const stubMailer = {
  config: {
    senderDomains: { 'example.com': { kind: 'marketing' } },
    unsubscribeSecret: 'unused-by-this-route',
  },
  collections,
  getRunnerContext: () => ({ collections }),
}

const quietLogger = { error: () => {}, warn: () => {}, info: () => {} }

let baseUrl
let server
try {
  const app = express()
  app.use(
    '/m',
    createPublicRouter(stubMailer, {
      logger: quietLogger,
      dmarcInbound: { secret: SECRET, allowedDomains: ['example.com'] },
    }),
  )
  server = app.listen(0)
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
} catch (err) {
  fail('mount', err)
}

// --- 3. POST a real gzipped report over a real socket ------------------------

function multipart(parts) {
  const boundary = '----maileryDistSmoke' + Math.random().toString(36).slice(2)
  const chunks = []
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
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
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

try {
  const xml = readFileSync(fixturePath)
  const { body, contentType } = multipart([
    { name: 'headers', value: 'From: noreply-dmarc-support@google.com' },
    { name: 'from', value: 'noreply-dmarc-support@google.com' },
    { name: 'subject', value: 'Report Domain: example.com' },
    { name: 'attachments', value: '1' },
    {
      name: 'attachment1',
      // Receiver-style filename; the `.gz` extension is what routes it to
      // gunzip in `extractDmarcXmls`.
      filename: `receiver!example.com!1718064000!1718150400.${basename(fixturePath)}.gz`,
      content: gzipSync(xml),
    },
  ])

  const res = await post(`${baseUrl}/m/inbound/dmarc`, body, {
    'content-type': contentType,
    authorization: 'Basic ' + Buffer.from(`mailery:${SECRET}`).toString('base64'),
  })

  server.close()

  let parsed = null
  try {
    parsed = JSON.parse(res.body)
  } catch {
    /* leave null; the test reports res.body */
  }

  emit({
    ok: res.status === 200,
    stage: 'request',
    status: res.status,
    response: parsed ?? res.body,
    reports: inserted.reports.map((r) => ({
      reportId: r.reportId,
      domain: r.domain,
      orgName: r.orgName,
      totalMessages: r.totalMessages,
    })),
    failureCount: inserted.failures.length,
  })
} catch (err) {
  try { server?.close() } catch { /* ignore */ }
  fail('request', err)
}
