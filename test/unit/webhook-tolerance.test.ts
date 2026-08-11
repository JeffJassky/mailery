/**
 * Replay-window helpers shared by provider webhook verification
 * (src/server/providers/webhook-tolerance.ts).
 *
 * The provider-level behaviour is covered end-to-end against a real ECDSA
 * signature in sendgrid-provider.test.ts; these cover the option-normalization
 * and timestamp-parsing edges that are awkward to reach through a signature.
 */

import { describe, it, expect } from 'vitest'

import {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  isWebhookTimestampFresh,
  resolveWebhookToleranceSeconds,
} from '../../src/server/providers/webhook-tolerance.js'

describe('resolveWebhookToleranceSeconds', () => {
  it('defaults to five minutes', () => {
    expect(DEFAULT_WEBHOOK_TOLERANCE_SECONDS).toBe(300)
    expect(resolveWebhookToleranceSeconds(undefined)).toBe(300)
  })

  it('treats 0 and false as disabled', () => {
    expect(resolveWebhookToleranceSeconds(0)).toBe(0)
    expect(resolveWebhookToleranceSeconds(false)).toBe(0)
  })

  it('passes an explicit window through', () => {
    expect(resolveWebhookToleranceSeconds(30)).toBe(30)
    expect(resolveWebhookToleranceSeconds(7200)).toBe(7200)
  })

  it('falls back to the default rather than disabling on nonsense input', () => {
    // A config typo must not silently turn the replay window off.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '300' as any, null as any]) {
      expect(resolveWebhookToleranceSeconds(bad)).toBe(DEFAULT_WEBHOOK_TOLERANCE_SECONDS)
    }
  })
})

describe('isWebhookTimestampFresh', () => {
  const now = new Date('2026-08-10T12:00:00.000Z')
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const at = (offset: number) => String(nowSeconds + offset)

  it('accepts a timestamp inside the window in both directions', () => {
    expect(isWebhookTimestampFresh(at(0), 300, now)).toBe(true)
    expect(isWebhookTimestampFresh(at(-299), 300, now)).toBe(true)
    expect(isWebhookTimestampFresh(at(299), 300, now)).toBe(true)
    // Inclusive at the boundary.
    expect(isWebhookTimestampFresh(at(-300), 300, now)).toBe(true)
    expect(isWebhookTimestampFresh(at(300), 300, now)).toBe(true)
  })

  it('rejects stale and far-future timestamps', () => {
    expect(isWebhookTimestampFresh(at(-301), 300, now)).toBe(false)
    expect(isWebhookTimestampFresh(at(301), 300, now)).toBe(false)
    expect(isWebhookTimestampFresh(at(-86_400), 300, now)).toBe(false)
    expect(isWebhookTimestampFresh(at(86_400), 300, now)).toBe(false)
  })

  it('skips the check when the tolerance is disabled', () => {
    expect(isWebhookTimestampFresh(at(-86_400), 0, now)).toBe(true)
    expect(isWebhookTimestampFresh(undefined, 0, now)).toBe(true)
  })

  it('fails closed on a missing or malformed timestamp', () => {
    expect(isWebhookTimestampFresh(undefined, 300, now)).toBe(false)
    expect(isWebhookTimestampFresh('', 300, now)).toBe(false)
    expect(isWebhookTimestampFresh('abc', 300, now)).toBe(false)
    expect(isWebhookTimestampFresh(`${nowSeconds}abc`, 300, now)).toBe(false)
    expect(isWebhookTimestampFresh(` ${nowSeconds} `, 300, now)).toBe(false)
    expect(isWebhookTimestampFresh('0x10', 300, now)).toBe(false)
    expect(isWebhookTimestampFresh('1e12', 300, now)).toBe(false)
    expect(isWebhookTimestampFresh(`-${nowSeconds}`, 300, now)).toBe(false)
    expect(isWebhookTimestampFresh(`${nowSeconds}.5`, 300, now)).toBe(false)
  })
})
