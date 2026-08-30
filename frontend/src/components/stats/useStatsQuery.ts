import { useCallback, useEffect, useState } from 'react'
import { StatsUnavailableError } from '@/services/statsApi'

export type QueryState<T> = {
  data: T | null
  loading: boolean
  error: string | null
  /** Külön jelezzük: nem hiba, csak az adatraktár nem fut. */
  unavailable: boolean
  reload: () => void
}

/**
 * Egyszerű lekérdező hook a statisztikai végpontokhoz.
 *
 * Két dolgot csinál, amit érdemes külön kiemelni: a versenyhelyzetet kizárja
 * (gyors fülváltásnál a régebbi válasz nem írhatja felül az újabbat), és az
 * „adatraktár nem elérhető" esetet elkülöníti a valódi hibától — az elsőt
 * nyugodt üzenettel kell mutatni, nem hibaként.
 */
export function useStatsQuery<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  enabled = true
): QueryState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    fetcher()
      .then((d) => {
        if (!alive) return
        setData(d)
        setUnavailable(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        if (e instanceof StatsUnavailableError) {
          setUnavailable(true)
          setError(null)
        } else {
          setError((e as Error).message)
        }
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // A `fetcher` minden rendernél új referencia, ezért szándékosan a hívó
    // által megadott `deps` vezérli az újrafuttatást.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce])

  return { data, loading, error, unavailable, reload }
}
