import { useMemo } from 'react'
import { Clock } from 'lucide-react'
import type { LiveVehicle, TimetableTrip } from '@/types'
import { cn } from '@/lib/utils'

export interface HourRow {
  /** 0–29: a 24 fölötti órák az éjszakai menetek (GTFS így írja le őket). */
  hour: number
  trips: TimetableTrip[]
}

/** Menetek órákra bontva, ahogy a nyomtatott menetrendkönyv is rendezi. */
export function groupByHour(trips: TimetableTrip[]): HourRow[] {
  const map = new Map<number, TimetableTrip[]>()
  for (const t of trips) {
    const h = Math.floor(t.departureSec / 3600)
    let arr = map.get(h)
    if (!arr) map.set(h, (arr = []))
    arr.push(t)
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, list]) => ({
      hour,
      trips: list.sort((a, b) => a.departureSec - b.departureSec),
    }))
}

interface TimetableGridProps {
  trips: TimetableTrip[]
  vehicleByTrip: Map<string, LiveVehicle>
  selectedTripId: string | null
  onSelectTrip: (trip: TimetableTrip) => void
  /** Másodperc éjfél óta — ebből derül ki, melyik a következő indulás. */
  nowSec: number
}

/**
 * Menetrendkönyv-rács: soronként egy óra, azon belül a percek.
 *
 * Ugyanaz a szerkezet, mint a nyomtatott menetrendben és az MVK appban —
 * egy pillantással látszik, hogy egy órán belül mikor indul járat.
 * A zöld kitöltés azt jelenti, hogy arra a menetre már bejelentkezett busz.
 */
export function TimetableGrid({
  trips,
  vehicleByTrip,
  selectedTripId,
  onSelectTrip,
  nowSec,
}: TimetableGridProps) {
  const rows = useMemo(() => groupByHour(trips), [trips])

  /** A legközelebbi még el nem indult menet — ezt keretezzük ki. */
  const nextTripId = useMemo(() => {
    let best: TimetableTrip | null = null
    for (const t of trips) {
      if (t.departureSec < nowSec) continue
      if (!best || t.departureSec < best.departureSec) best = t
    }
    return best?.tripId ?? null
  }, [trips, nowSec])

  const currentHour = Math.floor(nowSec / 3600)

  return (
    <ul className="divide-y divide-border/60">
      {rows.map((row, rowIndex) => {
        const isCurrentHour = row.hour === currentHour
        return (
          <li
            key={row.hour}
            className={cn(
              'flex items-stretch gap-3 px-3 py-2 sm:px-4',
              rowIndex % 2 === 1 && 'bg-muted/25',
              isCurrentHour && 'bg-primary/[0.07]'
            )}
          >
            {/* Óra */}
            <span
              className={cn(
                'flex w-[68px] shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5',
                'font-mono text-base font-bold tabular-nums shadow-sm sm:w-[76px] sm:text-lg',
                isCurrentHour
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-primary/85 text-primary-foreground'
              )}
            >
              <Clock aria-hidden className="h-3.5 w-3.5 opacity-80" />
              {String(row.hour % 24).padStart(2, '0')}
            </span>

            {/* Percek */}
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {row.trips.map((trip) => {
                const vehicle = vehicleByTrip.get(trip.tripId) ?? null
                const isLive = vehicle !== null
                const isNext = trip.tripId === nextTripId
                const isSelected = trip.tripId === selectedTripId
                const isPast = trip.departureSec < nowSec && !isLive
                const minute = Math.floor((trip.departureSec % 3600) / 60)

                return (
                  <button
                    key={trip.tripId}
                    type="button"
                    onClick={() => onSelectTrip(trip)}
                    aria-pressed={isSelected}
                    title={
                      isLive
                        ? `${trip.destinationName} — ${vehicle.id} elindult`
                        : `${trip.destinationName} — érkezés ${trip.arrival}`
                    }
                    className={cn(
                      'relative flex h-9 min-w-[46px] items-center justify-center rounded-lg border px-2.5',
                      'font-mono text-sm font-semibold tabular-nums transition-all duration-fast',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      isLive
                        ? 'border-primary bg-primary text-primary-foreground'
                        : isSelected
                          ? 'border-primary bg-primary/15 text-foreground'
                          : isNext
                            ? 'border-primary bg-card text-foreground shadow-sm'
                            : isPast
                              ? 'border-transparent bg-muted/60 text-muted-foreground'
                              : 'border-border bg-card text-foreground hover:border-primary/50 hover:bg-accent'
                    )}
                  >
                    {String(minute).padStart(2, '0')}

                    {/* Betérő menet: apró jelölés, hogy más útvonalon megy. */}
                    {trip.deviates && !isLive ? (
                      <span
                        aria-hidden
                        className="absolute bottom-1 right-1 h-1 w-1 rounded-full bg-muted-foreground"
                      />
                    ) : null}
                  </button>
                )
              })}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
