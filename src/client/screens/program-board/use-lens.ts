/** Lens data: the simulation plus the subject's real decisions (for sent dates). */
import React from 'react'
import { api, type ProgramSimulation, type ProgramSource } from '../../lib/api'
import { sentDates } from './lens'
import type { FactOverrides } from './facts-input'

export interface LensState {
  sim: ProgramSimulation<string> | null
  /** null: no subject. false: subject has no run (404). true: has a run. */
  hasRun: boolean | null
  dates: Map<string, string>
  error: string | null
  loading: boolean
}

const EMPTY: LensState = { sim: null, hasRun: null, dates: new Map(), error: null, loading: false }

export function useLens(
  slug: string,
  source: ProgramSource,
  subjectId: string,
  overrides: FactOverrides,
  active: boolean,
  version: string,
): LensState {
  const [state, setState] = React.useState<LensState>(EMPTY)
  const seq = React.useRef(0)
  const ovKey = JSON.stringify(overrides)

  React.useEffect(() => {
    if (!active) {
      seq.current++
      setState(EMPTY)
      return
    }
    const mine = ++seq.current
    setState((s) => ({ ...s, loading: true }))
    const t = window.setTimeout(async () => {
      try {
        const input = {
          source,
          ...(subjectId ? { subjectId } : {}),
          ...(Object.keys(overrides).length ? { facts: overrides } : {}),
        }
        const runP = subjectId
          ? api.programRun(slug, subjectId, { limit: 200 }).then(
              (r) => ({ ok: true as const, r }),
              (e: any) => ({ ok: false as const, status: e?.status as number | undefined }),
            )
          : Promise.resolve(null)
        const [sim, run] = await Promise.all([api.simulateProgram(slug, input), runP])
        if (mine !== seq.current) return
        setState({
          sim,
          hasRun: run === null ? null : run.ok,
          dates: run && run.ok ? sentDates(run.r.decisions ?? []) : new Map(),
          error: null,
          loading: false,
        })
      } catch (e: any) {
        if (mine !== seq.current) return
        setState({ sim: null, hasRun: null, dates: new Map(), error: String(e?.message ?? e), loading: false })
      }
    }, 300)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, source, subjectId, ovKey, active, version])

  return state
}
