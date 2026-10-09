import { describe, expect, it } from 'vitest'
import {
  addAttempt,
  applyChipEdit,
  canRemoveAttempt,
  chipFields,
  clone,
  moveAction,
  parsePredicateText,
  removeAttempt,
  sameDef,
  setAttemptGap,
  setAttemptTemplate,
  setCooldown,
  setCta,
  setHold,
  setPredicate,
  setSunsetTemplate,
  setTitle,
  stableStringify,
  templateChoices,
} from '../../../src/client/screens/program-board/edit'
import { orderedActions } from '../../../src/client/screens/program-board/model'
import { action, def } from './fixtures'

const prios = (d: ReturnType<typeof def>) => Object.fromEntries(d.actions.map((a) => [a.id, a.priority]))
const order = (d: ReturnType<typeof def>) => orderedActions(d).map((a) => a.id)

describe('stable compare', () => {
  it('ignores key order and undefined', () => {
    expect(stableStringify({ b: 1, a: [{ y: 1, x: undefined }] })).toBe(stableStringify({ a: [{ y: 1 }], b: 1 }))
    expect(sameDef(def([action('a', 1, ['x'])]), clone(def([action('a', 1, ['x'])])))).toBe(true)
    expect(sameDef(def([action('a', 1, ['x'])]), def([action('a', 2, ['x'])]))).toBe(false)
  })
})

describe('moveAction', () => {
  const base = () => def([action('a', 100, ['t']), action('b', 80, ['t']), action('c', 60, ['t']), action('d', 40, ['t'])])

  it('takes the integer midpoint between its new neighbours', () => {
    const r = moveAction(base(), 'd', 1) // between a(100) and b(80)
    expect(r.renumbered).toBe(false)
    expect(prios(r.def).d).toBe(90)
    expect(order(r.def)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moving down works the same', () => {
    const r = moveAction(base(), 'a', 2) // between c(60) and d(40) once a is out
    expect(prios(r.def).a).toBe(50)
    expect(order(r.def)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('to the very top: above the highest by 10', () => {
    const r = moveAction(base(), 'c', 0)
    expect(prios(r.def).c).toBe(110)
    expect(order(r.def)[0]).toBe('c')
  })

  it('to the very bottom: below the lowest by 10', () => {
    const r = moveAction(base(), 'a', 3)
    expect(prios(r.def).a).toBe(30)
    expect(order(r.def)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('only changes the moved action when a midpoint fits', () => {
    const b = base()
    const r = moveAction(b, 'd', 1)
    expect(prios(r.def)).toEqual({ ...prios(b), d: 90 })
  })

  it('renumbers 100, 90, 80 … when no integer fits', () => {
    const d = def([action('a', 10, ['t']), action('b', 9, ['t']), action('c', 5, ['t'])])
    const r = moveAction(d, 'c', 1) // between a(10) and b(9)
    expect(r.renumbered).toBe(true)
    expect(order(r.def)).toEqual(['a', 'c', 'b'])
    expect(prios(r.def)).toEqual({ a: 100, c: 90, b: 80 })
  })

  it('renumbers on a tie', () => {
    const d = def([action('a', 10, ['t']), action('b', 10, ['t']), action('c', 1, ['t'])])
    const r = moveAction(d, 'c', 1)
    expect(r.renumbered).toBe(true)
    expect(order(r.def)).toEqual(['a', 'c', 'b'])
  })

  it('renumbers instead of going negative at the bottom', () => {
    const d = def([action('a', 5, ['t']), action('b', 3, ['t'])])
    const r = moveAction(d, 'a', 1)
    expect(r.renumbered).toBe(true)
    expect(order(r.def)).toEqual(['b', 'a'])
  })

  it('keeps definition array order and does not mutate the input', () => {
    const b = base()
    const snap = JSON.stringify(b)
    const r = moveAction(b, 'd', 0)
    expect(r.def.actions.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(JSON.stringify(b)).toBe(snap)
  })

  it('is a no-op when dropped where it already is', () => {
    const b = base()
    expect(moveAction(b, 'b', 1).def).toBe(b)
    expect(moveAction(b, 'nope', 0).def).toBe(b)
  })
})

describe('row edits', () => {
  const d = def([action('a', 2, ['x', 'y'], { cooldownDays: 30, cta: { label: 'Go', url: '/go' } }), action('b', 1, ['z'])])

  it('hold / skip', () => {
    expect(setHold(d, 'a', true).actions[0]!.onExhaust).toBe('hold')
    expect(setHold(setHold(d, 'a', true), 'a', false).actions[0]!.onExhaust).toBe('skip')
  })

  it('cooldown: empty removes, junk ignored', () => {
    expect(setCooldown(d, 'a', '45').actions[0]!.cooldownDays).toBe(45)
    expect('cooldownDays' in setCooldown(d, 'a', '').actions[0]!).toBe(false)
    expect(setCooldown(d, 'a', 'abc')).toBe(d)
    expect(setCooldown(d, 'a', '-1')).toBe(d)
  })

  it('title and cta', () => {
    expect(setTitle(d, 'b', 'New').actions[1]!.title).toBe('New')
    expect(setCta(d, 'b', 'Open', '/o').actions[1]!.cta).toEqual({ label: 'Open', url: '/o' })
    expect('cta' in setCta(d, 'a', '', '').actions[0]!).toBe(false)
  })

  it('predicates: eligible can be removed, satisfied cannot', () => {
    const p = { fact: 'x' } as any
    const withE = setPredicate(d, 'a', 'eligible', p)
    expect(withE.actions[0]!.eligible).toEqual(p)
    expect('eligible' in setPredicate(withE, 'a', 'eligible', undefined).actions[0]!).toBe(false)
    expect(setPredicate(d, 'a', 'satisfied', undefined).actions[0]!.satisfied).toEqual(d.actions[0]!.satisfied)
  })

  it('never mutates its input', () => {
    const snap = JSON.stringify(d)
    setHold(d, 'a', true)
    setTitle(d, 'a', 'zz')
    removeAttempt(d, 'a', 0)
    expect(JSON.stringify(d)).toBe(snap)
  })
})

describe('predicate text', () => {
  it('parses objects, rejects the rest, handles empty by requiredness', () => {
    expect(parsePredicateText('{"fact":"x"}', true)).toEqual({ ok: true, value: { fact: 'x' } })
    expect(parsePredicateText('', false)).toEqual({ ok: true, value: undefined })
    expect(parsePredicateText('  ', true)).toEqual({ ok: false, error: 'Required' })
    expect(parsePredicateText('[1]', true).ok).toBe(false)
    expect(parsePredicateText('"s"', true).ok).toBe(false)
    const bad = parsePredicateText('{"a":', true)
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error.length > 0).toBe(true)
  })
})

describe('cell edits', () => {
  const d = def([action('a', 1, ['x', 'y', 'z'])])
  it('swaps a template', () => {
    expect(setAttemptTemplate(d, 'a', 1, 'new').actions[0]!.attempts[1]!.deliveries).toEqual([{ channel: 'email', templateSlug: 'new' }])
  })
  it('gap override: set, remove with empty, ignore junk', () => {
    const g = setAttemptGap(d, 'a', 2, '7')
    expect(g.actions[0]!.attempts[2]!.minGapDays).toBe(7)
    expect('minGapDays' in setAttemptGap(g, 'a', 2, '').actions[0]!.attempts[2]!).toBe(false)
    expect(setAttemptGap(d, 'a', 2, '-3')).toBe(d)
  })
  it('removes an attempt but never the last one', () => {
    expect(removeAttempt(d, 'a', 0).actions[0]!.attempts.map((x) => x.deliveries[0]!.templateSlug)).toEqual(['y', 'z'])
    const one = def([action('a', 1, ['x'])])
    expect(canRemoveAttempt(one.actions[0]!)).toBe(false)
    expect(removeAttempt(one, 'a', 0)).toBe(one)
  })
  it('appends an attempt', () => {
    expect(addAttempt(d, 'a', 'last').actions[0]!.attempts).toHaveLength(4)
    expect(addAttempt(d, 'a', 'last').actions[0]!.attempts[3]!.deliveries[0]!.templateSlug).toBe('last')
  })
  it('sunset ask template', () => {
    const s = def([action('a', 1, ['x'])], { policy: { minGapDays: 1, sunset: { slowAfter: 1, slowFactor: 2, askAfter: 3, askTemplateSlug: 'old' } } })
    expect(setSunsetTemplate(s, 'new').policy.sunset!.askTemplateSlug).toBe('new')
    expect(setSunsetTemplate(d, 'new')).toBe(d)
  })
})

describe('policy chip edits', () => {
  const d = def([action('a', 1, ['x'])], {
    holdoutPct: 10,
    policy: {
      minGapDays: 3,
      delivery: { weekdaysOnly: true, timeOfDay: '10:00', timezone: 'UTC' },
      suppressIfSessionWithinHours: 12,
      sunset: { slowAfter: 3, slowFactor: 2, askAfter: 6, askTemplateSlug: 'ask' },
    },
  })

  it('exposes the current values as fields', () => {
    expect(chipFields('gap', d).map((f) => f.value)).toEqual(['3'])
    expect(chipFields('window', d).map((f) => [f.name, f.value])).toEqual([['weekdays', '1'], ['time', '10:00'], ['useSessionHour', ''], ['sessionHourOffsetMinutes', '']])
    expect(chipFields('sunset', d).map((f) => f.value)).toEqual(['3', '2', '6'])
    expect(chipFields('holdout', d)[0]!.value).toBe('10')
    expect(chipFields('entry', d)).toEqual([])
  })

  it('applies valid values', () => {
    expect(applyChipEdit(d, 'gap', { days: '5' }).policy.minGapDays).toBe(5)
    expect(applyChipEdit(d, 'quiet', { hours: '24' }).policy.suppressIfSessionWithinHours).toBe(24)
    expect(applyChipEdit(d, 'holdout', { pct: '20' }).holdoutPct).toBe(20)
    expect(applyChipEdit(d, 'sunset', { slowAfter: '2', slowFactor: '3', askAfter: '5' }).policy.sunset).toMatchObject({ slowAfter: 2, slowFactor: 3, askAfter: 5, askTemplateSlug: 'ask' })
    const w = applyChipEdit(d, 'window', { weekdays: '', time: '09:30' })
    expect(w.policy.delivery).toEqual({ timeOfDay: '09:30', timezone: 'UTC' })
  })

  it('empty removes optional settings', () => {
    expect('suppressIfSessionWithinHours' in applyChipEdit(d, 'quiet', { hours: '' }).policy).toBe(false)
    expect('holdoutPct' in applyChipEdit(d, 'holdout', { pct: '' })).toBe(false)
    const only = def([action('a', 1, ['x'])], { policy: { minGapDays: 1, delivery: { weekdaysOnly: true } } })
    expect('delivery' in applyChipEdit(only, 'window', { weekdays: '', time: '' }).policy).toBe(false)
  })

  it('ignores invalid values', () => {
    expect(applyChipEdit(d, 'gap', { days: '' })).toBe(d)
    expect(applyChipEdit(d, 'gap', { days: 'x' })).toBe(d)
    expect(applyChipEdit(d, 'holdout', { pct: '101' })).toBe(d)
    expect(applyChipEdit(d, 'window', { weekdays: '1', time: '25:00' })).toBe(d)
    expect(applyChipEdit(d, 'sunset', { slowAfter: '2', slowFactor: '', askAfter: '5' })).toBe(d)
  })
})

describe('templateChoices', () => {
  it('keeps marketing templates of the category, sorted', () => {
    const list = [
      { slug: 'b', name: 'B', kind: 'marketing', category: 'marketing', subject: 'Sb', body: { html: '<p/>' } },
      { slug: 'a', name: 'A', kind: 'marketing', category: 'marketing', subject: 'Sa', body: { html: '' } },
      { slug: 't', name: 'T', kind: 'transactional', category: null, subject: 'x' },
      { slug: 'o', name: 'O', kind: 'marketing', category: 'other', subject: 'y' },
    ]
    expect(templateChoices(list, 'marketing')).toEqual([
      { slug: 'a', name: 'A', subject: 'Sa', published: false },
      { slug: 'b', name: 'B', subject: 'Sb', published: true },
    ])
  })
})
