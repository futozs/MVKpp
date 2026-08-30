import { useState } from 'react'
import {
  Activity,
  Bus,
  Clock,
  MapPinned,
  Route as RouteIcon,
  Wrench,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import type { Route, Stop } from '@/types'
import { OverviewPanel } from './OverviewPanel'
import { VehiclePanel } from './VehiclePanel'
import { IncidentPanel } from './IncidentPanel'
import { RoutePanel } from './RoutePanel'
import { StopPanel } from './StopPanel'
import { TravelTimePanel } from './TravelTimePanel'
import { NetworkPanel } from './NetworkPanel'
import { cn } from '@/lib/utils'

type PanelId = 'overview' | 'vehicle' | 'incident' | 'route' | 'stop' | 'travel' | 'network'

const PANELS: { id: PanelId; label: string; short: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Áttekintés', short: 'Áttek.', icon: Activity },
  { id: 'vehicle', label: 'Járművek', short: 'Járművek', icon: Bus },
  { id: 'incident', label: 'Üzemzavarok', short: 'Zavarok', icon: Wrench },
  { id: 'route', label: 'Vonalak', short: 'Vonalak', icon: RouteIcon },
  { id: 'stop', label: 'Megállók', short: 'Megállók', icon: MapPinned },
  { id: 'travel', label: 'Menetidő A→B', short: 'A→B', icon: Clock },
  { id: 'network', label: 'Hálózat', short: 'Hálózat', icon: TrendingUp },
]

/**
 * Statisztikai felület.
 *
 * Az adatraktárból építkezik, ami a valós idejű funkcióktól függetlenül is
 * lehet üres vagy elérhetetlen — ezért minden panel külön kezeli a „még nincs
 * elég adat" esetet, és sosem tesz úgy, mintha lenne.
 */
export function StatsView({
  stops,
  routes,
  onFocusVehicle,
}: {
  stops: Stop[]
  routes: Route[]
  onFocusVehicle?: (vehicleId: string) => void
}) {
  const [panel, setPanel] = useState<PanelId>('overview')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Panelválasztó — mobilon vízszintesen görgethető, nem tördelt kupac */}
      <nav
        aria-label="Statisztikai nézetek"
        className="shrink-0 overflow-x-auto border-b border-border bg-background/80 px-3 backdrop-blur-sm sm:px-4"
      >
        <ul className="flex min-w-max gap-1 py-2">
          {PANELS.map((p) => {
            const Icon = p.icon
            const active = panel === p.id
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setPanel(p.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">{p.label}</span>
                  <span className="sm:hidden">{p.short}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
          {panel === 'overview' && <OverviewPanel onJumpToVehicles={() => setPanel('vehicle')} />}
          {panel === 'vehicle' && <VehiclePanel onFocusVehicle={onFocusVehicle} />}
          {panel === 'incident' && <IncidentPanel />}
          {panel === 'route' && <RoutePanel routes={routes} />}
          {panel === 'stop' && <StopPanel stops={stops} />}
          {panel === 'travel' && <TravelTimePanel stops={stops} />}
          {panel === 'network' && <NetworkPanel />}
        </div>
      </div>
    </div>
  )
}
