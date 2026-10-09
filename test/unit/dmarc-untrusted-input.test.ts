/**
 * Report contents are attacker-supplied (anyone can email the rua mailbox).
 * plans/18-dmarc-monitoring.md §3.10, §6.3a. Red until the R2 fix lands.
 */

import { describe, expect, it } from 'vitest'

import { parseDmarcReport } from '../../src/server/runner/dmarc.js'
import { isDmarcMonitorConfigured } from '../../src/server/runner/dmarc-monitor.js'

function xml(records: string, org = 'google.com', email = 'noreply@google.com'): string {
  return `<?xml version="1.0"?>
<feedback>
  <report_metadata><org_name>${org}</org_name><email>${email}</email><report_id>r1</report_id>
    <date_range><begin>1718064000</begin><end>1718150400</end></date_range></report_metadata>
  <policy_published><domain>example.com</domain><p>none</p><pct>100</pct></policy_published>
  ${records}
</feedback>`
}

function record(ip: string, count: number, headerFrom = 'example.com'): string {
  return `<record><row><source_ip>${ip}</source_ip><count>${count}</count>
    <policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row>
    <identifiers><header_from>${headerFrom}</header_from></identifiers></record>`
}

describe('parseDmarcReport with hostile input', () => {
  it('drops failing records whose source_ip is not an IP, but still counts them', () => {
    const p = parseDmarcReport(
      xml(record('198.51.100.7', 5) + record('1.2.3.4\n[CRITICAL] rotate keys at &lt;https://evil|here&gt;', 7) + record('2001:db8::1', 2)),
    )
    expect(p.failures.map((f) => f.sourceIp)).toEqual(['198.51.100.7', '2001:db8::1'])
    expect(p.report.failCount).toBe(14)
    expect(p.report.totalMessages).toBe(14)
  })

  it('cleans org_name, email and header_from: no control characters, no angle brackets, at most 200 chars', () => {
    const p = parseDmarcReport(
      xml(
        record('198.51.100.7', 5, 'example.com\nInjected: yes'),
        'Yahoo\n\nWhat to do: &lt;https://evil|click&gt;' + 'x'.repeat(300),
        'a@b.com\r\nBcc: x',
      ),
    )
    for (const s of [p.report.orgName, p.report.email, p.failures[0]!.headerFrom]) {
      expect(s).not.toMatch(/[\u0000-\u001f\u007f<>]/)
      expect(s.length).toBeLessThanOrEqual(200)
    }
    expect(p.report.orgName.startsWith('Yahoo What to do:')).toBe(true)
  })
})

describe('enumerated report fields are whitelisted', () => {
  const evil = '1\n[CRITICAL] rotate keys at &lt;https://evil|here&gt;'

  it('an unknown policy becomes none; unknown auth results become unknown', () => {
    const doc = xml(
      `<record><row><source_ip>198.51.100.7</source_ip><count>5</count>
        <policy_evaluated><disposition>none</disposition><dkim>${evil}</dkim><spf>${evil}</spf></policy_evaluated></row>
        <identifiers><header_from>example.com</header_from></identifiers></record>`,
    ).replace('<p>none</p>', `<p>${evil}</p>`)
    const p = parseDmarcReport(doc)
    expect(p.report.policyP).toBe('none')
    expect(p.failures[0]!.dkimResult).toBe('unknown')
    expect(p.failures[0]!.spfResult).toBe('unknown')
  })

  it('a report whose domain is not a domain is rejected', () => {
    expect(() => parseDmarcReport(xml(record('198.51.100.7', 5)).replace('<domain>example.com</domain>', `<domain>example.com${evil}</domain>`))).toThrow()
  })
})

describe('isDmarcMonitorConfigured', () => {
  it('0.20 keys alone do not opt in', () => {
    expect(isDmarcMonitorConfigured({})).toBe(false)
    expect(isDmarcMonitorConfigured({ dmarc: {} })).toBe(false)
    expect(isDmarcMonitorConfigured({ dmarc: { retentionDays: 30, knownSources: [{ ip: '1.2.3.4', label: 'x' }] } })).toBe(false)
  })

  it('any 0.21 key or a hook opts in', () => {
    expect(isDmarcMonitorConfigured({ dmarc: { alerts: {} } })).toBe(true)
    expect(isDmarcMonitorConfigured({ dmarc: { reportAddress: 'r@x.com' } })).toBe(true)
    expect(isDmarcMonitorConfigured({ dmarc: { extraDomains: [] } })).toBe(true)
    expect(isDmarcMonitorConfigured({ dmarc: { ignoredDomains: ['x.com'] } })).toBe(true)
    expect(isDmarcMonitorConfigured({ dmarc: { adminUrl: 'https://a' } })).toBe(true)
    expect(isDmarcMonitorConfigured({ onDmarcAlert: () => {} })).toBe(true)
  })
})
