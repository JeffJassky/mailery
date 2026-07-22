import { describe, it, expect } from 'vitest'
import {
  compileTemplate,
  derivePlaintext,
  applyTracking,
} from '../../src/server/templates/render.js'

describe('compileTemplate', () => {
  it('compiles MJML to HTML', async () => {
    const result = await compileTemplate(`<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>`)
    expect(result.html).toContain('Hello')
    expect(result.html).toContain('<html')
  })

  it('derives plaintext from HTML', () => {
    const text = derivePlaintext('<html><body><p>Greeting line.</p><p>This is <a href="https://x.com">a link</a>.</p></body></html>')
    expect(text).toContain('Greeting line')
    expect(text).toContain('a link')
  })
})

describe('applyTracking', () => {
  const baseHtml = `<html><body><p><a href="https://example.com/path">Go</a></p><p><a href="mailto:hi@example.com">Mail</a></p><p><a href="#anchor">Skip</a></p></body></html>`

  it('rewrites trackable links and assigns linkIds', () => {
    const out = applyTracking(baseHtml, {
      sendId: 'snd_test',
      publicUrl: 'https://host.example',
      trackOpens: true,
      trackClicks: true,
    })

    expect(out.html).toContain('https://host.example/m/click/snd_test/')
    expect(out.html).not.toMatch(/href="https:\/\/example\.com\/path"/)
    // mailto + anchor preserved
    expect(out.html).toContain('mailto:hi@example.com')
    expect(out.html).toContain('href="#anchor"')

    expect(out.links).toHaveLength(1)
    expect(out.links[0]?.url).toBe('https://example.com/path')
    expect(out.links[0]?.linkId).toMatch(/^[a-f0-9]{12}$/)
  })

  it('preserves explicitly-passed URLs (the unsubscribe URL)', () => {
    const unsubUrl = 'https://host.example/m/unsub/tok'
    const html = `<a href="${unsubUrl}">Unsub</a><a href="https://other.com">Other</a>`
    const out = applyTracking(html, {
      sendId: 'snd_test',
      publicUrl: 'https://host.example',
      trackOpens: false,
      trackClicks: true,
      preserveUrls: [unsubUrl],
    })
    expect(out.html).toContain(`href="${unsubUrl}"`)
    expect(out.html).toContain('https://host.example/m/click/snd_test/')
    expect(out.links).toHaveLength(1)
  })

  it('appends an open pixel before </body>', () => {
    const out = applyTracking(`<html><body>hi</body></html>`, {
      sendId: 'snd_test',
      publicUrl: 'https://host.example',
      trackOpens: true,
      trackClicks: false,
    })
    expect(out.html).toContain('https://host.example/m/open/snd_test.png')
    expect(out.html).toMatch(/<img[^>]+\/m\/open\/snd_test\.png[^>]+\/>\s*<\/body>/)
  })

  it('stores the decoded URL when Handlebars escaped the href', () => {
    // `{{topicUrl}}` renders &-and-= escaped: &amp; / &#x3D;
    const html = `<a href="https://example.com/p?a&#x3D;1&amp;b&#x3D;2">Go</a>`
    const out = applyTracking(html, {
      sendId: 'snd_test',
      publicUrl: 'https://host.example',
      trackOpens: false,
      trackClicks: true,
    })
    expect(out.links).toHaveLength(1)
    expect(out.links[0]?.url).toBe('https://example.com/p?a=1&b=2')
  })

  it('dedupes escaped and raw forms of the same URL to one linkId', () => {
    const html =
      `<a href="https://example.com/p?a&#x3D;1&amp;b&#x3D;2">One</a>` +
      `<a href="https://example.com/p?a=1&b=2">Two</a>`
    const out = applyTracking(html, {
      sendId: 'snd_test',
      publicUrl: 'https://host.example',
      trackOpens: false,
      trackClicks: true,
    })
    expect(out.links).toHaveLength(1)
  })

  it('preserves an escaped unsubscribe URL', () => {
    const unsubUrl = 'https://host.example/m/unsub?t=tok&u=123'
    const html = `<a href="https://host.example/m/unsub?t&#x3D;tok&amp;u&#x3D;123">Unsub</a>`
    const out = applyTracking(html, {
      sendId: 'snd_test',
      publicUrl: 'https://host.example',
      trackOpens: false,
      trackClicks: true,
      preserveUrls: [unsubUrl],
    })
    expect(out.links).toHaveLength(0)
    expect(out.html).toContain('m/unsub?t&#x3D;tok')
  })

  it('respects data-mailer-notrack', () => {
    const html = `<a href="https://example.com" data-mailer-notrack="true">Don't track</a>`
    const out = applyTracking(html, {
      sendId: 'snd_test',
      publicUrl: 'https://host.example',
      trackOpens: false,
      trackClicks: true,
    })
    expect(out.html).toContain('href="https://example.com"')
    expect(out.links).toHaveLength(0)
  })
})
