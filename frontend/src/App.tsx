import { useState, useEffect, useCallback } from 'react'
import type {
  Stop,
  Route,
  LiveVehicle,
  GtfsMeta,
  ActiveTab,
  FilterState,
} from '@/types'
import { api } from '@/services/api'
import { Header } from '@/components/layout/Header'
import { MobileHeader } from '@/components/layout/MobileHeader'
import { TransitMap } from '@/components/map/TransitMap'
import { MultiStopDashboard } from '@/components/multistop/MultiStopDashboard'
import { StopDetailDrawer } from '@/components/stops/StopDetailDrawer'
import { TimetableView } from '@/components/timetable/TimetableView'
import { MapSettingsModal } from '@/components/map/MapSettingsModal'
import { TooltipProvider } from '@/components/ui/tooltip'

const DEFAULT_FILTERS: FilterState = {
  vq: '',
  watch: [],
  routes: [],
  type: 'all',
  moving: false,
  stops: true,
  shape: true,
  rstops: false,
  labels: false,
  follow: false,
}

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('map')
  const [stops, setStops] = useState<Stop[]>([])
  const [routes, setRoutes] = useState<Record<string, Route>>({})
  const [, setGtfsMeta] = useState<GtfsMeta | null>(null)
  const [liveVehicles, setLiveVehicles] = useState<LiveVehicle[]>([])
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Alaptérkép. Alapértelmezés az OpenStreetMap; a választás megjegyződik.
  const [tileLayerId, setTileLayerId] = useState<string>(
    () => localStorage.getItem('mvk_map_tile') || 'osm'
  )
  const [isMapPickerOpen, setMapPickerOpen] = useState(false)

  const handleSelectTileLayer = (layerId: string) => {
    setTileLayerId(layerId)
    localStorage.setItem('mvk_map_tile', layerId)
  }

  // Selected stop for details drawer
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null)

  // Focus specific bus trip on map
  const [focusTripId, setFocusTripId] = useState<string | null>(null)
  const [focusVehicleId, setFocusVehicleId] = useState<string | null>(null)

  // Persistent Monitored Stops for MultiStop Dashboard (max 6)
  const [monitoredStopIds, setMonitoredStopIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('mvk_monitored_stops')
      return saved ? JSON.parse(saved) : ['SP1']
    } catch {
      return ['SP1']
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('mvk_monitored_stops', JSON.stringify(monitoredStopIds))
    } catch {
      // ignore
    }
  }, [monitoredStopIds])

  // Persistent Filter State
  const [filters, setFilters] = useState<FilterState>(() => {
    try {
      const saved = localStorage.getItem('mvk_filter_state')
      return saved ? { ...DEFAULT_FILTERS, ...JSON.parse(saved) } : DEFAULT_FILTERS
    } catch {
      return DEFAULT_FILTERS
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('mvk_filter_state', JSON.stringify(filters))
    } catch {
      // ignore
    }
  }, [filters])

  // Initial GTFS Bootstrap
  useEffect(() => {
    const initGtfs = async () => {
      try {
        const [loadedStops, loadedRoutes, meta] = await Promise.all([
          api.getStops(),
          api.getRoutes(),
          api.getGtfsMeta(),
        ])
        setStops(loadedStops)
        const rMap: Record<string, Route> = {}
        loadedRoutes.forEach((r) => (rMap[r.id] = r))
        setRoutes(rMap)
        setGtfsMeta(meta)
      } catch (err) {
        console.error('Failed to load GTFS static data:', err)
      }
    }

    initGtfs()
  }, [])

  // Fast Live Positions Fetch (3.5 seconds polling)
  const fetchLivePositions = useCallback(async () => {
    if (focusTripId) return
    setIsRefreshing(true)
    try {
      const res = await api.getLivePositions()
      const valid = (res.vehicles || []).filter((v) => v.lat != null && v.lon != null)
      setLiveVehicles(valid)
      setLastUpdated(new Date())
    } catch (err) {
      console.warn('Live positions update failed:', err)
    } finally {
      setIsRefreshing(false)
    }
  }, [focusTripId])

  useEffect(() => {
    fetchLivePositions()
    const posInterval = setInterval(fetchLivePositions, 3500)
    return () => clearInterval(posInterval)
  }, [fetchLivePositions])

  const handleClearFilters = () => {
    setFilters(DEFAULT_FILTERS)
  }

  // Cross-component actions
  const handleFocusStopOnMap = (stop: Stop, vehicleTripId?: string, vehicleId?: string) => {
    setSelectedStopId(stop.id)
    setActiveTab('map')
    if (vehicleTripId) {
      setFocusTripId(vehicleTripId)
      setFocusVehicleId(vehicleId ?? null)
    }
  }

  const handleFocusTrip = (tripId: string, vehicleId?: string) => {
    setFocusTripId(tripId)
    setFocusVehicleId(vehicleId ?? null)
  }

  /** Menetrendből kijelölt menet: átvált a térképre és ráközelít a buszra. */
  const handleFocusTripOnMap = (tripId: string, vehicleId?: string) => {
    setActiveTab('map')
    handleFocusTrip(tripId, vehicleId)
  }

  const handleExitFocus = () => {
    setFocusTripId(null)
    setFocusVehicleId(null)
  }

  const handleToggleMonitorStop = (stopId: string) => {
    setMonitoredStopIds((prev) =>
      prev.includes(stopId) ? prev.filter((id) => id !== stopId) : [...prev, stopId]
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        {/* Státuszsín: navigáció, telemetria, eszközök */}
        <Header
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          vehicleCount={liveVehicles.length}
          lastUpdated={lastUpdated}
          isRefreshing={isRefreshing}
          onManualRefresh={fetchLivePositions}
          monitoredStopsCount={monitoredStopIds.length}
          onOpenMapPicker={() => setMapPickerOpen(true)}
        />
        <MobileHeader
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          vehicleCount={liveVehicles.length}
          lastUpdated={lastUpdated}
          isRefreshing={isRefreshing}
          onManualRefresh={fetchLivePositions}
          monitoredStopsCount={monitoredStopIds.length}
          onOpenMapPicker={() => setMapPickerOpen(true)}
        />

        {/* Munkaterület */}
        <div className="flex-1 flex overflow-hidden relative">
          {/* Forgalmi térkép + oldalsávi szűrés */}
          {activeTab === 'map' && (
            <div className="flex-1 flex h-full w-full overflow-hidden relative">
              <TransitMap
                stops={stops}
                routes={routes}
                vehicles={liveVehicles}
                filters={filters}
                setFilters={setFilters}
                onClearFilters={handleClearFilters}
                onSelectStop={(id) => setSelectedStopId(id)}
                focusTripId={focusTripId}
                focusVehicleId={focusVehicleId}
                onExitFocus={handleExitFocus}
                onFocusTrip={handleFocusTrip}
                tileLayerId={tileLayerId}
                selectedStopId={selectedStopId}
                monitoredStopIds={monitoredStopIds}
                onToggleMonitorStop={handleToggleMonitorStop}
              />

              {/* A térképen kiválasztott megálló indulásai */}
              <StopDetailDrawer
                stopId={selectedStopId}
                stops={stops}
                onClose={() => setSelectedStopId(null)}
                onFocusTrip={handleFocusTrip}
                monitoredStopIds={monitoredStopIds}
                onToggleMonitorStop={handleToggleMonitorStop}
              />
            </div>
          )}

          {/* Megállófigyelő (1–6 megálló) */}
          {activeTab === 'multistop' && (
            <MultiStopDashboard
              stops={stops}
              selectedStopIds={monitoredStopIds}
              setSelectedStopIds={setMonitoredStopIds}
              onFocusMap={handleFocusStopOnMap}
            />
          )}

          {/* Menetrendkönyv */}
          {activeTab === 'timetable' && (
            <TimetableView
              liveVehicles={liveVehicles}
              onFocusTrip={handleFocusTripOnMap}
            />
          )}
        </div>

        {/* Alaptérkép-választó */}
        <MapSettingsModal
          isOpen={isMapPickerOpen}
          onClose={() => setMapPickerOpen(false)}
          currentLayerId={tileLayerId}
          onSelectLayer={handleSelectTileLayer}
        />
      </div>
    </TooltipProvider>
  )
}
export default App
