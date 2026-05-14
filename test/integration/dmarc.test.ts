/**
 * End-to-end DMARC ingest:
 *  - ingestDmarcAttachment decompresses, parses, and writes both
 *    mailer_dmarc_reports and mailer_dmarc_failures
 *  - re-uploading the same report is idempotent
 *  - pruneDmarcFailures honors retentionDays
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

import { createTestMailer, type TestMailerHarness } from '../../src/testing/index.js'
import { ingestDmarcAttachment, pruneDmarcFailures } from '../../src/server/runner/dmarc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, '..', 'fixtures', 'dmarc', name), 'utf8')
}

let H: TestMailerHarness

beforeAll(async () => {
  H = await createTestMailer({
    config: { dmarc: { retentionDays: 90 } },
  })
}, 60_000)

afterAll(async () => {
  if (H) await H.stop()
})

async function reset() {
  await H.mailer.collections.dmarcReports.deleteMany({})
  await H.mailer.collections.dmarcFailures.deleteMany({})
}

describe('ingestDmarcAttachment', () => {
  it('ingests a .gz attachment, writes report + failures', async () => {
    await reset()
    const xml = fixture('yahoo-mixed.xml')
    const buf = zlib.gzipSync(Buffer.from(xml))
    const r = await ingestDmarcAttachment(H.mailer.getRunnerContext(), buf, 'yahoo!example.com!1718.xml.gz')
    expect(r.duplicate).toBe(false)
    expect(r.totalMessages).toBe(218)
    expect(r.passCount).toBe(200)
    expect(r.failCount).toBe(18)

    const reports = await H.mailer.collections.dmarcReports.find({}).toArray()
    expect(reports).toHaveLength(1)
    expect(reports[0]!.orgName).toBe('Yahoo')
    expect(reports[0]!.domain).toBe('example.com')

    const failures = await H.mailer.collections.dmarcFailures.find({}).toArray()
    expect(failures).toHaveLength(2)
    expect(failures.find((f) => f.sourceIp === '198.51.100.7')?.count).toBe(15)
  })

  it('ingests a .zip attachment', async () => {
    await reset()
    const xml = fixture('google-clean.xml')
    const zip = new AdmZip()
    zip.addFile('google!example.com!1718.xml', Buffer.from(xml))
    const r = await ingestDmarcAttachment(H.mailer.getRunnerContext(), zip.toBuffer(), 'google.zip')
    expect(r.duplicate).toBe(false)
    expect(r.failCount).toBe(0)

    const reports = await H.mailer.collections.dmarcReports.find({}).toArray()
    expect(reports).toHaveLength(1)
  })

  it('is idempotent — second upload of same report is flagged duplicate', async () => {
    await reset()
    const xml = fixture('yahoo-mixed.xml')
    const buf = Buffer.from(xml)
    await ingestDmarcAttachment(H.mailer.getRunnerContext(), buf, 'r.xml')
    const second = await ingestDmarcAttachment(H.mailer.getRunnerContext(), buf, 'r.xml')
    expect(second.duplicate).toBe(true)

    const reports = await H.mailer.collections.dmarcReports.find({}).toArray()
    expect(reports).toHaveLength(1)
    const failures = await H.mailer.collections.dmarcFailures.find({}).toArray()
    expect(failures).toHaveLength(2)
  })

  it('ingests each XML in a multi-file zip independently', async () => {
    await reset()
    const xml1 = fixture('google-clean.xml')
    const xml2 = fixture('yahoo-mixed.xml')
    const zip = new AdmZip()
    zip.addFile('a.xml', Buffer.from(xml1))
    zip.addFile('b.xml', Buffer.from(xml2))
    const r = await ingestDmarcAttachment(H.mailer.getRunnerContext(), zip.toBuffer(), 'multi.zip')
    expect(r.duplicate).toBe(false)
    expect(r.additionalReports).toBe(1)
    const reports = await H.mailer.collections.dmarcReports.find({}).toArray()
    expect(reports).toHaveLength(2)
  })

  it('rejects invalid XML', async () => {
    await reset()
    await expect(
      ingestDmarcAttachment(H.mailer.getRunnerContext(), Buffer.from('<not-a-report />'), 'r.xml'),
    ).rejects.toThrow(/feedback/)
  })
})

describe('pruneDmarcFailures', () => {
  it('deletes failures older than retentionDays', async () => {
    await reset()
    const xml = fixture('yahoo-mixed.xml')
    await ingestDmarcAttachment(H.mailer.getRunnerContext(), Buffer.from(xml), 'r.xml')

    // Backdate one of the failures.
    const ancient = new Date(Date.now() - 200 * 86_400_000)
    await H.mailer.collections.dmarcFailures.updateOne(
      { sourceIp: '198.51.100.7' },
      { $set: { receivedAt: ancient } },
    )

    const deleted = await pruneDmarcFailures(H.mailer.getRunnerContext())
    expect(deleted).toBe(1)
    const remaining = await H.mailer.collections.dmarcFailures.find({}).toArray()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.sourceIp).toBe('203.0.113.50')
  })
})
