/** buildProgramRenderVars — the pure core of programRenderVars (board §7). */

import { describe, expect, it } from 'vitest'

import { buildProgramRenderVars } from '../../src/server/runner/programs/hooks.js'
import { activation } from '../programs/helpers.js'

describe('buildProgramRenderVars', () => {
  const def = activation()

  it('a known action', () => {
    expect(buildProgramRenderVars(def, { slug: 'activation', actionId: 'connect-shopify', attempt: 2 }, { business_type: 'ecommerce' }, 3)).toEqual({
      program: { slug: 'activation' },
      action: {
        id: 'connect-shopify',
        title: 'Connect Shopify',
        cta: { label: 'Connect', url: 'https://app.example.com/connect/shopify' },
      },
      attempt: { n: 2, total: 3, isLast: false, daysSinceFirst: 3 },
      facts: { business_type: 'ecommerce' },
    })
  })

  it('the last attempt; no cta key when the action has none', () => {
    const v = buildProgramRenderVars(def, { slug: 'activation', actionId: 'connect-ga4', attempt: 2 }, {}, 0)
    expect(v.attempt).toEqual({ n: 2, total: 2, isLast: true, daysSinceFirst: 0 })
    expect(v.action).toEqual({ id: 'connect-ga4', title: 'Connect GA4' })
  })

  it('the sunset ask', () => {
    const v = buildProgramRenderVars(def, { slug: 'activation', actionId: '$sunset-ask', attempt: 1 }, {}, 0)
    expect(v.action).toEqual({ id: '$sunset-ask', title: 'Still want these emails?' })
    expect(v.attempt).toEqual({ n: 1, total: 1, isLast: true, daysSinceFirst: 0 })
  })

  it('an unknown action (or no definition) falls back to the id and total = attempt', () => {
    for (const d of [def, null]) {
      const v = buildProgramRenderVars(d, { slug: 'activation', actionId: 'gone', attempt: 2 }, {}, 1)
      expect(v.action).toEqual({ id: 'gone', title: 'gone' })
      expect(v.attempt).toEqual({ n: 2, total: 2, isLast: true, daysSinceFirst: 1 })
    }
  })
})
