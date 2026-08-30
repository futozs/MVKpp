import { useEffect, useState } from 'react'
import type { WeatherResponse } from '@/types'
import { api } from '@/services/api'

/** A backend tíz percig gyorsítótáraz, itt elég negyedóránként kérdezni. */
const POLL_MS = 15 * 60 * 1000

/**
 * Aktuális miskolci hőmérséklet a fejlécbe.
 *
 * Hiba esetén csendben `null`-t ad: az időjárás kiegészítő információ, egy
 * elérhetetlen külső szolgáltató nem törheti meg a forgalmi pultot.
 */
export function useWeather() {
  const [weather, setWeather] = useState<WeatherResponse | null>(null)

  useEffect(() => {
    let alive = true

    const load = () => {
      api
        .getWeather()
        .then((res) => alive && setWeather(res))
        .catch(() => {
          /* az időjárás nélkül is működik a pult */
        })
    }

    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return weather
}
