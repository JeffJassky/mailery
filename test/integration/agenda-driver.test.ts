/**
 * Smoke test for the Agenda queue driver. Boots a driver against
 * mongodb-memory-server, enqueues two job types (send + advance), and verifies
 * the worker invokes the handler and that jobId-based dedupe drops duplicates.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'

import { AgendaDriver } from '../../src/server/queues/agenda.js'

let mongo: MongoMemoryServer
let client: MongoClient
let db: Db
let driver: AgendaDriver

const seenSends: string[] = []
const firedAdvances: string[] = []

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  client = new MongoClient(mongo.getUri())
  await client.connect()
  db = client.db('mailery-agenda-test')

  driver = await AgendaDriver.create({ db, processEverySeconds: 1 })
  await driver.startWorkers({
    concurrency: { send: 2 },
    retryAttempts: 1,
    handlers: {
      tick: async () => {},
      advance: async (data) => { firedAdvances.push(data.flowRunId) },
      send: async (data) => { seenSends.push(data.sendId) },
      webhook: async () => {},
    },
  })
}, 60_000)

afterAll(async () => {
  await driver?.close().catch(() => {})
  await client?.close().catch(() => {})
  await mongo?.stop().catch(() => {})
}, 60_000)

describe('AgendaDriver smoke', () => {
  it('add() schedules a job and the worker invokes the handler', async () => {
    const sendId = new ObjectId().toHexString()
    await driver.queues.send.add('send', { sendId })

    await waitFor(() => seenSends.includes(sendId), 8000)
    expect(seenSends).toContain(sendId)
  }, 30_000)

  it('dedupes by jobId — second add() with same jobId is a no-op', async () => {
    const runId = new ObjectId().toHexString()
    const before = firedAdvances.length
    await driver.queues.advance.add('advance', { flowRunId: runId }, { delay: 200, jobId: `advance:${runId}:0` })
    await driver.queues.advance.add('advance', { flowRunId: runId }, { delay: 200, jobId: `advance:${runId}:0` })

    await waitFor(() => firedAdvances.includes(runId), 8000)
    // Wait another full poll cycle to confirm no duplicate.
    await sleep(2500)
    const count = firedAdvances.slice(before).filter((id) => id === runId).length
    expect(count).toBe(1)
  }, 30_000)
})

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return
    await sleep(100)
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
