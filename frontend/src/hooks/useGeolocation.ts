import { useCallback, useEffect, useRef, useState } from 'react'

export type GeoStatus = 'idle' | 'requesting' | 'watching' | 'denied' | 'unavailable' | 'error'

export interface GeoPosition {
  lat: number
  lon: number
  /** Vízszintes pontosság méterben — ebből rajzoljuk a bizonytalansági kört. */
  accuracyM: number
  at: number
}

export interface GeoState {
  status: GeoStatus
  position: GeoPosition | null
  error: string | null
  start: () => void
  stop: () => void
  isActive: boolean
  /** A helyzet még a korábbi munkamenetből való, friss mérés nem érkezett. */
  isStale: boolean
}

const ENABLED_KEY = 'mvk_geo_enabled'
const LAST_FIX_KEY = 'mvk_geo_last_fix'

/**
 * Ennél régebbi mentett helyzetet nem veszünk elő.
 *
 * Az app újranyitásakor a GPS első mérése másodpercekig tart; addig a legutóbbi
 * ismert helyzettel dolgozunk, hogy a térkép azonnal ott legyen, ahol te. Fél
 * óránál régebbi pozíció viszont már inkább félrevezet, mint segít.
 */
const LAST_FIX_MAX_AGE_MS = 30 * 60_000

function readLastFix(): GeoPosition | null {
  try {
    const raw = localStorage.getItem(LAST_FIX_KEY)
    if (!raw) return null
    const fix = JSON.parse(raw) as GeoPosition
    if (typeof fix?.lat !== 'number' || typeof fix?.lon !== 'number') return null
    if (Date.now() - fix.at > LAST_FIX_MAX_AGE_MS) return null
    return fix
  } catch {
    return null
  }
}

/**
 * Helymeghatározás.
 *
 * Egyetlen példányban fut az egész alkalmazásra (lásd `GeoProvider`), mert a
 * térkép, a menetkövetés és a menetrend ugyanazt a helyzetet mutatja — két
 * párhuzamos `watchPosition` csak az akkumulátort enné.
 *
 * Ha korábban engedélyezve volt, a következő megnyitáskor magától folytatja a
 * követést: az azonnali „hol vagyok” ennek a feltétele.
 */
export function useGeolocation(): GeoState {
  const [status, setStatus] = useState<GeoStatus>('idle')
  const [position, setPosition] = useState<GeoPosition | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isStale, setStale] = useState(false)
  const watchIdRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    setStatus('idle')
    setPosition(null)
    setStale(false)
    try {
      localStorage.removeItem(ENABLED_KEY)
      localStorage.removeItem(LAST_FIX_KEY)
    } catch {
      /* privát mód — a beállítás csak a munkamenetre marad */
    }
  }, [])

  const start = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setStatus('unavailable')
      setError('Ez a böngésző nem támogatja a helymeghatározást.')
      return
    }
    if (watchIdRef.current != null) return

    setStatus('requesting')
    setError(null)

    // Amíg az első valódi mérés meg nem jön, a legutóbbi ismert helyzet a
    // kiindulás — így a térkép nem a városközpontból indul, hogy aztán
    // odaugorjon hozzád.
    const cached = readLastFix()
    if (cached) {
      setPosition(cached)
      setStale(true)
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const fix: GeoPosition = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          at: pos.timestamp,
        }
        setPosition(fix)
        setStale(false)
        setStatus('watching')
        setError(null)
        try {
          localStorage.setItem(ENABLED_KEY, '1')
          localStorage.setItem(LAST_FIX_KEY, JSON.stringify(fix))
        } catch {
          /* nem kritikus */
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus('denied')
          setPosition(null)
          setStale(false)
          setError('A helymeghatározás le van tiltva ehhez az oldalhoz.')
          try {
            localStorage.removeItem(ENABLED_KEY)
            localStorage.removeItem(LAST_FIX_KEY)
          } catch {
            /* nem kritikus */
          }
        } else {
          setStatus('error')
          setError(
            err.code === err.TIMEOUT
              ? 'Nem sikerült időben megállapítani a helyzetedet.'
              : 'A helyzet jelenleg nem elérhető.'
          )
        }
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 }
    )
  }, [])

  /*
   * Korábban engedélyezett követés folytatása.
   *
   * Ahol van Permissions API, ott előbb megnézzük, hogy él-e még az engedély —
   * így biztosan nem ugrik fel kéretlen rendszerablak. Ahol nincs (iOS), ott
   * a mentett kapcsoló a jel: a felhasználó egyszer már igent mondott, és az
   * azonnali helyzetjelzés enélkül nem tudna elindulni.
   */
  useEffect(() => {
    let enabled = false
    try {
      enabled = localStorage.getItem(ENABLED_KEY) === '1'
    } catch {
      enabled = false
    }
    if (!enabled) return

    if (!('permissions' in navigator)) {
      start()
      return
    }

    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((res) => {
        if (res.state !== 'denied') start()
      })
      .catch(() => start())
  }, [start])

  useEffect(() => {
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current)
    }
  }, [])

  return { status, position, error, start, stop, isActive: status === 'watching', isStale }
}
