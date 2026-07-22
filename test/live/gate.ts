/**
 * Live-tier gating.
 *
 * INVARIANT: with `MAILERY_LIVE_E2E` unset, nothing in `test/live` touches the
 * network, and `yarn test` behaves exactly as it did before this tier existed.
 * A leaky gate breaks CI for everyone, so the checks are deliberately blunt.
 *
 *   MAILERY_LIVE_E2E unset      → the whole live tier is skipped
 *   MAILERY_LIVE_E2E=sandbox    → real SendGrid API calls, sandboxMode on,
 *                                 nothing delivered, no quota spent
 *   MAILERY_LIVE_E2E=deliver    → real delivery; inbox assertions run
 *
 * `SENDGRID_API_KEY` is required for either live mode; `GMAIL_USERNAME` +
 * `GMAIL_PASSWORD` additionally for `deliver`. Values come from the process
 * environment, which `test/setup-env.ts` seeds from `.env`.
 */

export type LiveMode = 'off' | 'sandbox' | 'deliver'

export function liveMode(): LiveMode {
  const raw = process.env.MAILERY_LIVE_E2E
  if (!raw) return 'off'
  if (!process.env.SENDGRID_API_KEY) return 'off'
  if (raw === 'deliver') return 'deliver'
  // Anything else truthy (including '1') means the safe mode.
  return 'sandbox'
}

/** True when real SendGrid calls should be made at all. */
export const LIVE = liveMode() !== 'off'

/**
 * Gmail credentials. `GMAIL_USERNAME` / `GMAIL_PASSWORD` are the canonical
 * names (matching the project's .env); the `GMAIL_USER` / `GMAIL_APP_PASSWORD`
 * spellings are accepted as aliases so CI secrets under either name work.
 * Note the password must be a Google *app password*, not the account password.
 */
export function gmailUser(): string | undefined {
  return process.env.GMAIL_USERNAME ?? process.env.GMAIL_USER
}

/**
 * Google displays app passwords as four groups of four for readability; the
 * actual secret is the 16 characters without spaces. Strip whitespace so a
 * copy-paste straight from the Google UI works either way.
 */
export function gmailPassword(): string | undefined {
  const raw = process.env.GMAIL_PASSWORD ?? process.env.GMAIL_APP_PASSWORD
  return raw ? raw.replace(/\s+/g, '') : undefined
}

/** True when mail is actually delivered and the inbox can be asserted on. */
export const DELIVERS = liveMode() === 'deliver' && !!gmailUser() && !!gmailPassword()

/** Redis for the real-worker path. Absent → the live tier drains by hand. */
export const REDIS_URL = process.env.MAILERY_TEST_REDIS_URL

/**
 * Verified sender the live tier sends from — must be authenticated in SendGrid
 * (SPF + DKIM), or SendGrid rejects the call.
 */
export function liveFromEmail(): string {
  return process.env.SENDGRID_FROM_EMAIL ?? process.env.MAILERY_LIVE_FROM ?? 'test@example.com'
}

/** One-line summary for test output, so a skipped run explains itself. */
export function describeGate(): string {
  const mode = liveMode()
  if (mode === 'off') {
    return 'live tier OFF (set MAILERY_LIVE_E2E=sandbox|deliver + SENDGRID_API_KEY)'
  }
  return `live tier ${mode}${DELIVERS ? ' + inbox' : ''}${REDIS_URL ? ' + workers' : ''}`
}
