import { createContext, useContext, type ReactNode } from 'react'
import { useGeolocation, type GeoState } from '@/hooks/useGeolocation'

const GeoContext = createContext<GeoState | null>(null)

/**
 * A helymeghatározás egyetlen, alkalmazás-szintű forrása.
 *
 * A térkép, a menetkövetés és a menetrendkönyv ugyanabból a `watchPosition`-ből
 * él: egy engedély, egy mérés, mindenhol ugyanaz a helyzet.
 */
export function GeoProvider({ children }: { children: ReactNode }) {
  const geo = useGeolocation()
  return <GeoContext.Provider value={geo}>{children}</GeoContext.Provider>
}

export function useGeo(): GeoState {
  const ctx = useContext(GeoContext)
  if (!ctx) throw new Error('A useGeo() csak GeoProvider-en belül használható.')
  return ctx
}
