import { useState, useEffect, useCallback, useRef } from "react";
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
import { SyncBanner } from "@/components/layout/SyncBanner";
import { TransitMap } from "@/components/map/TransitMap";
import { MultiStopDashboard } from "@/components/multistop/MultiStopDashboard";
import { StopDetailDrawer } from "@/components/stops/StopDetailDrawer";
import { TimetableView } from "@/components/timetable/TimetableView";
import { RoutePlannerView } from "@/components/routeplanner/RoutePlannerView";
import { StatsView } from "@/components/stats/StatsView";
import { RideLayer } from "@/components/ride/RideLayer";
import { useActiveRide } from "@/lib/rides";
import { ParkingView } from "@/components/parking/ParkingView";
import { NotificationsModal } from "@/components/notifications/NotificationsModal";
import { AccountModal } from "@/components/account/AccountModal";
import { useCloudBackup } from "@/hooks/useCloudBackup";
import { VehicleFocusCard } from "@/components/map/VehicleFocusCard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GeoProvider } from "@/context/GeoContext";
import { initialView, saveView } from "@/lib/viewState";
import { useAppHeight } from "@/hooks/useAppHeight";
import { useLiveIncidents } from "@/hooks/useLiveIncidents";
import { useStorageRefresh } from "@/hooks/useStorageRefresh";
import { useFallbackPoll, useTopic } from "@/lib/realtime";

const TAB_IDS: ActiveTab[] = [
  "map",
  "multistop",
  "timetable",
  "parking",
  "planner",
  "stats",
];

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
  traffic: true,
};

export function App() {
  useAppHeight();
  const liveIncidentCount = useLiveIncidents();
  const activeRide = useActiveRide();

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
  const [isNotificationsOpen, setNotificationsOpen] = useState(false);
  const [isAccountOpen, setAccountOpen] = useState(false);
  const [isDisruptionsOpen, setDisruptionsOpen] = useState(false);
  useCloudBackup();

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
  // Másik eszközről szinkronizált figyelt megállók: azonnal átvesszük.
  useStorageRefresh("mvk_monitored_stops", () => {
    try {
      const saved = JSON.parse(localStorage.getItem("mvk_monitored_stops") ?? "null");
      if (Array.isArray(saved)) setMonitoredStopIds(saved.filter((x): x is string => typeof x === "string"));
    } catch {}
  });

  const [filters, setFilters] = useState<FilterState>(() => {
    try {
      const saved = localStorage.getItem("mvk_filter_state");
      // A régi, gépelés közbeni rendszám-keresés (vq) nem marad bent: már nincs hozzá mező,
      // így egy elmentett érték láthatatlanul szűrné a térképet.
      return saved
        ? { ...DEFAULT_FILTERS, ...JSON.parse(saved), vq: "" }
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
  useStorageRefresh("mvk_filter_state", () => {
    try {
      const saved = JSON.parse(localStorage.getItem("mvk_filter_state") ?? "null");
      if (saved && typeof saved === "object") setFilters({ ...DEFAULT_FILTERS, ...saved });
    } catch {}
  });

  // A menetrend alapadatai. Gyenge térerőnél vagy a worker újraindulása alatt
  // az első kérés elbukhat — ilyenkor visszalépő várakozással újrapróbáljuk
  // (és hálózat-visszatéréskor azonnal), különben üres maradna a térkép.
  useEffect(() => {
    let alive = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let loaded = false;
    const initGtfs = async () => {
      if (loaded || !alive) return;
      try {
        const [loadedStops, loadedRoutes, meta] = await Promise.all([
          api.getStops(),
          api.getRoutes(),
          api.getGtfsMeta(),
        ]);
        if (!alive) return;
        loaded = true;
        setStops(loadedStops);
        const rMap: Record<string, Route> = {};
        loadedRoutes.forEach((r) => (rMap[r.id] = r));
        setRoutes(rMap);
        setGtfsMeta(meta);
      } catch (err) {
        console.warn("A menetrend alapadatai nem töltődtek be, újrapróbálom:", err);
        if (!alive) return;
        attempt++;
        timer = setTimeout(initGtfs, Math.min(30_000, 1500 * 2 ** Math.min(attempt, 5)));
      }
    };
    const retryNow = () => {
      if (loaded) return;
      if (timer) clearTimeout(timer);
      void initGtfs();
    };

    void initGtfs();
    window.addEventListener("online", retryNow);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", retryNow);
    };
  }, []);

  const fetchLivePositions = useCallback(async () => {
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
  }, []);

  // Élő járművek: a szerver WebSocketen küldi (induláskor a teljes listát,
  // utána csak a változott járműveket). Pollozás csak tartalékként, ha a
  // kapcsolat nem épül fel.
  // Menetkövetés (és utazás) közben is frissül: a fejléc száma és „utolsó adat”
  // ideje, a felszállás-felismerő és a Menetrend élő jelzései ebből dolgoznak.
  const vehicleMap = useRef(new Map<string, LiveVehicle>());
  useTopic("vehicles", (m) => {
    if (Array.isArray(m.full)) {
      vehicleMap.current = new Map((m.full as LiveVehicle[]).map((v) => [v.id, v]));
    } else {
      for (const v of (m.upd as LiveVehicle[]) ?? []) vehicleMap.current.set(v.id, v);
      for (const id of (m.del as string[]) ?? []) vehicleMap.current.delete(id);
    }
    setLiveVehicles([...vehicleMap.current.values()].filter((v) => v.lat != null && v.lon != null));
    setLastUpdated(new Date());
  });
  useFallbackPoll(fetchLivePositions, 3500);

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

  // Stabil azonosítójú kezelők: a térkép effektjei ezekre is figyelnek, és egy
  // minden rendereléskor új függvény miatt minden járműfrissítéskor újraépülne
  // az összes (~600) megálló-jelölő.
  const handleFocusTrip = useCallback((tripId: string, vehicleId?: string) => {
    setFocusTripId(tripId);
    setFocusVehicleId(vehicleId ?? null);
  }, []);

  const handleFocusTripOnMap = useCallback((tripId: string, vehicleId?: string) => {
    setActiveTab("map");
    setFocusTripId(tripId);
    setFocusVehicleId(vehicleId ?? null);
  }, []);

  const handleExitFocus = useCallback(() => {
    setFocusTripId(null);
    setFocusVehicleId(null);
  }, []);

  const handleSelectStop = useCallback((id: string) => setSelectedStopId(id), []);

  const handleToggleMonitorStop = useCallback((stopId: string) => {
    setMonitoredStopIds((prev) =>
      prev.includes(stopId)
        ? prev.filter((id) => id !== stopId)
        : [...prev, stopId],
    );
  }, []);

  // „Élőben a térképen” (Statisztika, Parkoló): ha a jármű épp menetet visz, azt
  // követjük; különben kiemelve megkeressük a térképen.
  const handleFocusVehicleOnMap = useCallback((vehicleId: string) => {
    const v = vehicleMap.current.get(vehicleId);
    setActiveTab("map");
    if (v?.tripId) {
      setFocusTripId(v.tripId);
      setFocusVehicleId(vehicleId);
      return;
    }
    setFocusTripId(null);
    setFocusVehicleId(null);
    setFilters((f) => ({ ...f, watch: f.watch.includes(vehicleId) ? f.watch : [...f.watch, vehicleId], vq: "" }));
  }, []);

  return (
    <GeoProvider>
      <TooltipProvider>
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
            liveIncidentCount={liveIncidentCount}
            onOpenNotifications={() => setNotificationsOpen(true)}
            onOpenAccount={() => setAccountOpen(true)}
          />
          <MobileHeader
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            vehicleCount={liveVehicles.length}
            lastUpdated={lastUpdated}
            isRefreshing={isRefreshing}
            onManualRefresh={fetchLivePositions}
            monitoredStopsCount={monitoredStopIds.length}
            liveIncidentCount={liveIncidentCount}
            onOpenNotifications={() => setNotificationsOpen(true)}
            onOpenAccount={() => setAccountOpen(true)}
          />

          <InstallBanner />
          <SyncBanner />

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
                  onSelectStop={handleSelectStop}
                  focusTripId={focusTripId}
                  focusVehicleId={focusVehicleId}
                  onExitFocus={handleExitFocus}
                  onFocusTrip={handleFocusTrip}
                  tileLayerId={tileLayerId}
                  selectedStopId={selectedStopId}
                  monitoredStopIds={monitoredStopIds}
                  onToggleMonitorStop={handleToggleMonitorStop}
                  onSelectTileLayer={handleSelectTileLayer}
                />

                {}
                <RideLayer vehicles={liveVehicles} onFollow={handleFocusTrip} onStopFollow={handleExitFocus} />

                {focusTripId && !activeRide ? (
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
                liveIncidents={liveIncidentCount}
                onOpenDisruptions={() => {
                  setDisruptionsOpen(true);
                  setActiveTab("timetable");
                }}
                onFocusVehicle={handleFocusVehicleOnMap}
              />
            )}

            {activeTab === "timetable" && (
              <TimetableView
                stops={stops}
                liveVehicles={liveVehicles}
                onFocusTrip={handleFocusTripOnMap}
                serviceRange={gtfsMeta?.serviceRange ?? null}
                archiveRange={gtfsMeta?.archiveRange ?? null}
                disruptionsOpen={isDisruptionsOpen}
                onDisruptionsOpenChange={setDisruptionsOpen}
              />
            )}

            {activeTab === "parking" && (
              <ParkingView
                routes={Object.values(routes)}
                onFocusVehicle={handleFocusVehicleOnMap}
              />
            )}

            {activeTab === "planner" && <RoutePlannerView stops={stops} />}
          </div>


          <NotificationsModal
            isOpen={isNotificationsOpen}
            onClose={() => setNotificationsOpen(false)}
          />

          <AccountModal
            isOpen={isAccountOpen}
            onClose={() => setAccountOpen(false)}
          />
        </div>
      </TooltipProvider>
    </GeoProvider>
  );
}
export default App;
