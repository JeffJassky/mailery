/**
 * `mailery doctor` and `mailery backfill-categories` against a real (in-memory)
 * Mongo. Both take a Db, so the CLI wrappers stay trivial.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, type Db } from 'mongodb'

import { runDoctor, formatDoctor, type DoctorReport } from '../../src/cli/doctor.js'
import { backfillCategories, parseCategoryMap } from '../../src/cli/backfill-categories.js'
import { ensureIndexes, getCollections } from '../../src/server/models/index.js'
import { buildProgramDoc, buildProgram } from '../../src/testing/index.js'

let mongo: MongoMemoryServer
let client: MongoClient
let db: Db
let n = 0
const NOW = new Date('2027-03-01T12:00:00Z')

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  client = await MongoClient.connect(mongo.getUri())
}, 60_000)
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
beforeEach(async () => {
  db = client.db(`doctor-${++n}`)
})

const tpl = (slug: string, kind: 'marketing' | 'transactional', category?: string) => ({
  slug, name: slug, kind, category: category ?? null, createdAt: NOW, updatedAt: NOW, publishedAt: NOW,
}) as any
const ONE = { id: 'a', title: 'A', priority: 1, attempts: 1, satisfied: { fact: 'x' } } as const
const check = (r: DoctorReport, id: string) => r.checks.find((k) => k.id === id)!

describe('doctor', () => {
  it('a fresh database passes; missing 0.21 indexes only warn when no Program exists', async () => {
    const r = await runDoctor(db, { version: '0.21.0', now: NOW })
    expect(r.ok).toBe(true)
    expect(check(r, 'version').title).toContain('0.21.0')
    expect(check(r, 'indexes').status).toBe('warn')
    expect(check(r, 'programs').title).toBe('No Programs configured')
  })

  it('reports marketing templates without a category, and used vs declared categories', async () => {
    const c = getCollections(db)
    await c.templates.insertMany([tpl('a', 'marketing'), tpl('b', 'marketing', 'news'), tpl('c', 'transactional'), tpl('d', 'marketing', 'old')])
    const r = await runDoctor(db, { version: 'x', now: NOW, categories: ['news', 'tips'] })
    expect(check(r, 'templates-uncategorised')).toMatchObject({ status: 'warn', detail: ['a'] })
    expect(check(r, 'categories-undeclared')).toMatchObject({ status: 'warn', detail: ['old'] })
    expect(check(r, 'categories-unused').detail).toEqual(['tips'])
    expect(r.ok).toBe(true)

    const noDecl = await runDoctor(db, { version: 'x', now: NOW })
    expect(check(noDecl, 'categories-used').detail).toEqual(['news', 'old'])
  })

  it('--categories with no value is treated as not provided and says so', async () => {
    const c = getCollections(db)
    await c.templates.insertMany([tpl('b', 'marketing', 'news')])
    const r = await runDoctor(db, { version: 'x', now: NOW, categories: [] })
    expect(check(r, 'categories-flag-empty').status).toBe('warn')
    expect(r.checks.find((k) => k.id === 'categories-undeclared')).toBeUndefined()
    expect(check(r, 'categories-used').detail).toEqual(['news'])
    expect(r.ok).toBe(true)
  })

  it('categories-undeclared is ok when every used category is declared', async () => {
    const c = getCollections(db)
    await c.templates.insertMany([tpl('b', 'marketing', 'news')])
    const r = await runDoctor(db, { version: 'x', now: NOW, categories: ['news'] })
    expect(check(r, 'categories-undeclared').status).toBe('ok')
    expect(r.checks.find((k) => k.id === 'categories-flag-empty')).toBeUndefined()
  })

  it('honours a collection prefix', async () => {
    const c = getCollections(db, 'x_')
    await c.templates.insertMany([tpl('a', 'marketing')])
    const r = await runDoctor(db, { version: 'x', now: NOW, prefix: 'x_' })
    expect(check(r, 'templates-uncategorised')).toMatchObject({ status: 'warn', detail: ['a'] })
  })

  it('flags suppression rows with an unknown scope', async () => {
    const c = getCollections(db)
    const base = { emailHash: 'h', reason: 'user_request', source: 't', notes: null, addedAt: NOW, expiresAt: null } as any
    await c.suppressions.insertMany([
      { ...base, email: 'a@x.com', scope: 'marketing' },
      { ...base, email: 'b@x.com', scope: 'category:lifecycle.onboarding' },
      { ...base, email: 'c@x.com', scope: 'category:Bad Id' },
      { ...base, email: 'd@x.com', scope: 'weekly' },
    ])
    const r = await runDoctor(db, { version: 'x', now: NOW })
    const k = check(r, 'suppression-scopes')
    expect(k.status).toBe('warn')
    expect(k.detail.join(' ')).toContain('category:Bad Id')
    expect(k.detail.join(' ')).toContain('weekly')
    expect(k.detail.join(' ')).not.toContain('lifecycle.onboarding')
  })

  it('reports runs whose lease expired more than 10 minutes ago, not recent ones', async () => {
    const c = getCollections(db)
    const run = (subjectId: string, until: Date) => ({ programSlug: 'p', subjectId, lease: { until, worker: 'w' } }) as any
    await c.programRuns.insertMany([
      run('old', new Date(NOW.getTime() - 11 * 60_000)),
      run('recent', new Date(NOW.getTime() - 2 * 60_000)),
    ])
    const k = check(await runDoctor(db, { version: 'x', now: NOW }), 'stale-leases')
    expect(k.status).toBe('warn')
    expect(k.detail).toHaveLength(1)
    expect(k.detail[0]).toContain('p/old')
  })

  it('missing indexes: warn while no Program is enabled, fail once one is; sends indexes carry a count and createIndex command; synced passes', async () => {
    const c = getCollections(db)
    await c.programs.insertOne(buildProgramDoc(buildProgram({ slug: 'p1', actions: [ONE] }), { enabled: false }))
    await c.sends.insertMany([{ dedupeKey: 'a' }, { dedupeKey: 'b' }] as any)
    const warn = await runDoctor(db, { version: 'x', now: NOW })
    expect(check(warn, 'indexes').status).toBe('warn')
    expect(warn.ok).toBe(true)
    const line = check(warn, 'indexes').detail.find((d) => d.includes('"emailAtSend":1'))!
    expect(line).toContain('~2 document(s)')
    expect(line).toContain('createIndex({"emailAtSend":1,"kind":1,"sentAt":-1})')
    expect(check(warn, 'indexes').detail.some((d) => d.includes('"program.slug":1') && d.includes('partialFilterExpression'))).toBe(true)
    expect(check(warn, 'indexes').detail.some((d) => d.includes('"status":1,"notBefore":1'))).toBe(true)

    await c.programs.updateOne({ slug: 'p1' }, { $set: { enabled: true } })
    const bad = await runDoctor(db, { version: 'x', now: NOW })
    expect(check(bad, 'indexes').status).toBe('fail')
    expect(bad.ok).toBe(false)
    expect(formatDoctor(bad)).toContain('[FAIL]')

    await ensureIndexes(db)
    const good = await runDoctor(db, { version: 'x', now: NOW })
    expect(check(good, 'indexes').status).toBe('ok')
  })

  it('fails an enabled program that references a missing, transactional or off-category template', async () => {
    const c = getCollections(db)
    await ensureIndexes(db)
    const def = buildProgram({
      slug: 'act',
      category: 'lifecycle.onboarding',
      actions: [
        { id: 'a', title: 'A', priority: 2, attempts: 1, satisfied: { fact: 'x' } },
        { id: 'b', title: 'B', priority: 1, attempts: 1, satisfied: { fact: 'y' } },
      ],
    })
    await c.programs.insertOne(buildProgramDoc(def, { enabled: true }))
    const slugs = def.actions.flatMap((a) => a.attempts.flatMap((t) => t.deliveries.map((d) => d.templateSlug)))
    expect(slugs.length).toBe(2)
    await c.templates.insertOne(tpl(slugs[0]!, 'transactional'))
    const r = await runDoctor(db, { version: 'x', now: NOW })
    const k = check(r, 'programs-valid')
    expect(k.status).toBe('fail')
    expect(k.detail.some((d) => d.includes(`"${slugs[0]}" is not marketing`))).toBe(true)
    expect(k.detail.some((d) => d.includes(`"${slugs[1]}" does not exist`))).toBe(true)
    expect(r.ok).toBe(false)

    await c.templates.deleteMany({})
    await c.templates.insertMany(slugs.map((s) => tpl(s, 'marketing', 'lifecycle.onboarding')))
    expect(check(await runDoctor(db, { version: 'x', now: NOW }), 'programs-valid').status).toBe('ok')
    await c.templates.updateOne({ slug: slugs[1]! }, { $set: { category: 'other.cat' } })
    expect(check(await runDoctor(db, { version: 'x', now: NOW }), 'programs-valid').status).toBe('fail')
  })

  it('fails an enabled program that references an unpublished template', async () => {
    const c = getCollections(db)
    await ensureIndexes(db)
    const def = buildProgram({ slug: 'act2', category: 'lifecycle.onboarding', actions: [ONE] })
    await c.programs.insertOne(buildProgramDoc(def, { enabled: true }))
    const slugs = def.actions.flatMap((a) => a.attempts.flatMap((t) => t.deliveries.map((d) => d.templateSlug)))
    await c.templates.insertMany(slugs.map((s) => ({ ...tpl(s, 'marketing', 'lifecycle.onboarding'), publishedAt: null })))
    const k = check(await runDoctor(db, { version: 'x', now: NOW }), 'programs-valid')
    expect(k.status).toBe('fail')
    expect(k.detail.join(' ')).toContain('is not published')
  })

  it('stale-lease message uses the configured threshold; config limits are stated', async () => {
    const c = getCollections(db)
    await c.programRuns.insertOne({ programSlug: 'p', subjectId: 's', lease: { until: new Date(NOW.getTime() - 3 * 60_000), worker: 'w' } } as any)
    const r = await runDoctor(db, { version: 'x', now: NOW, staleLeaseMs: 2 * 60_000 })
    expect(check(r, 'stale-leases').title).toContain('2 minute(s)')
    expect(check(r, 'config-unreadable').detail).toEqual([])
    expect(check(r, 'config-unreadable').title).toMatch(/contactPolicy, factsAdapter/)
    expect(formatDoctor(r)).toContain('contactPolicy')
  })

  it('ensureIndexes can build the 0.21 sends indexes in the background', async () => {
    await ensureIndexes(db, 'mailer_', { backgroundSends: true })
    const c = getCollections(db)
    for (let i = 0; i < 50; i++) {
      const keys = (await c.sends.indexes()).map((x) => JSON.stringify(x.key))
      if (keys.includes('{"emailAtSend":1,"kind":1,"sentAt":-1}') && keys.includes('{"program.runId":1}')) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('sends indexes were not built')
  })

  it('fails an enabled program whose stored definition no longer parses, or has no published definition', async () => {
    const c = getCollections(db)
    await ensureIndexes(db)
    const doc = buildProgramDoc(buildProgram({ slug: 'broken', actions: [ONE] }), { enabled: true })
    ;(doc.definition as any).actions = []
    await c.programs.insertOne(doc)
    const k = check(await runDoctor(db, { version: 'x', now: NOW }), 'programs-valid')
    expect(k.status).toBe('fail')
    expect(k.detail.join(' ')).toContain('broken: actions')
  })

  it('a disabled program with problems does not fail doctor', async () => {
    const c = getCollections(db)
    await ensureIndexes(db)
    await c.programs.insertOne(buildProgramDoc(buildProgram({ slug: 'off', actions: [ONE] }), { enabled: false }))
    expect((await runDoctor(db, { version: 'x', now: NOW })).ok).toBe(true)
  })
})

describe('backfill-categories', () => {
  it('parses pairs and rejects malformed input', () => {
    expect(parseCategoryMap('a=x.y, b=z')).toEqual([['a', 'x.y'], ['b', 'z']])
    expect(() => parseCategoryMap('a')).toThrow(/slug=category/)
    expect(() => parseCategoryMap('a=')).toThrow()
    expect(() => parseCategoryMap('')).toThrow()
  })

  it('sets categories on marketing templates, audits each change, and is idempotent', async () => {
    const c = getCollections(db)
    await c.templates.insertMany([tpl('m1', 'marketing'), tpl('m2', 'marketing')])
    const first = await backfillCategories(db, [['m1', 'news'], ['m2', 'lifecycle.onboarding']])
    expect(first.map((r) => r.status)).toEqual(['changed', 'changed'])
    expect((await c.templates.findOne({ slug: 'm1' }))!.category).toBe('news')
    const audit = await c.auditLog.find({ action: 'template.backfill_category' }).toArray()
    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({ actor: 'cli:backfill-categories', before: { category: null }, after: { category: 'news' } })

    const second = await backfillCategories(db, [['m1', 'news'], ['m2', 'lifecycle.onboarding']])
    expect(second.map((r) => r.status)).toEqual(['unchanged', 'unchanged'])
    expect(await c.auditLog.countDocuments({ action: 'template.backfill_category' })).toBe(2)
  })

  it('--dry-run writes nothing', async () => {
    const c = getCollections(db)
    await c.templates.insertOne(tpl('m1', 'marketing'))
    const r = await backfillCategories(db, [['m1', 'news']], { dryRun: true })
    expect(r[0]!.status).toBe('would-change')
    expect((await c.templates.findOne({ slug: 'm1' }))!.category ?? null).toBeNull()
    expect(await c.auditLog.countDocuments({})).toBe(0)
  })

  it('refuses transactional templates, missing templates, bad ids and (without --overwrite) a different category', async () => {
    const c = getCollections(db)
    await c.templates.insertMany([tpl('t1', 'transactional'), tpl('m1', 'marketing', 'news')])
    const r = await backfillCategories(db, [['t1', 'news'], ['nope', 'news'], ['m1', 'Bad Id'], ['m1', 'other']])
    expect(r.map((x) => x.status)).toEqual(['error', 'error', 'error', 'error'])
    expect((r[0] as any).message).toMatch(/transactional/)
    expect((r[1] as any).message).toMatch(/not found/)
    expect((r[2] as any).message).toMatch(/invalid category id/)
    expect((r[3] as any).message).toMatch(/--overwrite/)
    expect((await c.templates.findOne({ slug: 'm1' }))!.category).toBe('news')

    const o = await backfillCategories(db, [['m1', 'other']], { overwrite: true })
    expect(o[0]).toMatchObject({ status: 'changed', previous: 'news' })
  })
})
