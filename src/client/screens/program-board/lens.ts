/**
 * The lens: map a simulation (`POST /programs/:slug/simulate`, serialized) to
 * per-row status and per-cell state. Pure — no DOM.
 */
import type { ProgramNextReason, ProgramSimulation } from '../../../shared/program-board'
import { SUNSET_ID } from './model'

type Sim = ProgramSimulation<string>

/** plans/16 §2.5 */
export const REASON_WORDS: Record<ProgramNextReason, string> = {
  send: 'Sends now',
  holdout: 'Holdout: logged, not sent',
  'min-gap': 'Waiting for the gap',
  'delivery-window': 'Waiting for the window',
  'session-suppressed': 'Recently active',
  'in-flight': 'Previous email in flight',
  'none-eligible': 'Nothing to send',
  'no-recipients': 'No one to email',
  completed: 'Done',
  exited: 'Exited',
  sunset: 'Sunset',
}

export function reasonWords(reason: ProgramNextReason, detail?: string): string {
  const w = REASON_WORDS[reason] ?? reason
  return detail ? `${w} (${detail})` : w
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ---------------------------------------------------------------------------
// Row status (the status column)
// ---------------------------------------------------------------------------

export type RowState = 'satisfied' | 'next' | 'pending' | 'exhausted' | 'cooldown' | 'blocked' | 'ineligible' | 'held'

export interface RowStatus {
  state: RowState
  /** Tooltip: always the state in words. */
  label: string
}

export function rowStatus(sim: Sim, actionId: string, titles: ReadonlyMap<string, string>): RowStatus {
  const isNext = sim.next.actionId === actionId
  if (actionId === SUNSET_ID) {
    if (sim.run?.status === 'sunset') return { state: 'satisfied', label: 'Ask sent' }
    if (isNext) return { state: 'next', label: 'Next' }
    return { state: 'pending', label: 'Not reached yet' }
  }
  const c = sim.candidates.find((x) => x.actionId === actionId)
  if (!c) return { state: 'pending', label: 'Not evaluated' }
  if (c.blockedBy === 'satisfied' || c.status === 'satisfied') return { state: 'satisfied', label: 'Done' }
  if (isNext) return { state: 'next', label: 'Next' }
  const b = c.blockedBy
  if (b === 'cooldown' || c.status === 'cooldown') {
    return { state: 'cooldown', label: c.cooldownUntil ? `Retries after ${fmtDay(c.cooldownUntil)}` : 'Cooling down' }
  }
  if (b === 'exhausted' || c.status === 'exhausted') return { state: 'exhausted', label: 'All emails sent, not done' }
  if (b && b.startsWith('requires:')) {
    const dep = b.slice('requires:'.length)
    return { state: 'blocked', label: `Waiting for ${titles.get(dep) ?? dep}` }
  }
  if (b === 'ineligible') return { state: 'ineligible', label: 'Not eligible' }
  if (b === 'hold') return { state: 'held', label: 'Held by a higher action' }
  return { state: 'pending', label: 'Pending' }
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export type CellLens =
  | { kind: 'sent'; at: string | null }
  | { kind: 'next'; at: string | null; reason: ProgramNextReason; text: string }
  | { kind: 'projected'; position: number; at: string }
  | { kind: 'muted' }

/** Newest-first decisions (as the run endpoint returns them): date each attempt went out. */
export function sentDates(decisions: Array<{ chosen?: string | null; attempt?: number | null; at?: string; reason?: string }>): Map<string, string> {
  const m = new Map<string, string>()
  for (const d of decisions) {
    if (!d.chosen || !d.attempt || !d.at) continue
    if (d.reason && (d.reason === 'none-eligible' || d.reason === 'completed' || d.reason === 'exited')) continue
    const k = `${d.chosen}#${d.attempt}`
    if (!m.has(k)) m.set(k, d.at)
  }
  return m
}

export function cellLens(sim: Sim, dates: ReadonlyMap<string, string>, actionId: string, attempt: number): CellLens {
  const key = `${actionId}#${attempt}`
  if (isSent(sim, actionId, attempt)) return { kind: 'sent', at: dates.get(key) ?? null }
  const n = sim.next
  if (n.actionId === actionId && n.attempt === attempt) {
    const text = n.reason === 'send' ? REASON_WORDS.send : reasonWords(n.reason, n.detail)
    return { kind: 'next', at: n.at, reason: n.reason, text }
  }
  const pos = sim.sequence.findIndex((s) => s.actionId === actionId && s.attempt === attempt)
  if (pos >= 0) return { kind: 'projected', position: pos + 1, at: sim.sequence[pos]!.at }
  return { kind: 'muted' }
}

function isSent(sim: Sim, actionId: string, attempt: number): boolean {
  if (actionId === SUNSET_ID) return sim.run?.status === 'sunset'
  const c = sim.candidates.find((x) => x.actionId === actionId)
  return !!c && attempt <= c.attempts
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

export type Summary =
  | { kind: 'next'; state: RowState; title: string; attempt: number; atText: string; words: string }
  | { kind: 'none'; words: string }

const WAITS: ReadonlySet<ProgramNextReason> = new Set(['send', 'holdout', 'min-gap', 'delivery-window', 'session-suppressed', 'in-flight'])

export function summarize(sim: Sim, titles: ReadonlyMap<string, string>): Summary {
  const n = sim.next
  if (n.actionId && n.attempt && WAITS.has(n.reason)) {
    const title = n.actionId === SUNSET_ID ? 'Sunset ask' : titles.get(n.actionId) ?? n.actionId
    return {
      kind: 'next',
      state: n.reason === 'send' || n.reason === 'holdout' ? 'next' : 'cooldown',
      title,
      attempt: n.attempt,
      atText: n.reason === 'send' || n.reason === 'holdout' ? 'now' : fmtWhen(n.at),
      words: reasonWords(n.reason, n.detail),
    }
  }
  return { kind: 'none', words: reasonWords(n.reason, n.detail) }
}

export const PROJECTION_NOTE =
  'Projection assumes facts stay the same and no engagement. Contact policy and suppressions can still delay a send.'
