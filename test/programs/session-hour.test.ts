/**
 * Send at the subject's usual hour — plans/17-cadence-controls.md F2.
 *
 * Reserved fact `usual_session_hour_utc` (integer 0–23). With
 * `delivery.useSessionHour`, `programDeliveryWindow` replaces `timeOfDay` with
 * that UTC hour (plus `sessionHourOffsetMinutes`) expressed as local HH:mm in
 * the window's zone on the day of sending; an invalid or missing fact keeps the
 * configured `timeOfDay`. The tick and the simulator both go through
 * `programSendTime`, so they agree.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { buildProgram, tickProgram } from '../../src/testing/index.js'
import { programDeliveryWindow } from '../../src/server/runner/programs/index.js'
import { lintProgram, type ProgramLintContext } from '../../src/server/programs/lint.js'
import { referencedTemplateSlugs, validateProgramDefinition, type ProgramValidationContext } from '../../src/server/programs/validate.js'
import type { DeliveryWindow, ProgramDefinition } from '../../src/shared/types.js'
import { advance, DAY, HOUR, restoreClock } from '../matrix/clock.js'
import {
  activation,
  CATEGORY,
  DECLARE,
  delivered,
  enter,
  getRun,
  programHarness,
  seedProgramWithTemplates,
  startClock,
  subject,
  type ProgramHarness,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Pure: programDeliveryWindow
// ---------------------------------------------------------------------------

describe('programDeliveryWindow', () => {
  const NY: DeliveryWindow = { weekdaysOnly: true, timeOfDay: '10:00', timezone: 'America/New_York', useSessionHour: true }
  const JAN = new Date('2027-01-12T15:00:00Z') // EST, UTC−5
  const JUL = new Date('2027-07-13T15:00:00Z') // EDT, UTC−4

  it('replaces timeOfDay with the usual UTC hour expressed in the window zone', () => {
    expect(programDeliveryWindow(NY, { usual_session_hour_utc: 14 }, JAN)).toEqual({ ...NY, timeOfDay: '09:00' })
    expect(programDeliveryWindow(NY, { usual_session_hour_utc: 14 }, JUL)).toEqual({ ...NY, timeOfDay: '10:00' })
    expect(programDeliveryWindow(NY, { usual_session_hour_utc: 0 }, JAN)).toEqual({ ...NY, timeOfDay: '19:00' })
  })
  it('applies the offset in minutes, wrapping across midnight', () => {
    expect(programDeliveryWindow({ ...NY, sessionHourOffsetMinutes: -30 }, { usual_session_hour_utc: 14 }, JAN)).toMatchObject({ timeOfDay: '08:30' })
    expect(programDeliveryWindow({ ...NY, sessionHourOffsetMinutes: 90 }, { usual_session_hour_utc: 14 }, JAN)).toMatchObject({ timeOfDay: '10:30' })
    expect(programDeliveryWindow({ ...NY, sessionHourOffsetMinutes: -180 }, { usual_session_hour_utc: 2 }, JAN)).toMatchObject({ timeOfDay: '18:00' })
    expect(programDeliveryWindow({ ...NY, sessionHourOffsetMinutes: 600 }, { usual_session_hour_utc: 20 }, JAN)).toMatchObject({ timeOfDay: '01:00' })
  })
  it('UTC when no zone is named; the contact zone when asked for', () => {
    expect(programDeliveryWindow({ timeOfDay: '10:00', useSessionHour: true }, { usual_session_hour_utc: 16 }, JAN)).toEqual({
      timeOfDay: '16:00',
      useSessionHour: true,
    })
    const w: DeliveryWindow = { timeOfDay: '10:00', useContactTimezone: true, timezone: 'UTC', useSessionHour: true }
    expect(programDeliveryWindow(w, { usual_session_hour_utc: 1, timezone: 'Asia/Tokyo' }, JAN)).toMatchObject({ timeOfDay: '10:00' })
    expect(programDeliveryWindow(w, { usual_session_hour_utc: 1 }, JAN)).toMatchObject({ timeOfDay: '01:00' })
    expect(programDeliveryWindow(w, { usual_session_hour_utc: 1, timezone: 'Not/AZone' }, JAN)).toMatchObject({ timeOfDay: '01:00' })
  })
  it('keeps the configured window when the fact is missing or not an hour', () => {
    for (const bad of [undefined, null, 24, -1, 3.5, '14', true, Number.NaN] as const) {
      expect(programDeliveryWindow(NY, { usual_session_hour_utc: bad as any }, JAN)).toEqual(NY)
    }
    expect(programDeliveryWindow({ useSessionHour: true, weekdaysOnly: true }, {}, JAN)).toEqual({ useSessionHour: true, weekdaysOnly: true })
  })
  it('does nothing without useSessionHour, even with the fact', () => {
    const plain: DeliveryWindow = { timeOfDay: '10:00', timezone: 'UTC' }
    expect(programDeliveryWindow(plain, { usual_session_hour_utc: 16 }, JAN)).toEqual(plain)
    expect(programDeliveryWindow({ ...plain, useSessionHour: false }, { usual_session_hour_utc: 16 }, JAN)).toEqual({ ...plain, useSessionHour: false })
  })
  it('never mutates its input', () => {
    const w = { ...NY }
    programDeliveryWindow(w, { usual_session_hour_utc: 14 }, JAN)
    expect(w).toEqual(NY)
  })
})

// ---------------------------------------------------------------------------
// Validation and lint
// ---------------------------------------------------------------------------

describe('validation and lint', () => {
  function vctx(facts: Record<string, any> = DECLARE): ProgramValidationContext {
    const templates = new Map<string, { kind: 'marketing' | 'transactional'; category?: string | null }>()
    for (const slug of ['a-1']) templates.set(slug, { kind: 'marketing', category: CATEGORY })
    return { categories: [{ id: CATEGORY, label: 'Tips' }], facts: { ...facts }, templates }
  }
  const def = (delivery: DeliveryWindow): ProgramDefinition =>
    buildProgram({ slug: 'u', policy: { minGapDays: 3, delivery }, actions: [{ id: 'a', priority: 1, satisfied: { fact: 'shopify_connected' } }] })
  const issues = (d: ProgramDefinition, c = vctx()) => {
    const r = validateProgramDefinition(d, c)
    return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`)
  }

  it('useSessionHour requires a declared number fact usual_session_hour_utc', () => {
    expect(issues(def({ timeOfDay: '10:00', useSessionHour: true }))).toEqual([])
    const { usual_session_hour_utc: _drop, ...without } = DECLARE as any
    expect(issues(def({ timeOfDay: '10:00', useSessionHour: true }), vctx(without))).toEqual([
      'policy.delivery.useSessionHour: requires a declared number fact "usual_session_hour_utc"',
    ])
    expect(issues(def({ timeOfDay: '10:00', useSessionHour: true }), vctx({ ...DECLARE, usual_session_hour_utc: { type: 'string' } }))).toHaveLength(1)
    expect(issues(def({ timeOfDay: '10:00', useSessionHour: false }), vctx(without))).toEqual([])
  })
  it('the offset is an integer within ±720', () => {
    expect(issues(def({ timeOfDay: '10:00', useSessionHour: true, sessionHourOffsetMinutes: -720 }))).toEqual([])
    expect(issues(def({ timeOfDay: '10:00', useSessionHour: true, sessionHourOffsetMinutes: 721 }))).not.toEqual([])
    expect(issues(def({ timeOfDay: '10:00', useSessionHour: true, sessionHourOffsetMinutes: 1.5 }))).not.toEqual([])
  })

  function lctx(d: ProgramDefinition): ProgramLintContext {
    const templates: ProgramLintContext['templates'] = new Map()
    for (const slug of referencedTemplateSlugs(d)) templates.set(slug, { kind: 'marketing', category: CATEGORY, published: true })
    return { categories: [{ id: CATEGORY, label: 'Tips' }], facts: { ...DECLARE } as any, templates }
  }
  it('lint warns when useSessionHour has no timeOfDay fallback', () => {
    const d = def({ useSessionHour: true })
    const warn = lintProgram(d, lctx(d)).filter((i) => i.code === 'session-hour-fallback')
    expect(warn).toEqual([
      {
        severity: 'warning',
        code: 'session-hour-fallback',
        path: 'policy.delivery.timeOfDay',
        message: 'no timeOfDay fallback: subjects without a usual hour are sent as soon as the gap allows',
      },
    ])
    const ok = def({ useSessionHour: true, timeOfDay: '10:00' })
    expect(lintProgram(ok, lctx(ok)).filter((i) => i.code === 'session-hour-fallback')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let P: ProgramHarness
const slug = 'usual'

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(
    P.H,
    activation({ slug, policy: { minGapDays: 3, delivery: { timeOfDay: '10:00', timezone: 'UTC', useSessionHour: true } } }),
  )
  await seedProgramWithTemplates(
    P.H,
    activation({ slug: 'usual-early', policy: { minGapDays: 3, delivery: { timeOfDay: '10:00', timezone: 'UTC', useSessionHour: true, sessionHourOffsetMinutes: -45 } } }),
  )
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})
afterEach(() => restoreClock())

describe('tick', () => {
  it('waits for the subject\'s usual hour today', async () => {
    const t = startClock() // Monday 15:00 UTC
    const { subjectId, owners } = await subject(P, { usual_session_hour_utc: 16 })
    await enter(P, slug, subjectId)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'delivery-window', chosen: 'connect-shopify', sendIds: [] })
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + HOUR))
    advance(HOUR)
    await P.H.drain()
    expect(delivered(P, owners)).toHaveLength(1)
  })

  it('an hour already passed today means tomorrow at that hour', async () => {
    const t = startClock()
    const { subjectId } = await subject(P, { usual_session_hour_utc: 13 })
    await enter(P, slug, subjectId)
    expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'delivery-window' })
    expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 22 * HOUR))
  })

  it('the offset moves the slot', async () => {
    const t = startClock()
    const { subjectId } = await subject(P, { usual_session_hour_utc: 17 })
    await enter(P, 'usual-early', subjectId)
    await tickProgram(P.H.ctx, 'usual-early', subjectId)
    expect((await getRun(P, 'usual-early', subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + HOUR + 15 * 60_000))
  })

  it('falls back to timeOfDay without the fact, and when the fact is not an hour', async () => {
    const t = startClock()
    for (const facts of [{}, { usual_session_hour_utc: 30 }, { usual_session_hour_utc: null }]) {
      const { subjectId } = await subject(P, facts as any)
      await enter(P, slug, subjectId)
      expect(await tickProgram(P.H.ctx, slug, subjectId)).toMatchObject({ reason: 'delivery-window' })
      expect((await getRun(P, slug, subjectId))!.nextTickAt).toEqual(new Date(t.getTime() + 19 * HOUR)) // Tuesday 10:00
    }
  })

  it('the simulator agrees with the tick', async () => {
    const t = startClock()
    const { subjectId } = await subject(P, { usual_session_hour_utc: 16 })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const run = (await getRun(P, slug, subjectId))!
    const s = await P.H.mailer.simulateProgram(slug, { subjectId })
    expect(s.next).toMatchObject({ reason: 'delivery-window', actionId: 'connect-shopify', attempt: 1 })
    expect(s.next.at).toEqual(run.nextTickAt)
    expect(s.sequence[0]!.at).toEqual(new Date(t.getTime() + HOUR))
    // Every later step lands on the usual hour too: 16:00 UTC, three days apart.
    expect(s.sequence[1]!.at).toEqual(new Date(t.getTime() + HOUR + 3 * DAY))
  })

  it('a facts-only simulation can try a usual hour', async () => {
    const t = startClock()
    const s = await P.H.mailer.simulateProgram(slug, { facts: { business_type: 'ecommerce', usual_session_hour_utc: 20 } })
    expect(s.next.reason).toBe('delivery-window')
    expect(s.next.at).toEqual(new Date(t.getTime() + 5 * HOUR))
  })
})
