import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  assertNoReservedVarKeys,
  defineVars,
  resolveVars,
  varsJsonSchema,
} from '../../src/server/adapters/vars.js'
import type { Contact } from '../../src/shared/types.js'

const contact: Contact = {
  externalId: 'u1',
  email: 'alice@example.com',
  tags: [],
  fields: {},
}

const adapter = defineVars({
  schema: z.object({
    user: z.object({ name: z.string() }),
    firstActiveTopic: z.object({ title: z.string() }).nullable(),
  }),
  async resolve(c) {
    return {
      user: { name: c.externalId === 'u1' ? 'Alice' : 'Unknown' },
      firstActiveTopic: null,
    }
  },
})

describe('varsJsonSchema', () => {
  it('emits JSON Schema with the declared root keys', () => {
    const json = varsJsonSchema(adapter) as any
    expect(json.type).toBe('object')
    expect(Object.keys(json.properties)).toEqual(['user', 'firstActiveTopic'])
    expect(json.properties.user.properties.name.type).toBe('string')
  })
})

describe('resolveVars', () => {
  it('returns {} when no adapter is configured', async () => {
    expect(await resolveVars(undefined, contact, { reason: 'send' })).toEqual({})
  })

  it('resolves values for the contact', async () => {
    const out = await resolveVars(adapter, contact, { reason: 'send', templateSlug: 't1' })
    expect(out).toEqual({ user: { name: 'Alice' }, firstActiveTopic: null })
  })

  it('strips reserved keys from the resolved object', async () => {
    const lying = {
      schema: z.object({}),
      resolve: async () => ({ contact: 'evil', unsubscribeUrl: 'evil', user: { name: 'ok' } }),
    }
    const out = await resolveVars(lying as any, contact, { reason: 'send' })
    expect(out).toEqual({ user: { name: 'ok' } })
  })

  it('propagates resolver errors to the caller', async () => {
    const failing = defineVars({
      schema: z.object({}),
      resolve: async () => {
        throw new Error('host db down')
      },
    })
    await expect(resolveVars(failing, contact, { reason: 'send' })).rejects.toThrow('host db down')
  })
})

describe('assertNoReservedVarKeys', () => {
  it('accepts non-colliding schemas', () => {
    expect(() => assertNoReservedVarKeys(adapter)).not.toThrow()
  })

  it('rejects schemas declaring reserved keys', () => {
    const bad = defineVars({
      schema: z.object({ contact: z.string(), user: z.string() }),
      resolve: async () => ({ contact: 'x', user: 'y' }),
    })
    expect(() => assertNoReservedVarKeys(bad)).toThrow(/reserved key.*contact/)
  })
})
