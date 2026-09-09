import { describe, it, expect } from 'vitest'
import { validateHtmlSource } from '../../src/server/templates/html-source.js'

describe('validateHtmlSource', () => {
  it('flags empty input with only html_empty', () => {
    const issues = validateHtmlSource('')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('html_empty')
    expect(issues[0]?.severity).toBe('error')
  })

  it('flags whitespace-only input with only html_empty', () => {
    const issues = validateHtmlSource('   \n\t  ')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('html_empty')
  })

  it('accepts a well-formed document with an img and a br', () => {
    const issues = validateHtmlSource('<html><body><p>Hi<br>there</p><img src="https://x.com/a.png"></body></html>')
    expect(issues).toEqual([])
  })

  it('accepts a self-closing img', () => {
    const issues = validateHtmlSource('<html><body><img src="https://x.com/a.png" /></body></html>')
    expect(issues).toEqual([])
  })

  it('flags a mismatched close as unbalanced', () => {
    const issues = validateHtmlSource('<div><span>hi</div>')
    expect(issues.some((i) => i.rule === 'html_unbalanced_tags')).toBe(true)
  })

  it('flags a stray closing tag as unbalanced', () => {
    const issues = validateHtmlSource('</div>')
    expect(issues.some((i) => i.rule === 'html_unbalanced_tags')).toBe(true)
  })

  it('flags an unclosed tag as unbalanced', () => {
    const issues = validateHtmlSource('<div>hi')
    expect(issues.some((i) => i.rule === 'html_unbalanced_tags')).toBe(true)
  })

  it('flags an unclosed comment', () => {
    const issues = validateHtmlSource('<!-- oops')
    expect(issues.some((i) => i.rule === 'html_unclosed_comment')).toBe(true)
  })

  it('does not treat style-block contents as markup', () => {
    const html = '<html><head><style>a > b { color: red } .odd:not(.even) { color: blue }</style></head><body><p>hi</p></body></html>'
    const issues = validateHtmlSource(html)
    expect(issues.some((i) => i.rule === 'html_unbalanced_tags')).toBe(false)
  })

  it('flags a script tag as a warning, not a balance error', () => {
    const html = '<html><body><script>if (a < b) {}</script><p>hi</p></body></html>'
    const issues = validateHtmlSource(html)
    expect(issues.some((i) => i.rule === 'html_script_tag' && i.severity === 'warning')).toBe(true)
    expect(issues.some((i) => i.rule === 'html_unbalanced_tags')).toBe(false)
  })

  it('warns on a bare fragment with no html/body wrapper', () => {
    const issues = validateHtmlSource('<p>fragment</p>')
    expect(issues.some((i) => i.rule === 'html_missing_body' && i.severity === 'warning')).toBe(true)
  })

  it('ignores tags inside comments for balance checking', () => {
    const html = '<html><body><!-- <div> --><p>hi</p></body></html>'
    const issues = validateHtmlSource(html)
    expect(issues.some((i) => i.rule === 'html_unbalanced_tags')).toBe(false)
  })

  // Email HTML leans on HTML's implicit end tags — a table of <td>s with no
  // </td>, paragraphs closed by the next one. Flagging those would refuse to
  // publish templates that render correctly in every client.
  it('accepts implicitly-closed table cells and rows', () => {
    const html = '<html><body><table><tr><td>one<td>two<tr><td>three</table></body></html>'
    expect(validateHtmlSource(html).some((i) => i.rule === 'html_unbalanced_tags')).toBe(false)
  })

  it('accepts a paragraph closed only by the next one', () => {
    const html = '<html><body><div><p>one<p>two</div></body></html>'
    expect(validateHtmlSource(html).some((i) => i.rule === 'html_unbalanced_tags')).toBe(false)
  })

  it('accepts a trailing unclosed list item', () => {
    const html = '<html><body><ul><li>a<li>b</ul></body></html>'
    expect(validateHtmlSource(html).some((i) => i.rule === 'html_unbalanced_tags')).toBe(false)
  })

  it('still flags a genuinely unclosed container around implicit tags', () => {
    const html = '<html><body><table><tr><td>one</body></html>'
    expect(validateHtmlSource(html).some((i) => i.rule === 'html_unbalanced_tags')).toBe(true)
  })
})
