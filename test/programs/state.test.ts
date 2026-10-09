/**
 * Checklist read API — §5.11. `getProgramState` renders from the run, so the
 * in-app checklist and the emails agree; completion comes from `completedAt`,
 * never from re-reading facts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { tickProgram } from '../../src/testing/index.js'
import { restoreClock } from '../matrix/clock.js'
import { activation, enter, programHarness, seedProgramWithTemplates, startClock, subject, type ProgramHarness } from './helpers.js'

let P: ProgramHarness
const slug = 'activation'

beforeAll(async () => {
  P = await programHarness()
  await seedProgramWithTemplates(P.H, activation())
}, 120_000)

afterAll(async () => {
  restoreClock()
  if (P) await P.H.stop()
})

afterEach(() => restoreClock())

describe('mailer.getProgramState', () => {
  it('null when the subject has no run', async () => {
    expect(await P.H.mailer.getProgramState(slug, 'nobody')).toBeNull()
  })

  it('lists actions in priority order with status, cta, attempts and exactly one isNext', async () => {
    const t = startClock()
    const { subjectId } = await subject(P, { ga4_connected: true })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    const state = (await P.H.mailer.getProgramState(slug, subjectId))!
    expect(state.map((s) => s.actionId)).toEqual(['connect-shopify', 'connect-ga4', 'install-agent', 'run-playbook'])
    expect(state[0]).toEqual({
      actionId: 'connect-shopify',
      title: 'Connect Shopify',
      cta: { label: 'Connect', url: 'https://app.example.com/connect/shopify' },
      status: 'pending',
      isNext: true,
      attempts: 0,
      completedAt: null,
    })
    expect(state[1]).toMatchObject({ status: 'satisfied', isNext: false, completedAt: t, cta: null })
    expect(state.filter((s) => s.isNext)).toHaveLength(1)
  })

  it('stays satisfied when the fact regresses (read from completedAt)', async () => {
    startClock()
    const { subjectId } = await subject(P, { ga4_connected: true })
    await enter(P, slug, subjectId)
    await tickProgram(P.H.ctx, slug, subjectId)
    P.facts.set(subjectId, { ga4_connected: false })
    const state = (await P.H.mailer.getProgramState(slug, subjectId))!
    expect(state.find((s) => s.actionId === 'connect-ga4')!.status).toBe('satisfied')
  })

  it('an action never evaluated yet reads as pending', async () => {
    startClock()
    const { subjectId } = await subject(P)
    await enter(P, slug, subjectId)
    const state = (await P.H.mailer.getProgramState(slug, subjectId))!
    expect(state.every((s) => s.status === 'pending' && !s.isNext)).toBe(true)
  })
})
