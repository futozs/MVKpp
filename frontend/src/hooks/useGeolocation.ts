import { useCallback, useEffect, useRef, useState } from 'react'

export type GeoStatus = 'idle' | 'requesting' | 'watching' | 'denied' | 'unavailable' | 'error'

export interface GeoPosition {
  lat: number
  lon: number
  /** Vízszintes pontosság méterben — ebből rajzoljuk a bizonytalansági kört. */
  accuracyM: number
  at: number
}

const STORAGE_KEY = 'mvk_geo_enabled'

/**
 * Helymeghatározás a térképhez.
 *
 * Szándékosan nem indul magától: a böngésző engedélykérése csak
 * felhasználói gesztusra tisztességes, ezért a `start()` a GPS gombhoz
 * kötött. Ha korábban már engedélyezve volt, a következő megnyitáskor
 * magától folytatja a követést.
 */
export function useGeolocation() {
  const [status, setStatus] = useState<GeoStatus>('idle')
  const [position, setPosition] = useState<GeoPosition | null>(null)
  const [error, setError] = useState<string | null>(null)
  const watchIdRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    setStatus('idle')
    setPosition(null)
    try {
      localStorage.removeItem(STORAGE_KEY)
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

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          at: pos.timestamp,
        })
        setStatus('watching')
        setError(null)
        try {
          localStorage.setItem(STORAGE_KEY, '1')
        } catch {
          /* nem kritikus */
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus('denied')
          setError('A helymeghatározás le van tiltva ehhez az oldalhoz.')
          try {
            localStorage.removeItem(STORAGE_KEY)
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

  // Korábban engedélyezett követés folytatása — csak ha az engedély él,
  // hogy ne dobjunk fel kéretlen rendszerablakot induláskor.
  useEffect(() => {
    let enabled = false
    try {
      enabled = localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      enabled = false
    }
    if (!enabled || !('permissions' in navigator)) return

    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((res) => {
        if (res.state === 'granted') start()
      })
      .catch(() => {
        /* a Permissions API hiánya nem hiba, csak nem folytatjuk magától */
      })
  }, [start])

  useEffect(() => {
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current)
    }
  }, [])

  return { status, position, error, start, stop, isActive: status === 'watching' }
}

/** Két pont távolsága kilométerben. Közeli megállók kereséséhez. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLon = ((bLon - aLon) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
