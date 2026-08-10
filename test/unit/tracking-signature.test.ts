/**
 * Unit tests for tracking-URL signing (issue #7).
 *
 * Why this exists: a tracking URL's only secret used to be a Mongo ObjectId,
 * which is a 4-byte timestamp + a per-process-constant 5-byte random + a
 * sequential 3-byte counter. One received email therefore leaks its
 * neighbours, and forged opens are not a reporting curiosity — flow predicates
 * branch on open/click state, so they advance recipients through automation.
 *
 * Covered here: the token primitive (`src/server/tokens.ts`) and the URL shapes
 * `applyTracking` emits. Endpoint behaviour — grace mode, rejection status
 * codes — is in test/integration/tracking-signature.test.ts.
 */

import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  signTrackingToken,
  verifyTrackingToken,
  TRACKING_SIG_LENGTH,
} from '../../src/server/tokens.js'
import { applyTracking } from '../../src/server/templates/render.js'

const SECRET = 'unit-test-unsubscribe-secret-32-bytes-plus'
const OTHER_SECRET = 'a-completely-different-secret-value-here!'
const SEND = '507f1f77bcf86cd799439011'
const NEIGHBOUR = '507f1f77bcf86cd799439012' // the next ObjectId an attacker would guess
const LINK = 'a1b2c3d4e5f6'

describe('signTrackingToken / verifyTrackingToken', () => {
  it('round-trips an open signature', () => {
    const sig = signTrackingToken('open', { sendId: SEND }, SECRET)
    expect(verifyTrackingToken(sig, 'open', { sendId: SEND }, SECRET)).toBe(true)
  })

  it('round-trips a click signature', () => {
    const sig = signTrackingToken('click', { sendId: SEND, linkId: LINK }, SECRET)
    expect(verifyTrackingToken(sig, 'click', { sendId: SEND, linkId: LINK }, SECRET)).toBe(true)
  })

  it('is deterministic for the same inputs', () => {
    expect(signTrackingToken('open', { sendId: SEND }, SECRET)).toBe(
      signTrackingToken('open', { sendId: SEND }, SECRET),
    )
  })

  it('emits a compact base64url token — URL length matters in email', () => {
    const sig = signTrackingToken('open', { sendId: SEND }, SECRET)
    expect(sig).toHaveLength(TRACKING_SIG_LENGTH)
    expect(TRACKING_SIG_LENGTH).toBe(12)
    expect(sig).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('rejects a signature bound to a different send — the enumeration attack', () => {
    const sig = signTrackingToken('open', { sendId: SEND }, SECRET)
    expect(verifyTrackingToken(sig, 'open', { sendId: NEIGHBOUR }, SECRET)).toBe(false)
  })

  it('rejects a signature bound to a different link on the same send', () => {
    const sig = signTrackingToken('click', { sendId: SEND, linkId: LINK }, SECRET)
    expect(verifyTrackingToken(sig, 'click', { sendId: SEND, linkId: 'ffffffffffff' }, SECRET)).toBe(false)
  })

  it('does not let an open signature be replayed as a click, or vice versa', () => {
    const openSig = signTrackingToken('open', { sendId: SEND }, SECRET)
    expect(verifyTrackingToken(openSig, 'click', { sendId: SEND, linkId: LINK }, SECRET)).toBe(false)

    const clickSig = signTrackingToken('click', { sendId: SEND, linkId: LINK }, SECRET)
    expect(verifyTrackingToken(clickSig, 'open', { sendId: SEND }, SECRET)).toBe(false)
  })

  it('rejects a signature made with a different secret', () => {
    const sig = signTrackingToken('open', { sendId: SEND }, OTHER_SECRET)
    expect(verifyTrackingToken(sig, 'open', { sendId: SEND }, SECRET)).toBe(false)
  })

  it.each([
    ['a flipped character', (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)],
    ['a truncated token', (s: string) => s.slice(0, -1)],
    ['an extended token', (s: string) => s + 'x'],
    ['an empty token', () => ''],
  ])('rejects %s', (_label, mutate) => {
    const sig = signTrackingToken('open', { sendId: SEND }, SECRET)
    expect(verifyTrackingToken(mutate(sig), 'open', { sendId: SEND }, SECRET)).toBe(false)
  })

  it.each([undefined, null, 42, {}, []])('rejects the non-string %s without throwing', (bad) => {
    expect(verifyTrackingToken(bad, 'open', { sendId: SEND }, SECRET)).toBe(false)
  })

  it('rejects a multibyte token of the right character length without throwing', () => {
    // 12 characters but 24+ bytes. If the byte-length pre-check were missing,
    // `crypto.timingSafeEqual` would throw rather than return false.
    expect(verifyTrackingToken('ééééééééééé é'.slice(0, 12), 'open', { sendId: SEND }, SECRET)).toBe(false)
  })

  it('throws on an unknown scope at signing time (allowlist)', () => {
    expect(() => signTrackingToken('unsub' as any, { sendId: SEND }, SECRET)).toThrow(/unknown scope/)
  })

  it('returns false rather than throwing on an unknown scope at verify time', () => {
    const sig = signTrackingToken('open', { sendId: SEND }, SECRET)
    expect(verifyTrackingToken(sig, 'unsub' as any, { sendId: SEND }, SECRET)).toBe(false)
  })

  it('compares with crypto.timingSafeEqual', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    const sig = signTrackingToken('open', { sendId: SEND }, SECRET)
    verifyTrackingToken(sig, 'open', { sendId: SEND }, SECRET)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('does not reach timingSafeEqual when the length differs', () => {
    // The length pre-check must short-circuit: timingSafeEqual throws on
    // mismatched lengths, and a throw is a rejection down a different path.
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    expect(verifyTrackingToken('short', 'open', { sendId: SEND }, SECRET)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// applyTracking URL shapes
// ---------------------------------------------------------------------------

describe('applyTracking — signed URL shapes', () => {
  const html = `<html><body><a href="https://example.com/landing">Go</a></body></html>`

  it('appends a signature the endpoint accepts, for both routes', () => {
    const out = applyTracking(html, {
      sendId: SEND,
      publicUrl: 'https://host.example',
      trackOpens: true,
      trackClicks: true,
      signingSecret: SECRET,
    })

    const pixel = out.html.match(/\/m\/open\/([^"]+)\.png/)!
    const [id, sig] = pixel[1]!.split('.')
    expect(id).toBe(SEND)
    expect(verifyTrackingToken(sig, 'open', { sendId: SEND }, SECRET)).toBe(true)

    const click = out.html.match(/\/m\/click\/([^/]+)\/([^/"]+)\/([^"]+)/)!
    expect(click[1]).toBe(SEND)
    expect(click[2]).toBe(out.links[0]!.linkId)
    expect(verifyTrackingToken(click[3], 'click', { sendId: SEND, linkId: click[2]! }, SECRET)).toBe(true)
  })

  it('costs 13 characters per URL', () => {
    const signed = applyTracking(html, {
      sendId: SEND, publicUrl: 'https://host.example', trackOpens: true, trackClicks: true, signingSecret: SECRET,
    })
    const unsigned = applyTracking(html, {
      sendId: SEND, publicUrl: 'https://host.example', trackOpens: true, trackClicks: true,
    })
    // one separator + 12 signature chars, on each of the two URLs
    expect(signed.html.length - unsigned.html.length).toBe(2 * (1 + TRACKING_SIG_LENGTH))
  })

  it('emits the legacy unsigned shape when no secret is passed', () => {
    const out = applyTracking(html, {
      sendId: SEND, publicUrl: 'https://host.example', trackOpens: true, trackClicks: true,
    })
    expect(out.html).toContain(`/m/open/${SEND}.png`)
    expect(out.html).toContain(`/m/click/${SEND}/${out.links[0]!.linkId}"`)
  })

  it('signs each link separately, so one link does not authorise another', () => {
    const two = `<a href="https://a.example/1">A</a><a href="https://b.example/2">B</a>`
    const out = applyTracking(two, {
      sendId: SEND, publicUrl: 'https://host.example', trackOpens: false, trackClicks: true, signingSecret: SECRET,
    })
    const sigs = [...out.html.matchAll(/\/m\/click\/[^/]+\/[^/]+\/([^"]+)/g)].map((m) => m[1])
    expect(sigs).toHaveLength(2)
    expect(sigs[0]).not.toBe(sigs[1])
  })

  it('keeps the stored links[] map free of signatures — it is keyed by linkId', () => {
    const out = applyTracking(html, {
      sendId: SEND, publicUrl: 'https://host.example', trackOpens: false, trackClicks: true, signingSecret: SECRET,
    })
    expect(out.links).toEqual([{ linkId: expect.stringMatching(/^[a-f0-9]{12}$/), url: 'https://example.com/landing' }])
  })
})

// ---------------------------------------------------------------------------
// Optional defence in depth handed over from #6
// ---------------------------------------------------------------------------

describe('applyTracking — non-http hrefs are never rewritten', () => {
  it.each([
    ['mailto:', 'mailto:hi@example.com'],
    ['tel:', 'tel:+15551234'],
    ['javascript: (e.g. from a substituted variable)', 'javascript:alert(1)'],
    ['JavaScript: mixed case', 'JavaScript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['file:', 'file:///etc/passwd'],
    ['protocol-relative //host', '//evil.example.com/phish'],
    ['an unparseable href', 'not a url at all'],
  ])('leaves %s exactly as authored and stores no link', (_label, href) => {
    const out = applyTracking(`<a href="${href}">x</a>`, {
      sendId: SEND, publicUrl: 'https://host.example', trackOpens: false, trackClicks: true, signingSecret: SECRET,
    })
    expect(out.links).toHaveLength(0)
    expect(out.html).toBe(`<a href="${href}">x</a>`)
    expect(out.html).not.toContain('/m/click/')
  })

  it('does not fail the render when one href of several is malformed', () => {
    const html2 = `<a href="javascript:alert(1)">bad</a><a href="https://good.example/x">good</a>`
    const out = applyTracking(html2, {
      sendId: SEND, publicUrl: 'https://host.example', trackOpens: false, trackClicks: true, signingSecret: SECRET,
    })
    expect(out.links).toHaveLength(1)
    expect(out.links[0]!.url).toBe('https://good.example/x')
    expect(out.html).toContain('href="javascript:alert(1)"')
  })

  it('still rewrites ordinary http and https hrefs', () => {
    for (const href of ['http://plain.example/a', 'https://secure.example/b']) {
      const out = applyTracking(`<a href="${href}">x</a>`, {
        sendId: SEND, publicUrl: 'https://host.example', trackOpens: false, trackClicks: true, signingSecret: SECRET,
      })
      expect(out.links).toHaveLength(1)
      expect(out.html).toContain('/m/click/')
    }
  })
})
