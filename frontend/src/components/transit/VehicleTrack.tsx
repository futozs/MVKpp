import { Navigation, Radio } from 'lucide-react'
import type { ArrivalVehicle } from '@/types'
import { cn } from '@/lib/utils'

/**
 * „Melyik busz, és hol jár most.”
 *
 * A megállófigyelő két legfontosabb adata — ezért kap saját, kiemelt
 * felületet a kártyán belül, nem egy 10 pixeles lábjegyzetet. A rendszám
 * nagy monóval, a pozíció teljes méretű szöveggel olvasható.
 */
export function VehicleTrack({
  vehicle,
  progressDesc,
  onTrack,
  className,
}: {
  vehicle: ArrivalVehicle | null
  progressDesc?: string | null
  onTrack?: () => void
  className?: string
}) {
  if (!vehicle && !progressDesc) return null

  const speedKmh = vehicle?.speed != null ? Math.round(vehicle.speed * 3.6) : null
  const moving = speedKmh != null && speedKmh > 2

  return (
    <div
      className={cn(
        'rounded-lg border border-primary/25 bg-primary/[0.07] p-2 shadow-xs sm:p-3',
        className
      )}
    >
      {/* Telefonon egyetlen sűrű sor: rendszám · sebesség · hol jár.
          Nagyobb képernyőn kap saját feliratozott blokkokat. */}
      <div className="flex items-center gap-2 sm:hidden">
        <Radio aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
        {vehicle ? (
          <span className="font-mono text-base font-bold leading-none tabular-nums">
            {vehicle.id}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">nincs jármű</span>
        )}
        {speedKmh != null ? (
          <span
            className={cn(
              'shrink-0 font-mono text-xs font-semibold tabular-nums',
              moving ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {speedKmh} km/h
          </span>
        ) : null}
        {progressDesc ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {progressDesc}
          </span>
        ) : null}
        {onTrack && vehicle ? (
          <button
            type="button"
            onClick={onTrack}
            aria-label="Követés a térképen"
            className="shrink-0 rounded-md bg-primary/15 p-1.5 text-primary transition-colors duration-fast focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Navigation className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="hidden sm:block">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Radio aria-hidden className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Jármű
              </p>
              {vehicle ? (
                <p className="font-mono text-xl font-bold leading-tight tabular-nums text-foreground">
                  {vehicle.id}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Nincs hozzárendelve</p>
              )}
            </div>
          </div>

          {speedKmh != null ? (
            <div className="shrink-0 text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Sebesség
              </p>
              <p
                className={cn(
                  'font-mono text-xl font-bold leading-tight tabular-nums',
                  moving ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {speedKmh}
                <span className="ml-1 font-sans text-xs font-semibold text-muted-foreground">
                  km/h
                </span>
              </p>
            </div>
          ) : null}
        </div>

        {progressDesc ? (
          <p className="mt-2.5 flex items-start gap-2 border-t border-primary/15 pt-2.5 text-sm leading-snug text-foreground">
            <Navigation aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="min-w-0">{progressDesc}</span>
          </p>
        ) : null}

        {onTrack && vehicle ? (
          <button
            type="button"
            onClick={onTrack}
            className="mt-2.5 w-full rounded-md bg-primary/12 py-1.5 text-xs font-semibold text-primary transition-colors duration-fast hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Követés a térképen
          </button>
        ) : null}
      </div>
    </div>
  )
}
