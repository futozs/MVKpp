import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Clock, Crosshair, Search } from 'lucide-react'
import type {
  LiveVehicle,
  TimetableResponse,
  TimetableRoute,
  TimetableTrip,
} from '@/types'
import { api } from '@/services/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { RouteTile } from '@/components/transit/RouteTile'
import { LiveDot } from '@/components/transit/LiveDot'
import { cn } from '@/lib/utils'

interface TimetableViewProps {
  liveVehicles: LiveVehicle[]
  /** Kijelölt élő menet követése a térképen. */
  onFocusTrip: (tripId: string, vehicleId?: string) => void
}

/**
 * Menetrendkönyv.
 *
 * Bal oldalt a teljes GTFS járatlista, jobb oldalt a kiválasztott járat egy
 * irányának napi menetrendje. Zöld jel jelöli azokat a meneteket, amelyekre
 * már bejelentkezett egy jármű — azok egy kattintással követhetők a térképen.
 */
export function TimetableView({ liveVehicles, onFocusTrip }: TimetableViewProps) {
  const [routes, setRoutes] = useState<TimetableRoute[]>([])
  const [routesError, setRoutesError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null)
  const [selectedDir, setSelectedDir] = useState<string>('')
  const [table, setTable] = useState<TimetableResponse | null>(null)
  const [tableLoading, setTableLoading] = useState(false)
  const [openTripId, setOpenTripId] = useState<string | null>(null)

  /* A teljes járatkatalógus egyszer töltődik be. */
  useEffect(() => {
    api
      .getTimetableRoutes()
      .then((res) => {
        setRoutes(res.routes)
        setRoutesError(null)
      })
      .catch((err) => setRoutesError((err as Error).message))
  }, [])

  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? null

  /* Járat vagy irány váltásakor újratöltjük a menetrendet. */
  useEffect(() => {
    if (!selectedRouteId) {
      setTable(null)
      return
    }
    let alive = true
    setTableLoading(true)
    setOpenTripId(null)
    api
      .getTimetable(selectedRouteId, selectedDir)
      .then((res) => alive && setTable(res))
      .catch(() => alive && setTable(null))
      .finally(() => alive && setTableLoading(false))
    return () => {
      alive = false
    }
  }, [selectedRouteId, selectedDir])

  /** tripId -> a menetre bejelentkezett jármű. Ez adja a zöld jelzést. */
  const vehicleByTrip = useMemo(() => {
    const map = new Map<string, LiveVehicle>()
    liveVehicles.forEach((v) => {
      if (v.tripId) map.set(v.tripId, v)
    })
    return map
  }, [liveVehicles])

  const visibleRoutes = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return routes
    return routes.filter(
      (r) =>
        r.short.toLowerCase().includes(q) ||
        r.long.toLowerCase().includes(q) ||
        r.directions.some((d) => d.headsign.toLowerCase().includes(q))
    )
  }, [routes, query])

  const selectRoute = (route: TimetableRoute) => {
    setSelectedRouteId(route.id)
    // Az az irány nyíljon meg, amelyiken ma tényleg jár busz.
    const withService = route.directions.find((d) => d.tripsToday > 0) ?? route.directions[0]
    setSelectedDir(withService?.dir ?? '')
  }

  const liveTripCount = table?.trips.filter((t) => vehicleByTrip.has(t.tripId)).length ?? 0

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {/* Járatlista */}
      <aside className="flex w-[240px] shrink-0 flex-col overflow-hidden border-r border-border bg-card lg:w-[280px]">
        <div className="shrink-0 border-b border-border px-3 py-3">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Járat vagy végállomás"
              aria-label="Járat keresése"
              className="pl-9"
            />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {visibleRoutes.length} járat a menetrendben
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {routesError ? (
            <p
              role="alert"
              className="m-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {routesError}
            </p>
          ) : visibleRoutes.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Nincs „{query}” jelzésű járat.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {visibleRoutes.map((route) => {
                const isActive = route.id === selectedRouteId
                const runsToday = route.directions.some((d) => d.tripsToday > 0)
                return (
                  <li key={route.id}>
                    <button
                      type="button"
                      onClick={() => selectRoute(route)}
                      aria-pressed={isActive}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors duration-fast',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                        isActive ? 'bg-primary/10' : 'hover:bg-accent',
                        !runsToday && !isActive && 'opacity-55'
                      )}
                    >
                      <RouteTile short={route.short} color={route.color} text={route.text} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{route.long}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {runsToday
                            ? `${route.directions.reduce((n, d) => n + d.tripsToday, 0)} menet ma`
                            : 'Ma nem közlekedik'}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Menetrend */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selectedRoute ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <Card className="max-w-md p-8 text-center shadow-lg">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <Clock className="h-7 w-7" />
              </span>
              <h3 className="mt-4 text-lg font-bold tracking-tight">Válassz járatot</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                A bal oldali listából kiválasztott járat teljes napi menetrendje jelenik meg,
                irányonként. Zöld jel mutatja, melyik menetre jelentkezett már be busz.
              </p>
            </Card>
          </div>
        ) : (
          <>
            {/* Járatfej + iránykapcsoló */}
            <div className="shrink-0 border-b border-border bg-card/60 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <RouteTile
                  short={selectedRoute.short}
                  color={selectedRoute.color}
                  text={selectedRoute.text}
                  size="lg"
                />
                <div className="min-w-0">
                  <h2 className="truncate text-base font-bold tracking-tight">
                    {selectedRoute.long}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {table ? `${table.trips.length} menet ma` : 'Menetrend betöltése…'}
                    {liveTripCount > 0 ? (
                      <span className="ml-2 inline-flex items-center gap-1.5 font-semibold text-live">
                        <LiveDot />
                        {liveTripCount} elindult
                      </span>
                    ) : null}
                  </p>
                </div>
              </div>

              {/* Irány — a GTFS direction_id helyett a végállomás nevével. */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {selectedRoute.directions.map((d) => {
                  const isOn = d.dir === selectedDir
                  return (
                    <button
                      key={d.dir}
                      type="button"
                      onClick={() => setSelectedDir(d.dir)}
                      aria-pressed={isOn}
                      className={cn(
                        'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all duration-fast',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        isOn
                          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                          : 'border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                      <span className="max-w-[260px] truncate">{d.headsign || `Irány ${d.dir}`}</span>
                      <span
                        className={cn(
                          'rounded px-1 font-mono text-[10px] font-bold tabular-nums',
                          isOn ? 'bg-primary-foreground/20' : 'bg-muted'
                        )}
                      >
                        {d.tripsToday}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Indulások */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tableLoading ? (
                <p className="px-4 py-10 text-center font-mono text-xs text-muted-foreground">
                  Menetrend betöltése…
                </p>
              ) : !table || table.trips.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {table?.note ?? 'Ezen az irányon ma nem közlekedik járat.'}
                </p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {table.trips.map((trip) => (
                    <TripRow
                      key={trip.tripId}
                      trip={trip}
                      stops={table.stops}
                      vehicle={vehicleByTrip.get(trip.tripId) ?? null}
                      isOpen={openTripId === trip.tripId}
                      onToggle={() =>
                        setOpenTripId((prev) => (prev === trip.tripId ? null : trip.tripId))
                      }
                      onFocusTrip={onFocusTrip}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Egy menet sora: indulás, végállomás, élő jelzés, kinyitva a megállónkénti idők. */
function TripRow({
  trip,
  stops,
  vehicle,
  isOpen,
  onToggle,
  onFocusTrip,
}: {
  trip: TimetableTrip
  stops: TimetableResponse['stops']
  vehicle: LiveVehicle | null
  isOpen: boolean
  onToggle: () => void
  onFocusTrip: (tripId: string, vehicleId?: string) => void
}) {
  const isLive = vehicle !== null

  return (
    <li className={cn(isLive && 'bg-primary/[0.06]')}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        aria-expanded={isOpen}
        className={cn(
          'flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors duration-fast hover:bg-accent',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring'
        )}
      >
        {/* Zöld sáv jelzi, hogy erre a menetre már bejelentkezett busz. */}
        <span
          aria-hidden
          className={cn(
            'h-9 w-1 shrink-0 rounded-full',
            isLive ? 'bg-primary' : 'bg-transparent'
          )}
        />

        <span className="w-14 shrink-0 font-mono text-lg font-bold tabular-nums">
          {trip.departure}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{trip.destinationName}</span>
          <span className="block font-mono text-[11px] tabular-nums text-muted-foreground">
            érkezés {trip.arrival} · {trip.stopCount} megálló
            {trip.deviates ? ' · betérő' : ''}
          </span>
        </span>

        {isLive ? (
          <span className="flex shrink-0 items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-md bg-primary/15 px-2 py-1">
              <LiveDot />
              <span className="font-mono text-xs font-bold tabular-nums text-primary">
                {vehicle.id}
              </span>
            </span>
            <Button
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                onFocusTrip(trip.tripId, vehicle.id)
              }}
            >
              <Crosshair />
              Térképen
            </Button>
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">nem indult el</span>
        )}
      </div>

      {/* Megállónkénti idők */}
      {isOpen ? (
        <div className="border-t border-border/60 bg-muted/25 px-4 py-3">
          <ol className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {stops.map((stop, i) => {
              const time = trip.times[i]
              if (!time) return null
              return (
                <li
                  key={stop.id}
                  className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1"
                >
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {stop.name}
                  </span>
                  <span className="shrink-0 font-mono text-xs font-semibold tabular-nums">
                    {time}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      ) : null}
    </li>
  )
}
