import { describe, it, expect } from 'vitest'
import { VERSION } from '../../src/server/index.js'

describe('package smoke', () => {
  it('exports VERSION', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
