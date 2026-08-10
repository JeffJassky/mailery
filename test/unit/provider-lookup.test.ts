/**
 * Unit tests for the shared guarded provider lookup.
 *
 * `Mailer.providers` is a plain object literal, so `providers[name]` resolves
 * inherited `Object.prototype` members as well as registered providers. Every
 * call site (public webhook route, two admin routes, the send runner) goes
 * through `resolveProvider` instead; these pin the helper's contract so the
 * per-site tests only have to assert the per-site failure mode.
 */

import { describe, expect, it } from 'vitest'

import { registeredProviderNames, resolveProvider } from '../../src/server/provider-lookup.js'
import { NullProvider } from '../../src/server/providers/null.js'
import type { MailProvider } from '../../src/shared/types.js'

function makeMap(extra: Record<string, unknown> = {}): Record<string, MailProvider> {
  return { null: new NullProvider(), ...extra } as Record<string, MailProvider>
}

describe('resolveProvider', () => {
  it('resolves a registered provider', () => {
    const providers = makeMap()
    expect(resolveProvider(providers, 'null')).toBe(providers.null)
  })

  it('returns null for a name that was never registered', () => {
    expect(resolveProvider(makeMap(), 'postmark')).toBeNull()
  })

  it.each([
    'constructor',
    '__proto__',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ])('returns null for the inherited prototype key %s', (name) => {
    // Sanity: the raw lookup these call sites used to do really is truthy here,
    // so the guard is load-bearing rather than decorative.
    const providers = makeMap()
    expect((providers as any)[name]).toBeTruthy()
    expect(resolveProvider(providers, name)).toBeNull()
  })

  const noop = (): void => {}
  const yes = async (): Promise<boolean> => true
  const none = (): never[] => []

  it.each<[string, unknown]>([
    ['a bare name-only object', { name: 'broken' }],
    ['a provider missing send', { name: 'x', verifyWebhook: yes, parseWebhookEvents: none }],
    ['a provider missing verifyWebhook', { name: 'x', send: noop, parseWebhookEvents: none }],
    ['a provider missing parseWebhookEvents', { name: 'x', send: noop, verifyWebhook: yes }],
    ['a string', 'sendgrid'],
    ['a number', 7],
    ['null', null],
    ['a function', noop],
    ['an empty object', {}],
  ])('returns null for an own key holding %s', (_label, value) => {
    const providers = makeMap({ suspect: value })
    expect(Object.hasOwn(providers, 'suspect')).toBe(true)
    expect(resolveProvider(providers, 'suspect')).toBeNull()
  })

  it.each([[undefined], [null], [42], [{}], [Symbol('x')]])(
    'returns null for a non-string name (%s)',
    (name) => {
      expect(resolveProvider(makeMap(), name)).toBeNull()
    },
  )

  it('does not resolve a key that only exists on a custom prototype', () => {
    const base = { inherited: new NullProvider() }
    const providers = Object.create(base) as Record<string, MailProvider>
    providers.null = new NullProvider()
    expect((providers as any).inherited).toBeTruthy()
    expect(resolveProvider(providers, 'inherited')).toBeNull()
    expect(resolveProvider(providers, 'null')).not.toBeNull()
  })
})

describe('registeredProviderNames', () => {
  it('lists only own keys that resolve, sorted', () => {
    const providers = makeMap({ alpha: new NullProvider(), broken: { name: 'broken' } })
    expect(registeredProviderNames(providers)).toEqual(['alpha', 'null'])
  })

  it('is empty for an empty map', () => {
    expect(registeredProviderNames({})).toEqual([])
  })
})
