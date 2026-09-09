/**
 * Validation for hand-written HTML template bodies. Pure function — no I/O.
 *
 * The MJML and Design (Maily) tabs get structural errors for free from their
 * compilers (mjml2html / @maily-to/render). Raw HTML has no compiler standing
 * between the author and the send, so without this the HTML tab would be a
 * validation blind spot compared with the other two authoring paths.
 */

export interface HtmlSourceIssue {
  rule: string
  severity: 'error' | 'warning'
  message: string
  hint?: string
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const BALANCE_HINT =
  'Mail clients differ wildly in how they recover from unbalanced markup — fix it in the source.'

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g

/**
 * Elements whose end tag HTML itself makes optional. Email HTML is full of
 * them — a `<td>` per cell with no `</td>`, `<p>` paragraphs closed only by
 * the next one — and a naive stack would call every such (valid, correctly
 * rendering) template malformed and refuse to publish it. Real parsers close
 * these implicitly; so do we.
 */
const OPTIONAL_END_TAGS = new Set([
  'p', 'li', 'td', 'th', 'tr', 'thead', 'tbody', 'tfoot',
  'option', 'optgroup', 'dd', 'dt', 'colgroup', 'caption', 'rt', 'rp',
])

/** Strip comments, doctype, and the contents of <script>/<style> so the balance scan only sees markup. */
function stripNonMarkup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

/** Walk every <!-- ... --> pair in order; true if one is left dangling with no matching close. */
function hasUnclosedComment(html: string): boolean {
  let searchFrom = 0
  while (true) {
    const start = html.indexOf('<!--', searchFrom)
    if (start === -1) return false
    const end = html.indexOf('-->', start + 4)
    if (end === -1) return true
    searchFrom = end + 3
  }
}

function findUnbalancedTags(html: string): HtmlSourceIssue | null {
  const stack: string[] = []
  const stripped = stripNonMarkup(html)

  TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(stripped)) !== null) {
    const [, closingSlash, rawName, selfClosingSlash] = match
    const name = (rawName ?? '').toLowerCase()
    if (selfClosingSlash === '/') continue
    if (VOID_ELEMENTS.has(name)) continue

    if (closingSlash === '/') {
      // Close any implicitly-closed elements sitting above this one before
      // judging the match — `<tr><td>x</tr>` is well-formed HTML.
      while (stack.length > 0 && stack[stack.length - 1] !== name && OPTIONAL_END_TAGS.has(stack[stack.length - 1]!)) {
        stack.pop()
      }
      if (stack.length === 0) {
        return {
          rule: 'html_unbalanced_tags',
          severity: 'error',
          message: `Closing </${name}> has no matching opening tag.`,
          hint: BALANCE_HINT,
        }
      }
      const top = stack[stack.length - 1]
      if (top !== name) {
        return {
          rule: 'html_unbalanced_tags',
          severity: 'error',
          message: `Expected </${top}> but found </${name}>.`,
          hint: BALANCE_HINT,
        }
      }
      stack.pop()
    } else {
      stack.push(name)
    }
  }

  // Same courtesy at end of input: a trailing unclosed <td>/<p> is valid.
  while (stack.length > 0 && OPTIONAL_END_TAGS.has(stack[stack.length - 1]!)) stack.pop()

  if (stack.length > 0) {
    const innermost = stack[stack.length - 1]
    return {
      rule: 'html_unbalanced_tags',
      severity: 'error',
      message: `Unclosed <${innermost}> tag.`,
      hint: BALANCE_HINT,
    }
  }

  return null
}

export function validateHtmlSource(html: string): HtmlSourceIssue[] {
  if (html.trim() === '') {
    return [
      {
        rule: 'html_empty',
        severity: 'error',
        message: 'HTML source is empty.',
        hint: 'Paste or write the message body. An empty source publishes an empty email.',
      },
    ]
  }

  const issues: HtmlSourceIssue[] = []

  if (hasUnclosedComment(html)) {
    issues.push({
      rule: 'html_unclosed_comment',
      severity: 'error',
      message: 'An HTML comment is never closed (<!-- with no matching -->).',
      hint: 'Everything after an unclosed comment disappears from the rendered email.',
    })
  }

  const balanceIssue = findUnbalancedTags(html)
  if (balanceIssue) issues.push(balanceIssue)

  if (/<script\b/i.test(html)) {
    issues.push({
      rule: 'html_script_tag',
      severity: 'warning',
      message: 'Body contains a <script> tag.',
      hint: 'Every mail client strips scripts, and their presence pushes spam scores up. Remove it.',
    })
  }

  if (!/<body\b/i.test(html) && !/<html\b/i.test(html)) {
    issues.push({
      rule: 'html_missing_body',
      severity: 'warning',
      message: 'Source has no <html>/<body> wrapper.',
      hint: 'Some clients handle a bare fragment badly. Wrap the content in a full HTML document.',
    })
  }

  return issues
}
