/**
 * Load `.env` into `process.env` for the test run.
 *
 * Vitest does not populate `process.env` from a dotenv file on its own, and
 * the live tiers gate on real credentials. Registered as a vitest `setupFile`,
 * so it runs before any test in any suite.
 *
 * Existing environment variables always win — CI passes secrets directly and a
 * stale local `.env` must never override them. A missing `.env` is normal and
 * silent: the offline suite needs nothing from here.
 *
 * Minimal parser rather than a `dotenv` dependency: the file is a checklist of
 * a handful of credentials, not a configuration system.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(here, '..', '.env')

if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue

    const key = line.slice(0, eq).trim()
    if (!key || key in process.env) continue

    let value = line.slice(eq + 1).trim()
    // Strip one layer of matching quotes, if present.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}
