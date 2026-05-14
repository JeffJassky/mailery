/**
 * extractDmarcXml hardening:
 *   - zip-slip path traversal rejected via assertSafeZipEntryName
 *   - decompression-bomb caps enforced for gzip + raw
 */
import { describe, expect, it } from 'vitest'
import zlib from 'node:zlib'

import { assertSafeZipEntryName, extractDmarcXml } from '../../src/server/runner/dmarc.js'

describe('assertSafeZipEntryName', () => {
  it('accepts a normal nested name', () => {
    expect(() => assertSafeZipEntryName('reports/2026/05/file.xml')).not.toThrow()
  })

  it('rejects a leading `..` traversal', () => {
    expect(() => assertSafeZipEntryName('../etc/passwd')).toThrow(/unsafe path/)
  })

  it('rejects a nested `..` traversal', () => {
    expect(() => assertSafeZipEntryName('reports/../../../etc/passwd')).toThrow(/unsafe path/)
  })

  it('rejects a POSIX absolute path', () => {
    expect(() => assertSafeZipEntryName('/etc/passwd')).toThrow(/unsafe path/)
  })

  it('rejects a Windows-drive absolute path', () => {
    expect(() => assertSafeZipEntryName('C:\\Users\\a.xml')).toThrow(/unsafe path/)
  })

  it('rejects a name containing a null byte', () => {
    expect(() => assertSafeZipEntryName('safe\0.xml')).toThrow(/unsafe path/)
  })

  it('rejects an empty / non-string name', () => {
    expect(() => assertSafeZipEntryName('')).toThrow(/unsafe path/)
    expect(() => assertSafeZipEntryName(null as any)).toThrow(/unsafe path/)
  })
})

describe('extractDmarcXml — decompression bomb caps', () => {
  it('rejects a gzip stream that inflates past the cap', async () => {
    const huge = Buffer.alloc(60 * 1024 * 1024, 0)
    const gz = zlib.gzipSync(huge)
    await expect(extractDmarcXml(gz, 'bomb.gz')).rejects.toThrow(/decompression bomb/)
  }, 30_000)

  it('rejects a raw payload exceeding the cap', async () => {
    const huge = Buffer.alloc(60 * 1024 * 1024, 0)
    await expect(extractDmarcXml(huge, 'big.xml')).rejects.toThrow(/exceeds/)
  })
})
