import { describe, expect, it } from 'vitest'

import { lintTemplate, type LintInput } from '../../src/server/templates/linter.js'

function baseInput(overrides: Partial<LintInput> = {}): LintInput {
  return {
    subject: 'Welcome to our service',
    preheader: 'Get started in two minutes',
    mjml: '',
    html: '<html><body><p>Hi there! Here is the link to your <a href="https://example.com/start">dashboard</a>. <a href="{{unsubscribeUrl}}">unsubscribe</a></p></body></html>',
    plainText: 'Hi there! Here is the link to your dashboard: https://example.com/start',
    kind: 'marketing',
    fromEmail: 'hello@example.com',
    ...overrides,
  }
}

describe('lintTemplate — golden path', () => {
  it('passes a clean marketing template', () => {
    const r = lintTemplate(baseInput())
    expect(r.errors).toEqual([])
    // Allow warnings/infos; just no errors blocking publish.
  })

  it('passes a clean transactional template (no unsubscribe required)', () => {
    const r = lintTemplate(
      baseInput({
        kind: 'transactional',
        html: '<html><body><p>Your password reset link is <a href="https://example.com/reset">here</a>.</p></body></html>',
        plainText: 'Your password reset link is here.',
      }),
    )
    expect(r.errors).toEqual([])
  })
})

describe('lintTemplate — error rules', () => {
  it('missing_plain_text', () => {
    const r = lintTemplate(baseInput({ plainText: '   ' }))
    expect(r.errors.some((e) => e.rule === 'missing_plain_text')).toBe(true)
  })

  it('image_only_body', () => {
    const r = lintTemplate(
      baseInput({
        html: '<html><body><img src="x" /><img src="y" /><a href="{{unsubscribeUrl}}">u</a></body></html>',
        plainText: 'a',
      }),
    )
    expect(r.errors.some((e) => e.rule === 'image_only_body')).toBe(true)
  })

  it('url_shortener', () => {
    const r = lintTemplate(
      baseInput({
        html: '<html><body><a href="https://bit.ly/abc">click</a><a href="{{unsubscribeUrl}}">u</a></body></html>',
      }),
    )
    expect(r.errors.some((e) => e.rule === 'url_shortener')).toBe(true)
  })

  it('missing_unsubscribe_tag (marketing)', () => {
    const r = lintTemplate(
      baseInput({
        html: '<html><body><p>Hi <a href="https://example.com">click</a></p></body></html>',
        plainText: 'Hi',
      }),
    )
    expect(r.errors.some((e) => e.rule === 'missing_unsubscribe_tag')).toBe(true)
  })

  it('sender_domain_invalid surfaces registry mismatch', () => {
    const r = lintTemplate(
      baseInput({ fromEmail: 'hi@wrong.com' }),
      { senderDomains: { 'example.com': { kind: 'marketing' } } },
    )
    expect(r.errors.some((e) => e.rule === 'sender_domain_invalid')).toBe(true)
  })
})

describe('lintTemplate — warning rules', () => {
  it('bare_url', () => {
    const r = lintTemplate(
      baseInput({
        html: '<html><body><p>Visit https://example.com/bare to learn more.</p><a href="{{unsubscribeUrl}}">u</a></body></html>',
      }),
    )
    expect(r.warnings.some((w) => w.rule === 'bare_url')).toBe(true)
  })

  it('spam_phrases — FREE', () => {
    const r = lintTemplate(baseInput({ subject: 'Get this FREE today' }))
    expect(r.warnings.some((w) => w.rule === 'spam_phrases' && w.message.includes('FREE'))).toBe(true)
  })

  it('spam_phrases — ACT NOW', () => {
    const r = lintTemplate(baseInput({ plainText: 'Act now to save 50%! Visit dashboard.' }))
    expect(r.warnings.some((w) => w.rule === 'spam_phrases')).toBe(true)
  })

  it('spam_phrases — excessive !!!', () => {
    const r = lintTemplate(baseInput({ subject: 'You won!!!' }))
    expect(r.warnings.some((w) => w.rule === 'spam_phrases')).toBe(true)
  })

  it('all_caps_subject', () => {
    const r = lintTemplate(baseInput({ subject: 'BIG SALE TODAY ONLY' }))
    expect(r.warnings.some((w) => w.rule === 'all_caps_subject')).toBe(true)
  })

  it('all_caps_subject ignores short subjects', () => {
    const r = lintTemplate(baseInput({ subject: 'HI' }))
    expect(r.warnings.some((w) => w.rule === 'all_caps_subject')).toBe(false)
  })

  it('subject_too_long', () => {
    const r = lintTemplate(
      baseInput({ subject: 'a'.repeat(80) }),
    )
    expect(r.warnings.some((w) => w.rule === 'subject_too_long')).toBe(true)
  })

  it('too_many_links', () => {
    const links = Array.from({ length: 12 }, (_, i) => `<a href="https://example.com/${i}">link ${i}</a>`).join('')
    const r = lintTemplate(
      baseInput({ html: `<html><body>${links}<a href="{{unsubscribeUrl}}">u</a></body></html>` }),
    )
    expect(r.warnings.some((w) => w.rule === 'too_many_links')).toBe(true)
  })
})

describe('lintTemplate — info rules', () => {
  it('empty_preheader', () => {
    const r = lintTemplate(baseInput({ preheader: '' }))
    expect(r.infos.some((i) => i.rule === 'empty_preheader')).toBe(true)
  })
})

describe('lintTemplate — no false positives', () => {
  it('unsubscribe tag with extra whitespace is accepted', () => {
    const r = lintTemplate(
      baseInput({
        html: '<html><body><p>Hi <a href="{{ unsubscribeUrl }}">unsubscribe</a></p></body></html>',
      }),
    )
    expect(r.errors.some((e) => e.rule === 'missing_unsubscribe_tag')).toBe(false)
  })

  it('detects unsubscribe tag in mjml source when rendered html has encoded braces', () => {
    // @maily-to/render HTML-encodes `{{ }}` placed in body text — checking
    // only the compiled html would miss legitimate tag placements. Scanning
    // the mjml source picks it up regardless.
    const r = lintTemplate(
      baseInput({
        mjml: '<mjml><mj-body><mj-text>Unsubscribe at {{unsubscribeUrl}}</mj-text></mj-body></mjml>',
        html: '<html><body><p>Unsubscribe at &#x7B;&#x7B;unsubscribeUrl&#x7D;&#x7D;</p></body></html>',
      }),
    )
    expect(r.errors.some((e) => e.rule === 'missing_unsubscribe_tag')).toBe(false)
  })

  it('detects unsubscribe tag in editorJson when html lacks it', () => {
    const r = lintTemplate(
      baseInput({
        editorJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Click {{unsubscribeUrl}} to opt out' }] }] },
        html: '<html><body><p>Click <span>encoded</span> to opt out</p></body></html>',
      }),
    )
    expect(r.errors.some((e) => e.rule === 'missing_unsubscribe_tag')).toBe(false)
  })

  it('URL inside an anchor does not trigger bare_url', () => {
    const r = lintTemplate(
      baseInput({
        html: '<html><body><p><a href="https://example.com">https://example.com</a></p><a href="{{unsubscribeUrl}}">u</a></body></html>',
      }),
    )
    expect(r.warnings.some((w) => w.rule === 'bare_url')).toBe(false)
  })

  it('exactly 10 links does not trigger too_many_links', () => {
    const links = Array.from({ length: 10 }, (_, i) => `<a href="https://example.com/${i}">link</a>`).join('')
    const r = lintTemplate(
      baseInput({ html: `<html><body>${links}</body></html>`, kind: 'transactional' }),
    )
    expect(r.warnings.some((w) => w.rule === 'too_many_links')).toBe(false)
  })

  it('image with substantial text does not trigger image_only_body', () => {
    const r = lintTemplate(
      baseInput({
        html: '<html><body><img src="x" /><p>Hello, this is a paragraph long enough to clear the threshold.</p><a href="{{unsubscribeUrl}}">u</a></body></html>',
        plainText: 'Hello, this is a paragraph long enough to clear the threshold.',
      }),
    )
    expect(r.errors.some((e) => e.rule === 'image_only_body')).toBe(false)
  })
})
