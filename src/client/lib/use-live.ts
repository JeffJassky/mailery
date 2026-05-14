/**
 * useLive — fetch a resource and expose loading/error/data without ever
 * substituting fake data. `data` is `undefined` until the first successful
 * response. Screens render their own loading / error / empty UI.
 *
 * The `deps` argument controls when the effect re-runs. Pass anything the
 * `fetchFn` closes over (slug, id, filters) so changing it triggers a
 * refetch — otherwise the captured closure stales.
 */

import { useEffect, useRef, useState } from 'react'

export interface LiveResult<T> {
  data: T | undefined
  loading: boolean
  error: Error | null
  refetch: () => void
}

export function useLive<T>(fetchFn: () => Promise<T>, deps: ReadonlyArray<unknown> = []): LiveResult<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [bump, setBump] = useState(0)
  const aliveRef = useRef(true)
  // Always invoke the latest fetchFn — callers create a new arrow on each
  // render so the closure is fresh. The ref avoids re-running the effect
  // on every render.
  const fnRef = useRef(fetchFn)
  fnRef.current = fetchFn

  useEffect(() => {
    aliveRef.current = true
    setLoading(true)
    fnRef.current()
      .then((d) => {
        if (!aliveRef.current) return
        setData(d)
        setError(null)
      })
      .catch((err: Error) => {
        if (!aliveRef.current) return
        setError(err)
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false)
      })
    return () => {
      aliveRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump, ...deps])

  return { data, loading, error, refetch: () => setBump((b) => b + 1) }
}
