/**
 * `Mailer.init` validates both provider defaults before touching the database.
 *
 * `defaultProvider` was always checked. `defaultTransactionalProvider` was not,
 * so a typo there stayed silent until a transactional send failed at dispatch
 * time — and before the runner stopped falling back, it did not fail at all: the
 * send went out through the marketing provider, from the wrong sending
 * reputation, with nothing recorded to say so.
 *
 * These run without a mongod because the checks sit above every db call in
 * `init`; the `db` here only has to be non-null.
 */
import { describe, expect, it } from 'vitest'

import { Mailer } from '../../src/server/mailer.js'
import { NullProvider } from '../../src/server/providers/null.js'

const BASE = {
  db: {} as never,
  adapter: { getContact: async () => null } as never,
  queue: { driver: 'noop' as const },
  publicUrl: 'http://localhost:3000',
  unsubscribeSecret: 'unit-test-secret-thirty-two-chars-please-ok',
  senderAddress: '12 Main St, Brooklyn NY 11201, USA',
  fromDefaults: { name: 'Unit', email: 'unit@example.com' },
  workerless: true,
}

describe('Mailer.init — provider default validation', () => {
  it('rejects an unregistered defaultTransactionalProvider', async () => {
    await expect(
      Mailer.init({
        ...BASE,
        providers: { null: new NullProvider() },
        defaultProvider: 'null',
        defaultTransactionalProvider: 'sendgird', // typo
      } as never),
    ).rejects.toThrow(/defaultTransactionalProvider "sendgird" is not a registered provider/)
  })

  it('names the registered providers so the typo is fixable', async () => {
    await expect(
      Mailer.init({
        ...BASE,
        providers: { null: new NullProvider() },
        defaultProvider: 'null',
        defaultTransactionalProvider: 'nope',
      } as never),
    ).rejects.toThrow(/Registered: null/)
  })

  it('rejects a prototype key as defaultTransactionalProvider', async () => {
    // `providers['constructor']` is truthy, so an unguarded lookup accepts it.
    await expect(
      Mailer.init({
        ...BASE,
        providers: { null: new NullProvider() },
        defaultProvider: 'null',
        defaultTransactionalProvider: 'constructor',
      } as never),
    ).rejects.toThrow(/defaultTransactionalProvider "constructor" is not a registered provider/)
  })

  it('rejects a prototype key as defaultProvider', async () => {
    await expect(
      Mailer.init({
        ...BASE,
        providers: { null: new NullProvider() },
        defaultProvider: 'toString',
      } as never),
    ).rejects.toThrow(/defaultProvider "toString" is not a registered provider/)
  })

  it('accepts an omitted defaultTransactionalProvider', async () => {
    // Optional: omitting it is not a misconfiguration, and must not be treated
    // as one. This gets past validation and fails later on the stub db, so the
    // assertion is only that it is not the validation error.
    await expect(
      Mailer.init({
        ...BASE,
        providers: { null: new NullProvider() },
        defaultProvider: 'null',
      } as never),
    ).rejects.not.toThrow(/is not a registered provider/)
  })
})
