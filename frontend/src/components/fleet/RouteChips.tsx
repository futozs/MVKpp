import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { LiveVehicle, Route } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface RouteChipsProps {
  routes: Record<string, Route>
  selectedRoutes: string[]
  onToggleRoute: (routeId: string) => void
  onSetRoutes: (routeIds: string[]) => void
  liveVehicles: LiveVehicle[]
}

/**
 * Járatválasztó. A csempék a GTFS feed saját járatszíneit viselik — a szín
 * itt adat, nem dísz. A most nem futó járatok tompítva jelennek meg.
 */
export function RouteChips({
  routes,
  selectedRoutes,
  onToggleRoute,
  onSetRoutes,
  liveVehicles,
}: RouteChipsProps) {
  const [query, setQuery] = useState('')

  const liveCountByRoute = useMemo(() => {
    const counts: Record<string, number> = {}
    liveVehicles.forEach((v) => {
      counts[v.routeId] = (counts[v.routeId] || 0) + 1
    })
    return counts
  }, [liveVehicles])

  const ordered = useMemo(
    () =>
      Object.values(routes).sort((a, b) => {
        const na = parseInt(a.short, 10)
        const nb = parseInt(b.short, 10)
        if (!isNaN(na) && !isNaN(nb)) return na - nb || a.short.localeCompare(b.short, 'hu')
        return a.short.localeCompare(b.short, 'hu')
      }),
    [routes]
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ordered
    return ordered.filter(
      (r) => r.short.toLowerCase().includes(q) || (r.long && r.long.toLowerCase().includes(q))
    )
  }, [ordered, query])

  const selected = new Set(selectedRoutes)
  const runningRouteIds = Object.keys(liveCountByRoute).filter((id) => routes[id])

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          onClick={() => onSetRoutes(runningRouteIds)}
          disabled={runningRouteIds.length === 0}
        >
          Csak a futók ({runningRouteIds.length})
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          onClick={() => onSetRoutes(Object.keys(routes))}
        >
          Mind
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          onClick={() => onSetRoutes([])}
          disabled={selectedRoutes.length === 0}
        >
          Egy sem
        </Button>
      </div>

      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Járatszám vagy útvonal"
          aria-label="Járat keresése"
          className="h-8 pl-8 text-xs"
        />
      </div>

      <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">Nincs „{query}” jelzésű járat.</p>
        ) : (
          visible.map((route) => {
            const isOn = selected.has(route.id)
            const liveCount = liveCountByRoute[route.id] || 0
            const idle = liveCount === 0

            return (
              <button
                key={route.id}
                type="button"
                onClick={() => onToggleRoute(route.id)}
                aria-pressed={isOn}
                title={route.long || route.short}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md border px-2',
                  'text-xs font-bold tabular-nums tracking-tight',
                  'transition-all duration-fast',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  isOn && 'shadow-sm ring-1 ring-inset ring-black/20',
                  !isOn && !idle && 'border-border bg-secondary hover:border-primary/40 hover:bg-accent',
                  !isOn && idle && 'border-border/50 bg-transparent text-muted-foreground opacity-55 hover:opacity-100'
                )}
                style={
                  isOn
                    ? {
                        backgroundColor: `#${route.color || '1FB574'}`,
                        color: `#${route.text || 'FFFFFF'}`,
                        borderColor: `#${route.color || '1FB574'}`,
                      }
                    : undefined
                }
              >
                {!isOn ? (
                  <span
                    aria-hidden
                    className="h-3 w-1 shrink-0 rounded-full"
                    style={{ backgroundColor: `#${route.color || '888888'}` }}
                  />
                ) : null}

                <span>{route.short}</span>

                {liveCount > 0 ? (
                  <span
                    className={cn(
                      'rounded px-1 font-mono text-[10px] font-bold leading-none',
                      isOn ? 'bg-black/25' : 'bg-primary/15 text-primary'
                    )}
                  >
                    {liveCount}
                  </span>
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
