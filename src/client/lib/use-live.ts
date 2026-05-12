/**
 * useLive — fetch a resource and expose loading/error/data without ever
 * substituting fake data. `data` is `undefined` until the first successful
 * response. Screens render their own loading / error / empty UI.
 */

import { useEffect, useRef, useState } from 'react'

export interface LiveResult<T> {
  data: T | undefined
  loading: boolean
  error: Error | null
  refetch: () => void
}

export function useLive<T>(fetchFn: () => Promise<T>): LiveResult<T> {
  const [data, setData] = useState<T | undefined>(undefined)
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
