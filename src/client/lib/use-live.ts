/**
 * Tiny "live or mock" hook. Calls a fetch function; while pending or on error,
 * returns the provided fallback so screens render their mockup-quality state
 * even when the API isn't reachable (offline preview, demo deploys).
 */

import { useEffect, useRef, useState } from 'react'

export interface LiveResult<T> {
  data: T
  loading: boolean
  error: Error | null
  refetch: () => void
}

export function useLive<T>(fetchFn: () => Promise<T>, fallback: T): LiveResult<T> {
  const [data, setData] = useState<T>(fallback)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [bump, setBump] = useState(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    setLoading(true)
    fetchFn()
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
  }, [bump])

  return { data, loading, error, refetch: () => setBump((b) => b + 1) }
}
