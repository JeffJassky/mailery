import { describe, expect, it } from 'vitest'

import { cleanReportText } from '../../src/server/runner/dmarc-text.js'

describe('cleanReportText', () => {
  it('strips control characters and angle brackets, collapses whitespace, caps length', () => {
    expect(cleanReportText('Yahoo\n\nWhat to do: <https://evil|click>')).toBe('Yahoo What to do: https://evil|click')
    expect(cleanReportText('a\r\nb\tc\u0000d\u007fe')).toBe('a b c d e')
    expect(cleanReportText('x'.repeat(300))).toHaveLength(200)
    expect(cleanReportText('x'.repeat(300), 10)).toHaveLength(10)
    expect(cleanReportText(undefined)).toBe('')
    expect(cleanReportText(42)).toBe('42')
  })
})
