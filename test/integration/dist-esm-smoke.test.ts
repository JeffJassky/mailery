/**
 * Bundle-level regression guard for issue #12.
 *
 * Every other test in this suite imports from `src/`, and that is exactly why
 * v0.14.0 shipped a DMARC ingest path that threw for every ESM consumer.
 * `parseDmarcReport` used `require('fast-xml-parser')` as a deliberate lazy
 * load; the package is `"type": "module"`, so tsup compiled that call to
 * esbuild's `__require` shim, which throws unconditionally in the ESM output.
 * Under vitest the same line was a real CommonJS `require` and worked fine, so
 * the suite was green against broken artifacts.
 *
 * The only test that can catch that class of bug is one that runs the *built*
 * bundle under node's own ESM loader. This is that test:
 *
 *   1. make sure `dist/` is present and not older than the sources it is built
 *      from — building it here if it is not (see "The build dependency" below),
 *   2. spawn a separate `node` process running `dist-esm-consumer.mjs`, which
 *      imports `dist/index.js`, mounts the real `createPublicRouter`, and POSTs
 *      a real gzipped DMARC report at the real inbound route,
 *   3. assert the report came back parsed.
 *
 * `parseDmarcReport` is not itself part of the public surface, and reaching it
 * through `createPublicRouter` is deliberate rather than a workaround: the
 * public route is what actually broke, so it is what should be defended.
 *
 * ## The build dependency
 *
 * This test needs `dist/`, which `yarn test` does not produce — CI runs
 * `yarn test` *before* `yarn build`. Skipping when `dist/` is absent would
 * therefore mean skipping in CI, i.e. exactly the silence that let #12 ship.
 * Failing when `dist/` is absent would break `yarn test` for anyone who has
 * not built.
 *
 * So it builds what it needs, and only when it needs it: if `dist/index.js` is
 * missing or older than any server/CLI source, `tsup` runs first (~4s, the
 * same invocation as `yarn build:server`). If `dist/` is already fresh — the
 * normal case locally — nothing is rebuilt and the check is a subprocess
 * spawn. `yarn test` never fails for want of a build, and never silently
 * skips either.
 *
 * Set `MAILERY_SKIP_DIST_SMOKE=1` to opt out (e.g. a sandbox where spawning a
 * build is not acceptable).
 */

import { describe, expect, it, beforeAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DIST_ENTRY = path.join(ROOT, 'dist', 'index.js')
const CONSUMER = path.join(__dirname, 'dist-esm-consumer.mjs')
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'dmarc')

const SKIP = process.env.MAILERY_SKIP_DIST_SMOKE === '1'

/** Newest mtime under `dir`, restricted to sources tsup actually reads. */
function newestSourceMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `src/client` is the vite bundle, not part of the server build.
    if (entry.name === 'client' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full))
    } else if (/\.(ts|tsx|json)$/.test(entry.name)) {
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  return newest
}

function distIsStale(): boolean {
  if (!existsSync(DIST_ENTRY)) return true
  const built = statSync(DIST_ENTRY).mtimeMs
  const newestSource = Math.max(
    newestSourceMtime(path.join(ROOT, 'src')),
    statSync(path.join(ROOT, 'tsup.config.ts')).mtimeMs,
    statSync(path.join(ROOT, 'package.json')).mtimeMs,
  )
  return newestSource > built
}

interface ConsumerResult {
  ok: boolean
  stage?: string
  status?: number
  error?: string
  response?: unknown
  reports?: Array<{ reportId: string; domain: string; orgName: string; totalMessages: number }>
  failureCount?: number
}

/** Run the plain-ESM consumer against one fixture and return its JSON verdict. */
function runConsumer(fixture: string): ConsumerResult {
  const res = spawnSync(process.execPath, [CONSUMER, DIST_ENTRY, path.join(FIXTURES, fixture)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })

  const line = (res.stdout ?? '').trim().split('\n').filter(Boolean).pop()
  if (!line) {
    throw new Error(
      `dist ESM consumer produced no output (exit ${res.status}).\n` +
        `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    )
  }
  try {
    return JSON.parse(line) as ConsumerResult
  } catch {
    throw new Error(`dist ESM consumer produced non-JSON output:\n${line}\nstderr:\n${res.stderr}`)
  }
}

beforeAll(() => {
  if (SKIP) return
  if (!distIsStale()) return
  // Same invocation as `yarn build:server`; called directly so the test does
  // not assume a package manager is on PATH.
  const tsup = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsup.cmd' : 'tsup')
  if (!existsSync(tsup)) {
    throw new Error(
      `dist/ is missing or stale and ${tsup} was not found — run \`yarn install && yarn build:server\`, ` +
        'or set MAILERY_SKIP_DIST_SMOKE=1 to skip the bundle smoke test.',
    )
  }
  execFileSync(tsup, { cwd: ROOT, stdio: 'pipe', timeout: 300_000 })
}, 300_000)

describe.skipIf(SKIP)('built ESM bundle — DMARC ingest (regression: #12)', () => {
  it('imports dist/index.js under node\'s ESM loader and exposes createPublicRouter', () => {
    const result = runConsumer('google-clean.xml')
    // A `__require` shim blowing up shows here first, as stage "import" or
    // stage "request" with a "Dynamic require of ... is not supported" body.
    expect(result.stage, `consumer failed at stage "${result.stage}": ${result.error ?? ''}`).toBe('request')
  })

  it('parses a real gzipped report through the public inbound route', () => {
    const result = runConsumer('google-clean.xml')
    expect(
      result.ok,
      `expected HTTP 200 from the built bundle, got ${result.status}: ${JSON.stringify(result.response)}`,
    ).toBe(true)
    expect(result.status).toBe(200)
    expect(result.reports).toHaveLength(1)
    expect(result.reports![0]).toMatchObject({
      reportId: '10000000000001',
      domain: 'example.com',
      orgName: 'google.com',
      totalMessages: 423,
    })
  })

  it('parses failure rows out of a mixed report through the built bundle', () => {
    const result = runConsumer('yahoo-mixed.xml')
    expect(
      result.ok,
      `expected HTTP 200 from the built bundle, got ${result.status}: ${JSON.stringify(result.response)}`,
    ).toBe(true)
    expect(result.reports![0]).toMatchObject({ domain: 'example.com', orgName: 'Yahoo' })
    // The mixed fixture has unaligned rows; if fast-xml-parser were not really
    // loaded there would be nothing here to count.
    expect(result.failureCount).toBeGreaterThan(0)
  })
})
