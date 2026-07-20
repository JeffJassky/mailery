import { describe, it, expect } from 'vitest'
import { VERSION } from '../../src/server/index.js'
import pkg from '../../package.json'

describe('package smoke', () => {
  it('exports VERSION matching package.json', () => {
    expect(VERSION).toBe(pkg.version)
  })
})
