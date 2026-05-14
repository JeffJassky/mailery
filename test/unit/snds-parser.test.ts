import { describe, expect, it } from 'vitest'

import {
  parseSndsCsv,
  parseComplaintRate,
  parseSndsDate,
} from '../../src/server/runner/snds.js'

describe('parseSndsCsv', () => {
  it('parses a single typical row', () => {
    const csv = '203.0.113.5,9/26/2024 12:00 AM,9/26/2024 11:59 PM,1500,1200,1180,GREEN,<0.1%,0,sender.example.com,bounce@example.com'
    const rows = parseSndsCsv(csv)
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.ip).toBe('203.0.113.5')
    expect(r.rcptCommands).toBe(1500)
    expect(r.dataCommands).toBe(1200)
    expect(r.messageRecipients).toBe(1180)
    expect(r.filterResult).toBe('GREEN')
    expect(r.complaintRate).toBeCloseTo(0.001)
    expect(r.trapMessageCount).toBe(0)
    expect(r.sampleHelo).toBe('sender.example.com')
    expect(r.sampleMailFrom).toBe('bounce@example.com')
    expect(r.activityStart).toBeInstanceOf(Date)
  })

  it('parses RED + YELLOW filter results', () => {
    const csv = [
      '1.1.1.1,9/26/2024 12:00 AM,9/26/2024 11:59 PM,10,10,10,RED,>4%,3,a,a@a.com',
      '2.2.2.2,9/26/2024 12:00 AM,9/26/2024 11:59 PM,10,10,10,YELLOW,1-2%,0,b,b@b.com',
    ].join('\n')
    const rows = parseSndsCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.filterResult).toBe('RED')
    expect(rows[0]!.complaintRate).toBeCloseTo(0.04)
    expect(rows[1]!.filterResult).toBe('YELLOW')
    expect(rows[1]!.complaintRate).toBeCloseTo(0.02)
  })

  it('tolerates quoted fields with embedded commas', () => {
    const csv = '1.1.1.1,9/26/2024 12:00 AM,9/26/2024 11:59 PM,10,10,10,GREEN,<0.1%,0,"helo, with comma","mail@x.com"'
    const rows = parseSndsCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sampleHelo).toBe('helo, with comma')
  })

  it('skips empty rows and malformed rows', () => {
    const csv = '\n\n1.1.1.1,9/26/2024 12:00 AM,9/26/2024 11:59 PM,10,10,10,GREEN\n,,,,\nnot,enough,fields\n'
    const rows = parseSndsCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ip).toBe('1.1.1.1')
  })

  it('unknown filter result maps to UNKNOWN', () => {
    const csv = '1.1.1.1,9/26/2024 12:00 AM,9/26/2024 11:59 PM,10,10,10,?,<0.1%,0,a,a@a.com'
    const rows = parseSndsCsv(csv)
    expect(rows[0]!.filterResult).toBe('UNKNOWN')
  })
})

describe('parseComplaintRate', () => {
  it('parses < ranges', () => {
    expect(parseComplaintRate('<0.1%')).toBeCloseTo(0.001)
  })
  it('parses range ranges as upper bound', () => {
    expect(parseComplaintRate('0.5-1%')).toBeCloseTo(0.01)
  })
  it('parses > ranges as the floor', () => {
    expect(parseComplaintRate('>4%')).toBeCloseTo(0.04)
  })
  it('parses plain numbers', () => {
    expect(parseComplaintRate('2.5%')).toBeCloseTo(0.025)
  })
  it('returns null for blank / n/a', () => {
    expect(parseComplaintRate('')).toBeNull()
    expect(parseComplaintRate('-')).toBeNull()
    expect(parseComplaintRate('N/A')).toBeNull()
  })
})

describe('parseSndsDate', () => {
  it('parses the standard SNDS format', () => {
    const d = parseSndsDate('9/26/2024 12:00 AM')
    expect(d).toBeInstanceOf(Date)
    expect(d!.getFullYear()).toBe(2024)
  })
  it('returns null on empty input', () => {
    expect(parseSndsDate('')).toBeNull()
  })
})
