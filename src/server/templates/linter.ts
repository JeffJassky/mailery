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
  /**
   * JSON Schema of the host's varsAdapter (see `varsJsonSchema`). When set,
   * `{{paths}}` in subject/preheader/MJML/editorJson that don't exist in the
   * schema (or the built-in keys) are flagged as `unknown_variable` warnings.
   */
  varsJsonSchema?: Record<string, unknown> | null
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

  // 11a. Unknown template variables — warning (only when a vars schema is provided)
  if (config.varsJsonSchema) {
    const sources = [input.subject, input.preheader, input.mjml, JSON.stringify(input.editorJson ?? null)]
    const unknown = findUnknownVariables(sources.join('\n'), config.varsJsonSchema)
    if (unknown.length > 0) {
      issues.push({
        rule: 'unknown_variable',
        severity: 'warning',
        message: `Template references variable(s) not in the vars schema: ${unknown.join(', ')}.`,
        hint: 'These render as empty strings. Check for typos, or add the key to your varsAdapter schema. Paths inside {{#each}}/{{#with}} blocks are relative and not checked.',
      })
    }
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

// --- unknown_variable helpers ----------------------------------------------

/** Render-context keys mailery provides regardless of the host schema. */
const BUILTIN_VAR_ROOTS = new Set([
  'contact',
  'vars',
  'event',
  'unsubscribeUrl',
  'viewInBrowserUrl',
  'preferenceCenterUrl',
  'senderAddress',
  'this',
])

const PATH_TOKEN = /^@?[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)*$/

/**
 * Extract `{{ ... }}` expressions and return the dotted paths that cannot be
 * found in the vars JSON Schema. Conservative by design: helper arguments,
 * block-relative paths, and any schema shape we can't confidently walk are
 * treated as valid — a warning here should never be a false alarm the
 * operator has to fight.
 */
export function findUnknownVariables(source: string, schema: Record<string, unknown>): string[] {
  // Block helpers introduce relative scopes ({{#each topics}} → {{title}}),
  // so bare single-segment identifiers can't be validated when any exist.
  const hasBlockScopes = /\{\{[#^]\s*(each|with)\b/.test(source)

  const unknown = new Set<string>()
  const re = /\{\{\{?\s*([^{}]+?)\s*\}?\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const expr = m[1]!.trim()
    if (!expr || /^[#^/>!]/.test(expr) || expr === 'else') continue // blocks, partials, comments
    if (expr.includes('(')) continue // subexpressions — too dynamic to check

    // Helper call: skip the helper name, validate path-shaped args.
    // Single token: validate it directly.
    const parts = expr.split(/\s+/)
    const candidates = parts.length > 1 ? parts.slice(1) : parts
    for (const raw of candidates) {
      if (!PATH_TOKEN.test(raw)) continue // quoted strings, numbers, key=val hash args
      if (raw.startsWith('@')) continue // @index, @key, @root
      const segments = raw.split('.')
      if (BUILTIN_VAR_ROOTS.has(segments[0]!)) continue
      if (hasBlockScopes && segments.length === 1) continue // possibly block-relative
      if (!schemaHasPath(schema, segments)) unknown.add(raw)
    }
  }
  return Array.from(unknown)
}

/**
 * Walk a JSON Schema along `segments`. Returns false only when we positively
 * know the path is absent (an object node with declared properties that lacks
 * the segment and forbids extras). Unions, arrays, open objects → true.
 */
function schemaHasPath(node: unknown, segments: string[]): boolean {
  if (segments.length === 0) return true
  if (!node || typeof node !== 'object') return true // can't tell — accept
  const n = node as Record<string, any>

  // Union shapes (zod nullable/optional/union): valid if any branch accepts.
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(n[key])) {
      return (n[key] as unknown[]).some((branch) => schemaHasPath(branch, segments))
    }
  }

  if (Array.isArray(n.type) && n.type.includes('object') && !n.properties) return true
  if (n.type === 'array') {
    if (segments[0] === 'length') return true // {{topics.length}}
    return schemaHasPath(n.items, segments)
  }

  const props = n.properties
  if (!props || typeof props !== 'object') return true // not a closed object — accept

  const [head, ...rest] = segments
  if (head! in props) return schemaHasPath(props[head!], rest)
  // Segment missing — only reject when the object doesn't allow extras.
  if (n.additionalProperties === undefined || n.additionalProperties === false) return false
  return true
}

function isAllCaps(subject: string): boolean {
  const letters = subject.replace(/[^a-zA-Z]/g, '')
  if (letters.length < 5) return false
  const upper = subject.replace(/[^A-Z]/g, '').length
  return upper / letters.length > 0.5
}
