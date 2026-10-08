import { describe, expect, it } from 'vitest'
import { placeTip } from '../../../src/client/lib/place-tip'

describe('placeTip', () => {
  const size = { w: 100, h: 24 }
  it('goes above, centered', () => {
    expect(placeTip({ left: 200, right: 220, top: 100, bottom: 120 }, size, { w: 1000 })).toEqual({ left: 160, top: 70, place: 'above' })
  })
  it('flips below near the top edge', () => {
    expect(placeTip({ left: 200, right: 220, top: 20, bottom: 40 }, size, { w: 1000 })).toEqual({ left: 160, top: 46, place: 'below' })
  })
  it('stays inside the viewport horizontally', () => {
    expect(placeTip({ left: 0, right: 10, top: 100, bottom: 110 }, size, { w: 1000 }).left).toBe(8)
    expect(placeTip({ left: 990, right: 1000, top: 100, bottom: 110 }, size, { w: 1000 }).left).toBe(892)
  })
})
