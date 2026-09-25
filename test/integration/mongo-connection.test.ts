/**
 * `MailerConfig.mongo`: mailery opens and owns its own MongoDB connection.
 *
 * A host whose code is on another `mongodb` major (every Mongoose 8 app
 * bundles driver 6) cannot hand mailery a `Db` from its own client, so it
 * passes a URI instead, and builds its contact adapter on mailery's database
 * through an adapter factory. `db` keeps working exactly as before, and
 * mailery never closes a client it did not open.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Db } from 'mongodb'
import type { MongoMemoryServer } from 'mongodb-memory-server'

import { Mailer } from '../../src/server/mailer.js'
import { MongoContactAdapter } from '../../src/server/adapters/mongo.js'
import { NullProvider } from '../../src/server/providers/null.js'
import type { MailerConfig } from '../../src/server/config.js'

const BASE = {
  queue: { driver: 'noop' as const },
  providers: { null: new NullProvider() },
  defaultProvider: 'null',
  publicUrl: 'http://localhost:3000',
  unsubscribeSecret: 'test-unsub-secret-32-bytes-or-more-please',
  senderAddress: '1 Test St, Brooklyn NY 11201',
  fromDefaults: { name: 'Test', email: 'test@example.com' },
  workerless: true,
} satisfies Partial<MailerConfig>

let server: MongoMemoryServer

beforeAll(async () => {
  const { MongoMemoryServer } = await import('mongodb-memory-server')
  server = await MongoMemoryServer.create()
}, 60_000)

afterAll(async () => {
  await server?.stop()
})

function usersAdapter(db: Db): MongoContactAdapter {
  return new MongoContactAdapter({ db, collection: 'users', emailField: 'email', idField: '_id' })
}

describe('MailerConfig.mongo', () => {
  it('connects to the named database and builds the adapter on it', async () => {
    const mailer = await Mailer.init({
      ...BASE,
      mongo: { uri: server.getUri(), dbName: 'mailery-owned' },
      adapter: usersAdapter,
    })
    try {
      expect(mailer.db.databaseName).toBe('mailery-owned')
      const host = await MongoClient.connect(server.getUri())
      try {
        const { insertedId } = await host
          .db('mailery-owned')
          .collection('users')
          .insertOne({ email: 'alice@example.com' })
        const contact = await mailer.adapter.getById(insertedId.toHexString())
        expect(contact?.email).toBe('alice@example.com')
      } finally {
        await host.close()
      }
    } finally {
      await mailer.stop()
    }
  })

  it('closes the connection it opened on stop()', async () => {
    const mailer = await Mailer.init({
      ...BASE,
      mongo: { uri: server.getUri(), dbName: 'mailery-closed' },
      adapter: usersAdapter,
    })
    await mailer.db.command({ ping: 1 })
    await mailer.stop()
    await expect(mailer.db.command({ ping: 1 })).rejects.toThrow()
  })

  it('leaves a host-provided db open on stop()', async () => {
    const host = await MongoClient.connect(server.getUri())
    try {
      const db = host.db('mailery-host')
      const mailer = await Mailer.init({ ...BASE, db, adapter: usersAdapter(db) })
      await mailer.stop()
      await expect(db.command({ ping: 1 })).resolves.toMatchObject({ ok: 1 })
    } finally {
      await host.close()
    }
  })

  it('refuses both db and mongo, and neither', async () => {
    const host = await MongoClient.connect(server.getUri())
    try {
      const db = host.db('mailery-both')
      await expect(
        Mailer.init({ ...BASE, db, mongo: { uri: server.getUri() }, adapter: usersAdapter }),
      ).rejects.toThrow(/exactly one of `db`/)
      await expect(Mailer.init({ ...BASE, adapter: usersAdapter })).rejects.toThrow(/exactly one of `db`/)
    } finally {
      await host.close()
    }
  })

  it('closes the connection when the adapter factory throws', async () => {
    const opened: Db[] = []
    await expect(
      Mailer.init({
        ...BASE,
        mongo: { uri: server.getUri(), dbName: 'mailery-factory-throws' },
        adapter: (db) => {
          opened.push(db)
          throw new Error('adapter factory failed')
        },
      }),
    ).rejects.toThrow('adapter factory failed')
    expect(opened).toHaveLength(1)
    await expect(opened[0]?.command({ ping: 1 })).rejects.toThrow()
  })
})
