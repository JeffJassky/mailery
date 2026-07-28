/**
 * Smoke test for the Agenda queue driver. Boots a driver against
 * mongodb-memory-server, enqueues two job types (send + advance), and verifies
 * the worker invokes the handler and that jobId-based dedupe drops duplicates.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'

import { AgendaDriver, collectionFor } from '../../src/server/queues/agenda.js'

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
      advance: async (data) => { if (data.flowRunId) firedAdvances.push(data.flowRunId) },
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

describe('AgendaDriver retention', () => {
  it('removes succeeded one-shot jobs instead of retaining them', async () => {
    const sendId = new ObjectId().toHexString()
    await driver.queues.send.add('send', { sendId })
    await waitFor(() => seenSends.includes(sendId), 8000)

    const jobs = db.collection('_mailerJobs')
    await waitFor(async () => (await jobs.countDocuments({ 'data.sendId': sendId })) === 0, 8000)
    expect(await jobs.countDocuments({ 'data.sendId': sendId })).toBe(0)
  }, 30_000)

  it('keeps the repeating tick document', async () => {
    await driver.scheduleRepeatingTick(60)
    const jobs = db.collection('_mailerJobs')
    expect(await jobs.countDocuments({ name: 'mailer-tick' })).toBe(1)

    // A sweep with a wide-open window must not delete it.
    await driver.sweepFailedJobs()
    expect(await jobs.countDocuments({ name: 'mailer-tick' })).toBe(1)
  }, 30_000)

  it('sweepFailedJobs deletes retired failures past the window but spares fresh and retrying ones', async () => {
    const jobs = db.collection('_mailerJobs')
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    await jobs.insertMany([
      { name: 'mailer-send', failedAt: old, lastFinishedAt: old, nextRunAt: null, data: { tag: 'stale' } },
      { name: 'mailer-send', failedAt: new Date(), nextRunAt: null, data: { tag: 'fresh' } },
      // Failed long ago but still scheduled for a retry — must survive.
      {
        name: 'mailer-send',
        failedAt: old,
        nextRunAt: new Date(Date.now() + 60_000),
        data: { tag: 'retrying' },
      },
    ])

    const deleted = await driver.sweepFailedJobs()
    expect(deleted).toBe(1)
    expect(await jobs.countDocuments({ 'data.tag': 'stale' })).toBe(0)
    expect(await jobs.countDocuments({ 'data.tag': 'fresh' })).toBe(1)
    expect(await jobs.countDocuments({ 'data.tag': 'retrying' })).toBe(1)
  }, 30_000)
})

describe('collectionFor', () => {
  it('keeps the historical default when no prefix is set', () => {
    expect(collectionFor()).toBe('_mailerJobs')
    expect(collectionFor('')).toBe('_mailerJobs')
  })

  it('suffixes the collection with the prefix', () => {
    expect(collectionFor('prod')).toBe('_mailerJobs_prod')
  })

  it('rejects prefixes that are illegal or confusing in a collection name', () => {
    expect(() => collectionFor('has.dot')).toThrow(/letters, digits/)
    expect(() => collectionFor('has space')).toThrow(/letters, digits/)
    expect(() => collectionFor('has$dollar')).toThrow(/letters, digits/)
  })
})

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
