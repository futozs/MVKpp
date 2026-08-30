import { useEffect, useRef, useState } from 'react'
import type { GeoPosition } from '@/hooks/useGeolocation'
import { distanceKm, projectOntoPath } from '@/lib/geo'

export type ApproachState =
  /** Nincs helymeghatározás — nincs mihez viszonyítani. */
  | 'no-gps'
  /** A menetre nem jelentkezett be jármű. */
  | 'no-vehicle'
  /** Az útvonal nem jön a közelembe: csak légvonalbeli távolság van. */
  | 'off-route'
  /** A busz felém tart. */
  | 'inbound'
  /** A busz már elhaladt mellettem ezen az útvonalon. */
  | 'passed'

export interface Approach {
  state: ApproachState
  /** A busz és köztem lévő távolság kilométerben. */
  distanceKm: number | null
  /** Igaz, ha a távolság légvonalban értendő, nem az útvonalon mérve. */
  straightLine: boolean
  /** Hány perc múlva ér ide. `null`, ha nem becsülhető. */
  etaMin: number | null
  /** A becsléshez használt haladási sebesség. */
  speedKmh: number | null
}

/** Ennél messzebb az útvonaltól már nem mondható, hogy „erre jön”. */
const MAX_OFF_ROUTE_KM = 1.2
/** Ekkora körben a busz gyakorlatilag itt van. */
const HERE_KM = 0.05
/** Ennyi ideig nézünk vissza a haladási átlag számításához. */
const SPEED_WINDOW_MS = 180_000
/** Ennél rövidebb mintából még nem számolunk átlagot. */
const MIN_SPEED_SAMPLE_MS = 40_000
/** Városi busz átlaga megállásokkal együtt, ha más támpont nincs. */
const FALLBACK_KMH = 17
const MIN_KMH = 6
const MAX_KMH = 70

interface Sample {
  alongKm: number
  at: number
}

interface ApproachInput {
  /** A menet azonosítója: váltásakor a haladási előzmény nullázódik. */
  tripId: string | null
  shape: [number, number][] | undefined
  vehicle: { lat: number; lon: number; speed: number | null } | null
  position: GeoPosition | null
}

/**
 * Hány méterre van tőlem a busz, és mikor ér ide.
 *
 * A távolság az ÚTVONAL MENTÉN mért: a saját helyzetemet és a buszt is a
 * járat vonalgeometriájára vetítjük, és a kettő közti megtett úthosszt
 * nézzük. A légvonal ennél mindig kevesebb, és pont ott téved a legnagyobbat,
 * ahol számítana — kanyargós szakaszon vagy a folyó túloldalán.
 *
 * Az érkezésig hátralévő idő a busz SAJÁT, megfigyelt haladási átlagából jön
 * (nem a pillanatnyi sebességből): abban benne van a megállókban töltött idő
 * és a lámpák is, ezért nem ugrál minden fékezésre.
 */
export function useApproach({ tripId, shape, vehicle, position }: ApproachInput): Approach {
  const samplesRef = useRef<Sample[]>([])
  const tripRef = useRef<string | null>(null)
  const [avgKmh, setAvgKmh] = useState<number | null>(null)

  const usableShape = shape && shape.length >= 2 ? shape : null
  const busProjection =
    usableShape && vehicle ? projectOntoPath(usableShape, vehicle.lat, vehicle.lon) : null
  const busAlongKm = busProjection?.alongKm ?? null

  // Haladási átlag a vonal mentén megtett útból.
  useEffect(() => {
    if (tripRef.current !== tripId) {
      tripRef.current = tripId
      samplesRef.current = []
      setAvgKmh(null)
    }
    if (busAlongKm == null) return

    const now = Date.now()
    const samples = samplesRef.current
    const last = samples[samples.length - 1]
    if (!last || Math.abs(last.alongKm - busAlongKm) > 0.004 || now - last.at > 20_000) {
      samples.push({ alongKm: busAlongKm, at: now })
    }
    while (samples.length > 2 && now - samples[0].at > SPEED_WINDOW_MS) samples.shift()

    const first = samples[0]
    const elapsedMs = now - first.at
    const movedKm = busAlongKm - first.alongKm
    // Hátrafelé „haladás” = a vetítés ugrott egyet (hurkolt vonal, jelzavar);
    // ilyen mintából nem számolunk sebességet.
    setAvgKmh(
      elapsedMs >= MIN_SPEED_SAMPLE_MS && movedKm > 0
        ? (movedKm / elapsedMs) * 3_600_000
        : null
    )
  }, [tripId, busAlongKm])

  if (!position) {
    return { state: 'no-gps', distanceKm: null, straightLine: false, etaMin: null, speedKmh: null }
  }
  if (!vehicle) {
    return {
      state: 'no-vehicle',
      distanceKm: null,
      straightLine: false,
      etaMin: null,
      speedKmh: null,
    }
  }

  const crowKm = distanceKm(position.lat, position.lon, vehicle.lat, vehicle.lon)
  const myProjection = usableShape ? projectOntoPath(usableShape, position.lat, position.lon) : null

  // Nem esem az útvonalra: a vonal menti távolság félrevezető lenne, marad a
  // légvonal — és nem ígérünk érkezési időt olyasmire, ami nem jön felém.
  if (!myProjection || !busProjection || myProjection.distKm > MAX_OFF_ROUTE_KM) {
    return {
      state: 'off-route',
      distanceKm: crowKm,
      straightLine: true,
      etaMin: null,
      speedKmh: null,
    }
  }

  const remainingKm = myProjection.alongKm - busProjection.alongKm

  if (remainingKm < -HERE_KM) {
    return {
      state: 'passed',
      distanceKm: Math.abs(remainingKm),
      straightLine: false,
      etaMin: null,
      speedKmh: null,
    }
  }

  const instantKmh = vehicle.speed != null ? vehicle.speed * 3.6 : null
  const rawKmh = avgKmh ?? (instantKmh != null && instantKmh > 8 ? instantKmh : FALLBACK_KMH)
  const speedKmh = Math.min(MAX_KMH, Math.max(MIN_KMH, rawKmh))
  const distance = Math.max(0, remainingKm)

  return {
    state: 'inbound',
    distanceKm: distance,
    straightLine: false,
    etaMin: Math.round((distance / speedKmh) * 60),
    speedKmh,
  }
}
