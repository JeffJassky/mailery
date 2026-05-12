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
