import { describe, expect, it } from 'vitest'
import { cellLens, reasonWords, rowStatus, sentDates, summarize } from '../../../src/client/screens/program-board/lens'
import { cand, sim } from './fixtures'

const titles = new Map([['a', 'Alpha'], ['b', 'Beta']])

describe('rowStatus', () => {
  const s = sim({
    candidates: [
      cand('done', { blockedBy: 'satisfied', status: 'satisfied' }),
      cand('go'),
      cand('wait', { blockedBy: 'requires:a' }),
      cand('no', { blockedBy: 'ineligible' }),
      cand('ex', { blockedBy: 'exhausted', status: 'exhausted' }),
      cand('cool', { blockedBy: 'cooldown', status: 'cooldown', cooldownUntil: '2026-11-01T00:00:00.000Z' }),
      cand('hold', { blockedBy: 'hold' }),
      cand('later'),
    ] as any,
    next: { reason: 'send', actionId: 'go', attempt: 1, templateSlug: 't', at: '2026-10-08T12:00:00.000Z' },
  })
  it('maps every state with words', () => {
    const st = (id: string) => rowStatus(s, id, titles)
    expect(st('done')).toEqual({ state: 'satisfied', label: 'Done' })
    expect(st('go').state).toBe('next')
    expect(st('wait')).toEqual({ state: 'blocked', label: 'Waiting for Alpha' })
    expect(st('no').state).toBe('ineligible')
    expect(st('ex').state).toBe('exhausted')
    expect(st('cool').state).toBe('cooldown')
    expect(st('cool').label).toMatch(/^Retries after /)
    expect(st('hold').state).toBe('held')
    expect(st('later').state).toBe('pending')
  })
  it('handles the sunset ask row', () => {
    expect(rowStatus(sim(), '$sunset-ask', titles).state).toBe('pending')
    expect(rowStatus(sim({ next: { reason: 'send', actionId: '$sunset-ask', attempt: 1, templateSlug: 't', at: null } }), '$sunset-ask', titles).state).toBe('next')
    const run = { status: 'sunset', arm: 'treatment', unansweredAttempts: 6, sunsetStage: 2, lastSentAt: null, enteredAt: '' } as const
    expect(rowStatus(sim({ run }), '$sunset-ask', titles).state).toBe('satisfied')
  })
})

describe('cellLens', () => {
  const s = sim({
    candidates: [cand('a', { attempts: 1 }), cand('b')] as any,
    next: { reason: 'min-gap', actionId: 'a', attempt: 2, templateSlug: 't', at: '2026-10-11T10:00:00.000Z' },
    sequence: [
      { at: '2026-10-11T10:00:00.000Z', actionId: 'a', attempt: 2, templateSlug: 't', sunsetStage: 0 },
      { at: '2026-10-14T10:00:00.000Z', actionId: 'b', attempt: 1, templateSlug: 'u', sunsetStage: 0 },
    ],
  })
  const dates = new Map([['a#1', '2026-10-05T10:00:00.000Z']])
  it('marks sent attempts with their date', () => {
    expect(cellLens(s, dates, 'a', 1)).toEqual({ kind: 'sent', at: '2026-10-05T10:00:00.000Z' })
  })
  it('sent without a matching decision has no date', () => {
    expect(cellLens(s, new Map(), 'a', 1)).toEqual({ kind: 'sent', at: null })
  })
  it('marks the next cell with the reason in words', () => {
    expect(cellLens(s, dates, 'a', 2)).toMatchObject({ kind: 'next', text: 'Waiting for the gap', at: '2026-10-11T10:00:00.000Z' })
  })
  it('numbers projected cells after the next one 1, 2, 3; mutes the rest', () => {
    expect(cellLens(s, dates, 'b', 1)).toEqual({ kind: 'projected', position: 1, at: '2026-10-14T10:00:00.000Z' })
    expect(cellLens(s, dates, 'b', 2)).toEqual({ kind: 'muted' })
  })
  it('numbers from 1 when the projection does not start with the next cell', () => {
    const t = sim({ ...s, next: { reason: 'none-eligible', actionId: null, attempt: null, templateSlug: null, at: null } } as any)
    expect(cellLens(t, dates, 'a', 2)).toMatchObject({ kind: 'projected', position: 1 })
    expect(cellLens(t, dates, 'b', 1)).toMatchObject({ kind: 'projected', position: 2 })
  })
})

describe('sentDates', () => {
  it('takes the newest decision per (action, attempt)', () => {
    const m = sentDates([
      { chosen: 'a', attempt: 1, at: '2026-10-11', reason: 'in-flight', sendIds: [] },
      { chosen: 'a', attempt: 1, at: '2026-10-09', reason: 'highest-rank', sendIds: ['s2'] },
      { chosen: 'a', attempt: 1, at: '2026-09-01', reason: 'highest-rank', sendIds: ['s1'] },
      { chosen: null, attempt: null, at: '2026-10-10', reason: 'none-eligible', sendIds: [] },
      { chosen: 'b', attempt: 2, at: '2026-10-02', reason: 'holdout', sendIds: ['s3'] },
      { chosen: 'c', attempt: 1, at: '2026-10-03', reason: 'min-gap', sendIds: [] },
    ])
    expect(m.get('a#1')).toBe('2026-10-09')
    expect(m.get('b#2')).toBe('2026-10-02')
    expect(m.size).toBe(2)
  })
})

describe('summarize / reasonWords', () => {
  it('words, with detail appended', () => {
    expect(reasonWords('send')).toBe('Sends now')
    expect(reasonWords('none-eligible', 'template "x" is missing')).toBe('Nothing to send (template "x" is missing)')
    expect(reasonWords('no-recipients')).toBe('No one to email')
  })
  it('send now', () => {
    const s = sim({ next: { reason: 'send', actionId: 'a', attempt: 2, templateSlug: 't', at: '2026-10-08T12:00:00.000Z' } })
    expect(summarize(s, titles)).toMatchObject({ kind: 'next', state: 'next', title: 'Alpha', attempt: 2, atText: 'now' })
  })
  it('waiting names the reason', () => {
    const s = sim({ next: { reason: 'delivery-window', actionId: 'b', attempt: 1, templateSlug: 't', at: '2026-10-09T14:00:00.000Z' } })
    expect(summarize(s, titles)).toMatchObject({ kind: 'next', state: 'cooldown', title: 'Beta', words: 'Waiting for the window' })
  })
  it('nothing will send: only the reason', () => {
    expect(summarize(sim({ next: { reason: 'completed', actionId: null, attempt: null, templateSlug: null, at: null } }), titles)).toEqual({ kind: 'none', words: 'Done' })
    expect(summarize(sim({ next: { reason: 'no-recipients', actionId: 'a', attempt: 1, templateSlug: 't', at: null } }), titles)).toEqual({ kind: 'none', words: 'No one to email' })
  })
})
