import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import zlib from 'node:zlib'
import AdmZip from 'adm-zip'

import { extractDmarcXml, parseDmarcReport } from '../../src/server/runner/dmarc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, '..', 'fixtures', 'dmarc', name), 'utf8')
}

describe('parseDmarcReport — clean Google report', () => {
  it('parses report metadata + zero failures when all aligned', () => {
    const parsed = parseDmarcReport(fixture('google-clean.xml'))
    expect(parsed.report.reportId).toBe('10000000000001')
    expect(parsed.report.orgName).toBe('google.com')
    expect(parsed.report.domain).toBe('example.com')
    expect(parsed.report.policyP).toBe('none')
    expect(parsed.report.policyPct).toBe(100)
    expect(parsed.report.totalMessages).toBe(423)
    expect(parsed.report.passCount).toBe(423)
    expect(parsed.report.failCount).toBe(0)
    expect(parsed.failures).toHaveLength(0)
  })
})

describe('parseDmarcReport — mixed Yahoo report', () => {
  it('counts pass vs fail correctly and emits one failure row per non-aligned source', () => {
    const parsed = parseDmarcReport(fixture('yahoo-mixed.xml'))
    expect(parsed.report.totalMessages).toBe(218)
    expect(parsed.report.passCount).toBe(200)
    expect(parsed.report.failCount).toBe(18)
    expect(parsed.failures).toHaveLength(2)

    const f1 = parsed.failures.find((f) => f.sourceIp === '198.51.100.7')!
    expect(f1.count).toBe(15)
    expect(f1.dkimResult).toBe('fail')
    expect(f1.spfResult).toBe('fail')
    expect(f1.dispositionApplied).toBe('quarantine')
    expect(f1.headerFrom).toBe('example.com')

    const f2 = parsed.failures.find((f) => f.sourceIp === '203.0.113.50')!
    expect(f2.count).toBe(3)
    expect(f2.dkimResult).toBe('fail')
    expect(f2.spfResult).toBe('none')
  })

  it('day bucket is the mid-point of the report window', () => {
    const parsed = parseDmarcReport(fixture('yahoo-mixed.xml'))
    expect(parsed.failures[0]?.day).toMatch(/^2024-\d{2}-\d{2}$/)
  })
})

describe('parseDmarcReport — error handling', () => {
  it('throws when <feedback> root is missing', () => {
    expect(() => parseDmarcReport('<not-a-report />')).toThrow(/feedback/)
  })

  it('throws when report_id is missing', () => {
    const xml = `<feedback><report_metadata><org_name>x</org_name><email>x@x</email><date_range><begin>1</begin><end>2</end></date_range></report_metadata><policy_published><domain>example.com</domain></policy_published></feedback>`
    expect(() => parseDmarcReport(xml)).toThrow(/report_id/)
  })

  it('throws when policy_published.domain is missing', () => {
    const xml = `<feedback><report_metadata><report_id>id</report_id><org_name>x</org_name><email>x@x</email><date_range><begin>1</begin><end>2</end></date_range></report_metadata><policy_published><p>none</p></policy_published></feedback>`
    expect(() => parseDmarcReport(xml)).toThrow(/domain/)
  })
})

describe('extractDmarcXml', () => {
  it('returns raw text for .xml input', async () => {
    const xml = fixture('google-clean.xml')
    const out = await extractDmarcXml(Buffer.from(xml), 'report.xml')
    expect(out).toContain('<feedback>')
  })

  it('decompresses gzip', async () => {
    const xml = fixture('google-clean.xml')
    const gz = zlib.gzipSync(Buffer.from(xml))
    const out = await extractDmarcXml(gz, 'report.xml.gz')
    expect(out).toContain('10000000000001')
  })

  it('extracts a single-file zip', async () => {
    const xml = fixture('google-clean.xml')
    const zip = new AdmZip()
    zip.addFile('google!example.com!1718064000!1718150400.xml', Buffer.from(xml))
    const out = await extractDmarcXml(zip.toBuffer(), 'report.zip')
    expect(out).toContain('10000000000001')
  })

  it('concatenates multi-file zips', async () => {
    const xml1 = fixture('google-clean.xml')
    const xml2 = fixture('yahoo-mixed.xml')
    const zip = new AdmZip()
    zip.addFile('a.xml', Buffer.from(xml1))
    zip.addFile('b.xml', Buffer.from(xml2))
    const out = await extractDmarcXml(zip.toBuffer(), 'reports.zip')
    expect(out).toContain('10000000000001')
    expect(out).toContain('20240101.example.com.000456')
  })
})
