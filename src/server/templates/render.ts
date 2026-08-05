/**
 * Template render pipeline.
 *
 *  authorMjml + handlebarsContext
 *     ↓ Handlebars render          → MJML with substituted vars
 *     ↓ mjml-core compile          → HTML
 *     ↓ html-to-text derive        → plain text alternative
 *     ↓ applyTracking(sendId)      → tracked HTML with rewritten links + open pixel
 *
 * Subject and preheader run through Handlebars too. Plain text is auto-derived
 * unless the template explicitly overrides it.
 */

import crypto from 'node:crypto'
import Handlebars from 'handlebars'
import { convert as htmlToText } from 'html-to-text'
import mjml2html from 'mjml'

import type { Contact } from '../../shared/types.js'
import type { TemplateDoc } from '../models/index.js'

// ---------------------------------------------------------------------------
// Compile (publish-time)
// ---------------------------------------------------------------------------

export interface CompileResult {
  html: string
  plainText: string
  errors: Array<{ line?: number; message: string; tagName?: string; formattedMessage?: string }>
}

/** Compile MJML → HTML, then derive plain text. Called at template publish time. */
export async function compileTemplate(mjml: string): Promise<CompileResult> {
  const out = await mjml2html(mjml, { validationLevel: 'soft', minify: false })
  const plainText = derivePlaintext(out.html)
  return { html: out.html, plainText, errors: out.errors ?? [] }
}

/**
 * Compile Maily editor JSON (Tiptap-shape) → HTML via `@maily-to/render`, then
 * derive plain text. Called at template publish time when the template was
 * authored via the WYSIWYG editor.
 */
export async function compileMailyTemplate(content: unknown): Promise<CompileResult> {
  const { render } = await import('@maily-to/render')
  const html = await render(content as any)
  const plainText = derivePlaintext(html)
  return { html, plainText, errors: [] }
}

/** Auto-derive plain text from compiled HTML. */
export function derivePlaintext(html: string): string {
  return htmlToText(html, {
    wordwrap: 80,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  }).trim()
}

// ---------------------------------------------------------------------------
// Render (send-time)
// ---------------------------------------------------------------------------

export interface RenderContext {
  /**
   * Host-resolved variables (varsAdapter) live at the context root, so a
   * schema key `user` renders as `{{user.name}}`. Reserved keys below always
   * win over resolved keys.
   */
  [resolvedVar: string]: unknown
  contact: Contact
  vars: Record<string, unknown>
  /** Properties of the event that triggered the flow run ({{event.*}}). Empty outside flow sends. */
  event?: Record<string, unknown>
  /** URL the recipient hits to one-click unsubscribe. */
  unsubscribeUrl: string
  /** URL to view this email in a browser (when implemented). */
  viewInBrowserUrl?: string
  /** URL for the preference center (when implemented). */
  preferenceCenterUrl?: string
  /** Configured sender postal address (CAN-SPAM). */
  senderAddress?: string
}

export interface RenderedTemplate {
  subject: string
  preheader: string
  html: string
  plainText: string
  fromName: string
  fromEmail: string
  replyTo: string | null
}

export interface RenderOptions {
  /** Extra Handlebars helpers contributed by the host. */
  helpers?: Record<string, Handlebars.HelperDelegate>
}

/**
 * Compile options for the text/plain alternative, which is not HTML and has
 * nothing downstream to decode entities. Handlebars' default escaping is
 * corruption there rather than safety: a substituted URL ships as
 * `https://host/p?u&#x3D;123&amp;token&#x3D;abc`, which mail clients render
 * literally, so the recipient follows a link whose query string has fallen
 * apart — every param after the first silently lost. `{{ }}` still
 * interpolates; it just stops escaping what it substitutes.
 */
const PLAIN_TEXT: CompileOptions = { noEscape: true }

/**
 * Render a published template against a contact + vars context. Returns the
 * substituted subject/preheader/html/plainText. Tracking is NOT applied here —
 * that step needs the send id and runs separately via `applyTracking`.
 */
export async function renderTemplate(
  template: TemplateDoc,
  ctx: RenderContext,
  opts: RenderOptions = {},
): Promise<RenderedTemplate> {
  const hb = makeHandlebars(opts.helpers)

  // Both stay escaped: the preheader is injected into the HTML body, and the
  // subject reaches HTML surfaces (admin lists, previews) that render it.
  const subject = hb.compile(template.subject)(ctx)
  const preheader = hb.compile(template.preheader)(ctx)

  // Prefer the compiled HTML if present; fall back to compiling MJML on the fly.
  let html: string
  if (template.body.html) {
    html = hb.compile(template.body.html)(ctx)
  } else {
    const compiled = await compileTemplate(template.body.mjml)
    html = hb.compile(compiled.html)(ctx)
  }

  const plainText = template.body.plainText
    ? hb.compile(template.body.plainText, PLAIN_TEXT)(ctx)
    : derivePlaintext(html)

  return {
    subject,
    preheader,
    html,
    plainText,
    fromName: template.fromName,
    fromEmail: template.fromEmail,
    replyTo: template.replyTo,
  }
}

// ---------------------------------------------------------------------------
// Tracking application
// ---------------------------------------------------------------------------

export interface TrackingOptions {
  sendId: string
  publicUrl: string
  trackOpens: boolean
  trackClicks: boolean
  /** URL that must NOT be rewritten (e.g. the resolved unsubscribe URL). */
  preserveUrls?: string[]
}

export interface TrackingResult {
  html: string
  /** linkId → original URL map; persist on `mailer_sends.links` for click resolution. */
  links: Array<{ linkId: string; url: string }>
}

/**
 * Rewrite `<a href>` in `html` to /m/click/<sendId>/<linkId>?... and append an
 * open pixel. Returns the modified HTML plus the link map to persist on the
 * send document.
 */
export function applyTracking(html: string, opts: TrackingOptions): TrackingResult {
  const preserve = new Set((opts.preserveUrls ?? []).map((u) => u.trim()))
  const links: Array<{ linkId: string; url: string }> = []
  const seen = new Map<string, string>() // url → linkId

  let out = html

  if (opts.trackClicks) {
    out = out.replace(/<a\b([^>]*?)\bhref=(["'])([^"']+)\2([^>]*)>/gi, (full, pre, _q, rawUrl, post) => {
      // Handlebars `{{ }}` escapes substituted URLs (& → &amp;, = → &#x3D;). That is
      // correct in HTML source, but the stored/redirect URL must be the decoded one.
      const url = decodeHtmlEntities(rawUrl)
      if (shouldSkipClickRewrite(url, preserve, full)) return full
      let linkId = seen.get(url)
      if (!linkId) {
        linkId = shortHash(`${opts.sendId}:${url}:${links.length}`)
        seen.set(url, linkId)
        links.push({ linkId, url })
      }
      const newHref = `${opts.publicUrl}/m/click/${opts.sendId}/${linkId}`
      return `<a${pre}href="${newHref}"${post}>`
    })
  }

  if (opts.trackOpens) {
    const pixel = `<img src="${opts.publicUrl}/m/open/${opts.sendId}.png" width="1" height="1" alt="" style="display:block;border:0" />`
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, `${pixel}</body>`)
    } else {
      out = out + pixel
    }
  }

  return { html: out, links }
}

function shouldSkipClickRewrite(url: string, preserve: Set<string>, fullTag: string): boolean {
  if (!url) return true
  if (url.startsWith('mailto:')) return true
  if (url.startsWith('tel:')) return true
  if (url.startsWith('#')) return true
  if (url.startsWith('{{') || url.startsWith('{')) return true // unrendered handlebars
  if (preserve.has(url.trim())) return true
  if (/data-mailer-notrack=["']true["']/.test(fullTag)) return true
  return false
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * Decode the HTML entities Handlebars' escapeExpression emits (plus numeric
 * forms), so a captured href round-trips to the URL the browser would request.
 * `&amp;` is decoded last-wins via a single pass so `&amp;lt;` stays `&lt;`.
 */
function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------------------
// Handlebars instance + helpers
// ---------------------------------------------------------------------------

function makeHandlebars(extra?: Record<string, Handlebars.HelperDelegate>): typeof Handlebars {
  const hb = Handlebars.create()

  hb.registerHelper('eq', (a: unknown, b: unknown) => a === b)
  hb.registerHelper('ne', (a: unknown, b: unknown) => a !== b)
  hb.registerHelper('gt', (a: any, b: any) => a > b)
  hb.registerHelper('lt', (a: any, b: any) => a < b)
  hb.registerHelper('gte', (a: any, b: any) => a >= b)
  hb.registerHelper('lte', (a: any, b: any) => a <= b)
  hb.registerHelper('and', (...args: any[]) => args.slice(0, -1).every(Boolean))
  hb.registerHelper('or', (...args: any[]) => args.slice(0, -1).some(Boolean))
  hb.registerHelper('not', (a: unknown) => !a)

  hb.registerHelper('formatDate', (value: unknown, fmt?: string) => {
    if (!value) return ''
    const d = value instanceof Date ? value : new Date(String(value))
    if (Number.isNaN(d.getTime())) return ''
    if (fmt === 'long') return d.toLocaleDateString('en-US', { dateStyle: 'long' })
    if (fmt === 'short') return d.toLocaleDateString('en-US', { dateStyle: 'short' })
    return d.toISOString().slice(0, 10)
  })

  hb.registerHelper('formatNumber', (n: unknown) => {
    const v = Number(n)
    return Number.isFinite(v) ? v.toLocaleString('en-US') : ''
  })

  hb.registerHelper('formatCurrency', (cents: unknown, currency: string = 'usd') => {
    const v = Number(cents)
    if (!Number.isFinite(v)) return ''
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v / 100)
  })

  hb.registerHelper('pluralize', (n: unknown, one: string, many: string) =>
    Number(n) === 1 ? one : many,
  )

  if (extra) {
    for (const [name, fn] of Object.entries(extra)) {
      hb.registerHelper(name, fn)
    }
  }

  return hb
}

export { makeHandlebars }
