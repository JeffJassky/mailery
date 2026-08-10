/**
 * HMAC-signed tokens for unsubscribe + preference-center URLs.
 *
 * Format:  base64url(payload) '.' base64url(hmac)
 *   payload  = JSON.stringify({ e: email, s: scope, x: expiresAtMs })
 *   hmac     = HMAC-SHA256(secret, payload)
 *
 * Tokens expire because long-lived signed URLs are a liability.
 */

import crypto from 'node:crypto'
import type { SuppressionScope } from '../shared/enums.js'

export interface UnsubscribeTokenPayload {
  email: string
  scope: SuppressionScope
  expiresAt: Date
}

export function signUnsubscribeToken(
  payload: UnsubscribeTokenPayload,
  secret: string,
): string {
  const body = JSON.stringify({
    e: payload.email.toLowerCase(),
    s: payload.scope,
    x: payload.expiresAt.getTime(),
  })
  const bodyB64 = b64url(Buffer.from(body, 'utf8'))
  const hmac = crypto.createHmac('sha256', secret).update(bodyB64).digest()
  return `${bodyB64}.${b64url(hmac)}`
}

export function verifyUnsubscribeToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): UnsubscribeTokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [bodyB64, sigB64] = parts as [string, string]

  const expected = crypto.createHmac('sha256', secret).update(bodyB64).digest()
  let actual: Buffer
  try {
    actual = b64urlDecode(sigB64)
  } catch {
    return null
  }
  if (expected.length !== actual.length) return null
  if (!crypto.timingSafeEqual(expected, actual)) return null

  let body: { e?: string; s?: string; x?: number }
  try {
    body = JSON.parse(b64urlDecode(bodyB64).toString('utf8'))
  } catch {
    return null
  }
  if (!body.e || !body.s || typeof body.x !== 'number') return null
  if (body.x < now.getTime()) return null
  if (body.s !== 'all' && body.s !== 'marketing' && body.s !== 'transactional') return null

  return {
    email: body.e,
    scope: body.s,
    expiresAt: new Date(body.x),
  }
}

// ---------------------------------------------------------------------------
// Tracking-URL signatures
// ---------------------------------------------------------------------------

/**
 * Scopes a tracking signature can be issued for. An allowlist, mirroring the
 * `k: 'doi'` discriminator on the DOI token: the scope is part of the signed
 * message, so an `/m/open` signature cannot be replayed as an `/m/click` one
 * even for the same send.
 */
export type TrackingScope = 'open' | 'click'

const TRACKING_SCOPES: readonly string[] = ['open', 'click']

/**
 * Signature length in base64url characters. 12 chars = 72 bits of the
 * HMAC-SHA256 digest.
 *
 * Truncation is deliberate. These signatures are embedded in every link of
 * every email, and the pixel URL in particular is parsed by mail clients with
 * their own length quirks, so bytes are not free. 72 bits is far beyond what an
 * online forgery attack can reach: an attacker gets no oracle beyond "the open
 * was counted", each guess is a live HTTP request, and there is no offline
 * verification step. Nothing here is a bearer credential for anything except
 * "this recipient was sent this mail".
 */
export const TRACKING_SIG_LENGTH = 12

export interface TrackingTokenParams {
  sendId: string
  /** Present for `click` scope, absent for `open`. */
  linkId?: string
}

/**
 * The signed message. Versioned so a future format change (longer signature,
 * different digest) can be distinguished rather than silently mis-verified.
 * Components are joined with `:`, a character that appears in neither an
 * ObjectId hex string nor a `shortHash` linkId, so the encoding is unambiguous.
 */
function trackingMessage(scope: TrackingScope, params: TrackingTokenParams): string {
  const tail = params.linkId === undefined ? '' : `:${params.linkId}`
  return `mailery.track.v1:${scope}:${params.sendId}${tail}`
}

/**
 * Sign a tracking URL. Returns `TRACKING_SIG_LENGTH` base64url characters.
 *
 * Keyed with `unsubscribeSecret` — the same secret the unsubscribe and DOI
 * tokens use, so there is exactly one secret to provision
 * (`MAILER_UNSUBSCRIBE_SECRET`) and one to rotate. The scope prefix keeps the
 * key domains separate.
 */
export function signTrackingToken(
  scope: TrackingScope,
  params: TrackingTokenParams,
  secret: string,
): string {
  if (!TRACKING_SCOPES.includes(scope)) {
    throw new Error(`signTrackingToken: unknown scope ${String(scope)}`)
  }
  const mac = crypto.createHmac('sha256', secret).update(trackingMessage(scope, params)).digest()
  return b64url(mac).slice(0, TRACKING_SIG_LENGTH)
}

/**
 * Verify a tracking-URL signature in constant time.
 *
 * The length pre-check before `timingSafeEqual` is required, not defensive:
 * `crypto.timingSafeEqual` throws on mismatched lengths, and a thrown
 * verification is a rejection that leaks length through a different channel.
 * Same shape as `verifyUnsubscribeToken`.
 */
export function verifyTrackingToken(
  token: unknown,
  scope: TrackingScope,
  params: TrackingTokenParams,
  secret: string,
): boolean {
  if (typeof token !== 'string') return false
  if (!TRACKING_SCOPES.includes(scope)) return false
  if (token.length !== TRACKING_SIG_LENGTH) return false
  const expected = Buffer.from(signTrackingToken(scope, params, secret), 'utf8')
  const actual = Buffer.from(token, 'utf8')
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(expected, actual)
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  return Buffer.from(padded, 'base64')
}

/**
 * sha256 hex digest, used for storing email hashes (GDPR forget) and dedup helpers.
 */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

// ---------------------------------------------------------------------------
// Double opt-in tokens
// ---------------------------------------------------------------------------

export interface DoiTokenPayload {
  externalId: string
  expiresAt: Date
}

/**
 * Sign a DOI confirmation token. Same shape as the unsubscribe token, but
 * scoped to "this externalId confirmed their subscription."
 */
export function signDoiToken(payload: DoiTokenPayload, secret: string): string {
  const body = JSON.stringify({
    i: payload.externalId,
    x: payload.expiresAt.getTime(),
    k: 'doi',
  })
  const bodyB64 = b64url(Buffer.from(body, 'utf8'))
  const hmac = crypto.createHmac('sha256', secret).update(bodyB64).digest()
  return `${bodyB64}.${b64url(hmac)}`
}

export function verifyDoiToken(token: string, secret: string, now: Date = new Date()): DoiTokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [bodyB64, sigB64] = parts as [string, string]

  const expected = crypto.createHmac('sha256', secret).update(bodyB64).digest()
  let actual: Buffer
  try {
    actual = b64urlDecode(sigB64)
  } catch {
    return null
  }
  if (expected.length !== actual.length) return null
  if (!crypto.timingSafeEqual(expected, actual)) return null

  let body: { i?: string; x?: number; k?: string }
  try {
    body = JSON.parse(b64urlDecode(bodyB64).toString('utf8'))
  } catch {
    return null
  }
  if (!body.i || typeof body.x !== 'number' || body.k !== 'doi') return null
  if (body.x < now.getTime()) return null

  return { externalId: body.i, expiresAt: new Date(body.x) }
}
