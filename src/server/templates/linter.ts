/**
 * Content linter for email templates. Pure function — no I/O.
 *
 *   const result = lintTemplate(input, { senderDomains })
 *   if (result.errors.length) refuse to publish
 *
 * The publish endpoint runs this as a gate. The editor will eventually run it
 * live for inline squiggles (PR10) — same engine, same rules.
 */

import type { TemplateKind } from '../../shared/enums.js'
import type { SenderDomainRegistry } from './sender-domain.js'
import { validateSenderDomain } from './sender-domain.js'

export type LintSeverity = 'error' | 'warning' | 'info'

export interface LintIssue {
  /** Stable rule identifier, e.g. 'missing_plain_text'. */
  rule: string
  severity: LintSeverity
  message: string
  /** Optional remediation hint shown in tooltips/expanders. */
  hint?: string
}

export interface LintResult {
  errors: LintIssue[]
  warnings: LintIssue[]
  infos: LintIssue[]
}

export interface LintInput {
  subject: string
  preheader: string
  /** MJML source, when authored that way. Empty string when authored via Maily. */
  mjml: string
  /**
   * Maily editor JSON source, when authored that way. Optional — passing it
   * helps rules that scan for merge tags survive HTML-encoding of braces
   * in body text.
   */
  editorJson?: unknown
  /** Rendered HTML. */
  html: string
  /** Rendered plain-text alternative. */
  plainText: string
  kind: TemplateKind
  fromEmail: string
}

export interface LintConfig {
  senderDomains?: SenderDomainRegistry
}

const URL_SHORTENERS = ['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly']

const SPAM_PHRASES: Array<{ pattern: RegExp; phrase: string }> = [
  { pattern: /\bFREE\b/, phrase: 'FREE' },
  { pattern: /\bACT NOW\b/i, phrase: 'ACT NOW' },
  { pattern: /\b100%\s+guaranteed\b/i, phrase: '100% guaranteed' },
]

const MARKETING_UNSUBSCRIBE_TAG = /\{\{\s*unsubscribeUrl\s*\}\}/

export function lintTemplate(rawInput: LintInput, config: LintConfig = {}): LintResult {
  // Coerce missing/undefined fields so downstream `.length` / `.test()`
  // calls don't throw. The publish path can hand us a draft with an
  // undefined subject, and we'd rather lint it (and emit a length warning)
  // than 500.
  const input: LintInput = {
    subject: typeof rawInput.subject === 'string' ? rawInput.subject : '',
    preheader: typeof rawInput.preheader === 'string' ? rawInput.preheader : '',
    mjml: typeof rawInput.mjml === 'string' ? rawInput.mjml : '',
    editorJson: rawInput.editorJson,
    html: typeof rawInput.html === 'string' ? rawInput.html : '',
    plainText: typeof rawInput.plainText === 'string' ? rawInput.plainText : '',
    kind: rawInput.kind === 'marketing' || rawInput.kind === 'transactional' ? rawInput.kind : 'transactional',
    fromEmail: typeof rawInput.fromEmail === 'string' ? rawInput.fromEmail : '',
  }
  const issues: LintIssue[] = []

  // 1. Missing plain-text alternative — error
  if (!input.plainText || input.plainText.trim().length === 0) {
    issues.push({
      rule: 'missing_plain_text',
      severity: 'error',
      message: 'Plain-text alternative is empty.',
      hint: 'Email clients and spam filters use the plain-text part. Add visible text content (MJML mj-text blocks, or text content in the Maily editor) — do not strip plain-text to empty.',
    })
  }

  // 2. Image-only body — error
  const imageCount = countMatches(input.html, /<img\b/gi)
  const textLen = input.plainText.trim().length
  if (imageCount >= 1 && textLen < 20) {
    issues.push({
      rule: 'image_only_body',
      severity: 'error',
      message: 'Body is mostly images with little or no text.',
      hint: 'Image-only emails are heavily filtered as spam. Add at least one paragraph of meaningful text.',
    })
  }

  // 3. URL shortener — error
  const shortenerLinks = findShortenerLinks(input.html)
  if (shortenerLinks.length > 0) {
    issues.push({
      rule: 'url_shortener',
      severity: 'error',
      message: `Link uses a URL shortener: ${shortenerLinks.join(', ')}.`,
      hint: 'URL shorteners are strongly correlated with spam and are routinely blocked. Use a direct link to your domain.',
    })
  }

  // 4. Bare URL in body — warning
  if (hasBareUrlInVisibleText(input.html)) {
    issues.push({
      rule: 'bare_url',
      severity: 'warning',
      message: 'A URL appears in the body text without being wrapped in a link.',
      hint: 'Wrap visible URLs in an anchor tag — bare URLs look like spam template residue and reduce engagement.',
    })
  }

  // 5. Spammy phrases — warning (check both subject and plainText)
  const spam = findSpamSignals(`${input.subject}\n${input.plainText}`)
  if (spam.length > 0) {
    issues.push({
      rule: 'spam_phrases',
      severity: 'warning',
      message: `Content contains spam-flagged phrases: ${spam.join(', ')}.`,
      hint: 'These phrases trigger content filters. Rephrase if possible.',
    })
  }

  // 6. All-caps subject — warning
  if (isAllCaps(input.subject)) {
    issues.push({
      rule: 'all_caps_subject',
      severity: 'warning',
      message: 'Subject line is mostly uppercase.',
      hint: 'All-caps subjects are flagged by spam filters and reduce click-through. Use sentence case.',
    })
  }

  // 7. Missing unsubscribe merge tag (marketing only) — error.
  // Check the raw mjml + editorJson + compiled HTML. @maily-to/render
  // HTML-encodes the `{{ }}` braces when they're placed in body text
  // (not in href), so checking only the rendered html misses legitimate
  // unsubscribe-tag placements.
  if (input.kind === 'marketing') {
    const sources = [input.mjml ?? '', input.html ?? '', JSON.stringify(input.editorJson ?? null)]
    const hasTag = sources.some((s) => MARKETING_UNSUBSCRIBE_TAG.test(s))
    if (!hasTag) {
      issues.push({
        rule: 'missing_unsubscribe_tag',
        severity: 'error',
        message: 'Marketing template is missing the {{unsubscribeUrl}} merge tag.',
        hint: 'CAN-SPAM, GDPR, and Gmail/Yahoo bulk-sender rules all require a working unsubscribe link. Add {{unsubscribeUrl}} somewhere in the body.',
      })
    }
  }

  // 8. From-domain mismatch — error (mirrors the publish-time check)
  const senderCheck = validateSenderDomain(input.fromEmail, input.kind, config.senderDomains)
  if (!senderCheck.ok) {
    issues.push({
      rule: 'sender_domain_invalid',
      severity: 'error',
      message: senderCheck.reason,
      hint: 'Edit the template fromEmail to use a domain declared for this kind in senderDomains, or update the registry.',
    })
  }

  // 9. Empty preheader — info
  if (!input.preheader || input.preheader.trim().length === 0) {
    issues.push({
      rule: 'empty_preheader',
      severity: 'info',
      message: 'No preheader set.',
      hint: 'The preheader shows next to the subject in most inbox previews. A good preheader lifts open rate 5-10%.',
    })
  }

  // 10. Subject too long — warning
  if (input.subject.length > 60) {
    issues.push({
      rule: 'subject_too_long',
      severity: 'warning',
      message: `Subject is ${input.subject.length} characters; mobile clients truncate around 60.`,
      hint: 'Front-load the important words so the truncated preview still makes sense.',
    })
  }

  // 11. Too many links — warning
  // Match href= with or without surrounding quotes — same shape as
  // extractHrefs above.
  const linkCount = countMatches(input.html, /<a\s[^>]*\bhref\s*=/gi)
  if (linkCount > 10) {
    issues.push({
      rule: 'too_many_links',
      severity: 'warning',
      message: `${linkCount} links in body; promotional content with many links is flagged by content filters.`,
      hint: 'Consolidate calls-to-action. Aim for one primary action plus a footer link or two.',
    })
  }

  return splitBySeverity(issues)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitBySeverity(issues: LintIssue[]): LintResult {
  const out: LintResult = { errors: [], warnings: [], infos: [] }
  for (const i of issues) {
    if (i.severity === 'error') out.errors.push(i)
    else if (i.severity === 'warning') out.warnings.push(i)
    else out.infos.push(i)
  }
  return out
}

function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length
}

function findShortenerLinks(html: string): string[] {
  const hrefs = extractHrefs(html)
  const hits = new Set<string>()
  for (const href of hrefs) {
    const domain = hostnameOf(href)
    if (!domain) continue
    if (URL_SHORTENERS.includes(domain)) hits.add(domain)
  }
  return Array.from(hits)
}

function extractHrefs(html: string): string[] {
  const out: string[] = []
  // Match href values in any of: double-quoted, single-quoted, or
  // unquoted (terminated by space, `>`, or end of tag). Maily-generated
  // HTML mostly quotes but operator-edited MJML may not.
  const re = /<a\s[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = m[1] ?? m[2] ?? m[3]
    if (href) out.push(href)
  }
  return out
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Heuristic: strip anchor tags (and their contents), plus `<style>`,
 * `<script>`, and `<head>` blocks before looking for a bare URL. Otherwise
 * URLs in CSS (`@import url(...)`) or scripts trigger a false positive.
 */
function hasBareUrlInVisibleText(html: string): boolean {
  const stripped = html
    .replace(/<a\b[^>]*>.*?<\/a>/gis, ' ')
    .replace(/<style\b[^>]*>.*?<\/style>/gis, ' ')
    .replace(/<script\b[^>]*>.*?<\/script>/gis, ' ')
    .replace(/<head\b[^>]*>.*?<\/head>/gis, ' ')
  return /https?:\/\/[^\s<>"']+/i.test(stripped)
}

function findSpamSignals(text: string): string[] {
  const out = new Set<string>()
  for (const { pattern, phrase } of SPAM_PHRASES) {
    if (pattern.test(text)) out.add(phrase)
  }
  if (/!{3,}/.test(text)) out.add('excessive "!!!"')
  return Array.from(out)
}

function isAllCaps(subject: string): boolean {
  const letters = subject.replace(/[^a-zA-Z]/g, '')
  if (letters.length < 5) return false
  const upper = subject.replace(/[^A-Z]/g, '').length
  return upper / letters.length > 0.5
}
