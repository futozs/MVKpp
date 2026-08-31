import { useState, useEffect, useCallback } from "react";
import type {
  Stop,
  Route,
  LiveVehicle,
  GtfsMeta,
  ActiveTab,
  FilterState,
} from "@/types";
import { api } from "@/services/api";
import { Header } from "@/components/layout/Header";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { InstallBanner } from "@/components/layout/InstallBanner";
import { TransitMap } from "@/components/map/TransitMap";
import { MultiStopDashboard } from "@/components/multistop/MultiStopDashboard";
import { StopDetailDrawer } from "@/components/stops/StopDetailDrawer";
import { TimetableView } from "@/components/timetable/TimetableView";
import { StatsView } from "@/components/stats/StatsView";
import { MapSettingsModal } from "@/components/map/MapSettingsModal";
import { VehicleFocusCard } from "@/components/map/VehicleFocusCard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GeoProvider } from "@/context/GeoContext";
import { initialView, saveView } from "@/lib/viewState";
import { useAppHeight } from "@/hooks/useAppHeight";

const TAB_IDS: ActiveTab[] = ["map", "multistop", "timetable", "stats"];

/** A manifest gyorsindítói `#map`, `#timetable` stb. alakban nyitják az appot. */
function hashTab(): ActiveTab | null {
  if (typeof window === "undefined") return null;
  const id = window.location.hash.replace(/^#/, "");
  return (TAB_IDS as string[]).includes(id) ? (id as ActiveTab) : null;
}

const DEFAULT_FILTERS: FilterState = {
  vq: "",
  watch: [],
  routes: [],
  type: "all",
  speed: "all",
  nearMeKm: null,
  sort: "route",
  stops: true,
  onlyWatched: false,
  shape: true,
  rstops: false,
  labels: false,
  follow: false,
};

export function App() {
  useAppHeight();

  const restored = initialView();

  const [activeTab, setActiveTab] = useState<ActiveTab>(
    () => hashTab() ?? restored?.tab ?? "map",
  );
  const [stops, setStops] = useState<Stop[]>([]);
  const [routes, setRoutes] = useState<Record<string, Route>>({});
  const [gtfsMeta, setGtfsMeta] = useState<GtfsMeta | null>(null);
  const [liveVehicles, setLiveVehicles] = useState<LiveVehicle[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [tileLayerId, setTileLayerId] = useState<string>(
    () => localStorage.getItem("mvk_map_tile") || "osm",
  );
  const [isMapPickerOpen, setMapPickerOpen] = useState(false);

  const handleSelectTileLayer = (layerId: string) => {
    setTileLayerId(layerId);
    localStorage.setItem("mvk_map_tile", layerId);
  };

  const [selectedStopId, setSelectedStopId] = useState<string | null>(
    restored?.selectedStopId ?? null,
  );

  const [focusTripId, setFocusTripId] = useState<string | null>(
    restored?.focusTripId ?? null,
  );
  const [focusVehicleId, setFocusVehicleId] = useState<string | null>(
    restored?.focusVehicleId ?? null,
  );

  useEffect(() => {
    saveView({ tab: activeTab, selectedStopId, focusTripId, focusVehicleId });
  }, [activeTab, selectedStopId, focusTripId, focusVehicleId]);

  const [monitoredStopIds, setMonitoredStopIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("mvk_monitored_stops");
      return saved ? JSON.parse(saved) : ["SP1"];
    } catch {
      return ["SP1"];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        "mvk_monitored_stops",
        JSON.stringify(monitoredStopIds),
      );
    } catch {}
  }, [monitoredStopIds]);

  const [filters, setFilters] = useState<FilterState>(() => {
    try {
      const saved = localStorage.getItem("mvk_filter_state");
      return saved
        ? { ...DEFAULT_FILTERS, ...JSON.parse(saved) }
        : DEFAULT_FILTERS;
    } catch {
      return DEFAULT_FILTERS;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("mvk_filter_state", JSON.stringify(filters));
    } catch {}
  }, [filters]);

  useEffect(() => {
    const initGtfs = async () => {
      try {
        const [loadedStops, loadedRoutes, meta] = await Promise.all([
          api.getStops(),
          api.getRoutes(),
          api.getGtfsMeta(),
        ]);
        setStops(loadedStops);
        const rMap: Record<string, Route> = {};
        loadedRoutes.forEach((r) => (rMap[r.id] = r));
        setRoutes(rMap);
        setGtfsMeta(meta);
      } catch (err) {
        console.error("Failed to load GTFS static data:", err);
      }
    };

    initGtfs();
  }, []);

  const fetchLivePositions = useCallback(async () => {
    if (focusTripId) return;
    setIsRefreshing(true);
    try {
      const res = await api.getLivePositions();
      const valid = (res.vehicles || []).filter(
        (v) => v.lat != null && v.lon != null,
      );
      setLiveVehicles(valid);
      setLastUpdated(new Date());
    } catch (err) {
      console.warn("Live positions update failed:", err);
    } finally {
      setIsRefreshing(false);
    }
  }, [focusTripId]);

  useEffect(() => {
    fetchLivePositions();
    const posInterval = setInterval(fetchLivePositions, 3500);
    return () => clearInterval(posInterval);
  }, [fetchLivePositions]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") fetchLivePositions();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) refreshIfVisible();
    };

    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", refreshIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", refreshIfVisible);
    };
  }, [fetchLivePositions]);

  const handleClearFilters = () => {
    setFilters(DEFAULT_FILTERS);
  };

  const handleFocusStopOnMap = (
    stop: Stop,
    vehicleTripId?: string,
    vehicleId?: string,
  ) => {
    setSelectedStopId(stop.id);
    setActiveTab("map");
    if (vehicleTripId) {
      setFocusTripId(vehicleTripId);
      setFocusVehicleId(vehicleId ?? null);
    }
  };

  const handleFocusTrip = (tripId: string, vehicleId?: string) => {
    setFocusTripId(tripId);
    setFocusVehicleId(vehicleId ?? null);
  };

  const handleFocusTripOnMap = (tripId: string, vehicleId?: string) => {
    setActiveTab("map");
    handleFocusTrip(tripId, vehicleId);
  };

  const handleExitFocus = () => {
    setFocusTripId(null);
    setFocusVehicleId(null);
  };

  const handleToggleMonitorStop = (stopId: string) => {
    setMonitoredStopIds((prev) =>
      prev.includes(stopId)
        ? prev.filter((id) => id !== stopId)
        : [...prev, stopId],
    );
  };

  return (
    <GeoProvider>
      <TooltipProvider delayDuration={300}>
        <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
          {}
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

          <InstallBanner />

          {}
          <div className="flex-1 flex overflow-hidden relative">
            {}
            {activeTab === "map" && (
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
                  onOpenMapPicker={() => setMapPickerOpen(true)}
                />

                {}
                {focusTripId ? (
                  <VehicleFocusCard
                    tripId={focusTripId}
                    vehicleId={focusVehicleId}
                    stops={stops}
                    onClose={handleExitFocus}
                  />
                ) : null}

                {}
                <StopDetailDrawer
                  stopId={focusTripId ? null : selectedStopId}
                  stops={stops}
                  onClose={() => setSelectedStopId(null)}
                  onFocusTrip={handleFocusTrip}
                  monitoredStopIds={monitoredStopIds}
                  onToggleMonitorStop={handleToggleMonitorStop}
                />
              </div>
            )}

            {}
            {activeTab === "multistop" && (
              <MultiStopDashboard
                stops={stops}
                selectedStopIds={monitoredStopIds}
                setSelectedStopIds={setMonitoredStopIds}
                onFocusMap={handleFocusStopOnMap}
              />
            )}

            {}
            {}
            {activeTab === "stats" && (
              <StatsView
                stops={stops}
                routes={Object.values(routes)}
                onFocusVehicle={(id) => {
                  setFocusVehicleId(id);
                  setActiveTab("map");
                }}
              />
            )}

            {activeTab === "timetable" && (
              <TimetableView
                stops={stops}
                liveVehicles={liveVehicles}
                onFocusTrip={handleFocusTripOnMap}
                serviceRange={gtfsMeta?.serviceRange ?? null}
                archiveRange={gtfsMeta?.archiveRange ?? null}
              />
            )}
          </div>

          {}
          <MapSettingsModal
            isOpen={isMapPickerOpen}
            onClose={() => setMapPickerOpen(false)}
            currentLayerId={tileLayerId}
            onSelectLayer={handleSelectTileLayer}
          />
        </div>
      </TooltipProvider>
    </GeoProvider>
  );
}
export default App;
