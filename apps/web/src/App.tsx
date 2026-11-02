import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { ParkingView } from "@/components/parking/ParkingView";
import { RideLayer } from "@/components/ride/RideLayer";
import { getActiveRide, useActiveRide } from "@/lib/rides";
import { NotificationsModal } from "@/components/notifications/NotificationsModal";
import { AccountModal } from "@/components/account/AccountModal";
import { useCloudBackup } from "@/hooks/useCloudBackup";
import { FocusDock } from "@/components/map/FocusDock";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GeoProvider } from "@/context/GeoContext";
import { initialView, saveView } from "@/lib/viewState";
import { startUsage, trackView } from "@/lib/usage";
import { useAppHeight } from "@/hooks/useAppHeight";
import { useLiveIncidents } from "@/hooks/useLiveIncidents";
import { useStorageRefresh } from "@/hooks/useStorageRefresh";
import { realtime, useFallbackPoll, useTopic } from "@/lib/realtime";
import { feedOfId, isMergedTwin, modesParam, useEnabledModes, useStopMerge } from "@/lib/modes";
import { RegionalIntroBanner } from "@/components/layout/RegionalIntroBanner";
import { consumeInitialLink, OPEN_LINK_EVENT, parseLink, type ParsedLink } from "@/lib/deepLink";

// Értesítésből (vagy könyvjelzőből) nyitott hivatkozás: egyszer, betöltéskor olvassuk ki.
const INITIAL_LINK = typeof window === "undefined" ? null : consumeInitialLink();
/** az első indításkor figyelt megálló (amíg a felhasználó nem állít be sajátot) */
const DEFAULT_MONITORED = JSON.stringify(["SP1"]);
/** amíg a worker a Volán és a vasút menetrendjét építi, ennyi időnként kérjük újra a katalógust */
const REGIONAL_RETRY_MS = 45_000;

const DEFAULT_FILTERS: FilterState = {
  vq: "",
  watch: [],
  routes: [],
  modes: [],
  operators: [],
  railKinds: [],
  delay: "all",
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
  others: true,
};

/** Az elmentett szűrés a mostani alakra: a régi `type` (busz / villamos) a `modes` szűrővé válik. */
function migrateFilters(saved: Partial<FilterState> & { type?: string }): FilterState {
  const { type, ...rest } = saved;
  const modes = Array.isArray(rest.modes) ? rest.modes : type === "bus" ? (["bus"] as FilterState["modes"]) : type === "tram" ? (["tram"] as FilterState["modes"]) : [];
  return { ...DEFAULT_FILTERS, ...rest, modes };
}

export function App() {
  useAppHeight();
  const liveIncidentCount = useLiveIncidents();
  const activeRide = useActiveRide();
  // A bekapcsolt közlekedési módok (Beállítások): ezek megállói, vonalai és járművei töltődnek be.
  const enabledModes = useEnabledModes();
  const modesKey = modesParam(enabledModes);

  const restored = initialView();

  const [activeTab, setActiveTab] = useState<ActiveTab>(
    // Folyamatban lévő utazással (bezárt app után is) a térképen nyílik: ott zárul le, ha közben véget ért.
    () => INITIAL_LINK?.tab ?? (getActiveRide() ? "map" : restored?.tab) ?? "map",
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

  // Névtelen használati jel a rendszer-hubnak (nézetek, kedvencek).
  useEffect(() => startUsage(), []);
  useEffect(() => trackView(activeTab), [activeTab]);

  const [monitoredStopIds, setMonitoredStopIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("mvk_monitored_stops");
      return saved ? JSON.parse(saved) : ["SP1"];
    } catch {
      return ["SP1"];
    }
  });
  // a kikapcsolt mód megállói (pl. vasútállomás csak-MVK módban) nem számítanak a fül jelvényébe
  const shownMonitoredCount = monitoredStopIds.filter((id) => {
    const f = feedOfId(id);
    return f === "mvk" || enabledModes.includes(f);
  }).length;

  useEffect(() => {
    try {
      const next = JSON.stringify(monitoredStopIds);
      const cur = localStorage.getItem("mvk_monitored_stops");
      // Az indulási alapértéket nem mentjük: különben belépéskor valódi adatként kerülne a felhőbe,
      // és egy másik eszköz saját listáját írná felül. Változatlan értéket sem írunk újra.
      if (cur === next || (cur == null && next === DEFAULT_MONITORED)) return;
      localStorage.setItem("mvk_monitored_stops", next);
    } catch {}
  }, [monitoredStopIds]);
  // Értesítésből nyitott megálló: a Figyelőben elő is kerül (ha még nem figyelte, felvesszük —
  // különben a hivatkozás sehová sem vinne). Nyitott appnál a service worker üzen.
  const [linkStop, setLinkStop] = useState<{ id: string } | null>(null);
  const applyLink = useCallback((link: ParsedLink) => {
    if (link.tab) setActiveTab(link.tab);
    const id = link.stopId;
    if (!id) return;
    setMonitoredStopIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setLinkStop({ id });
  }, []);
  useEffect(() => {
    if (INITIAL_LINK?.stopId) applyLink(INITIAL_LINK);
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent<unknown>).detail;
      if (typeof url === "string") applyLink(parseLink(url));
    };
    const onWorker = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown } | null;
      if (d?.type === "mvk-open" && typeof d.url === "string") applyLink(parseLink(d.url));
    };
    window.addEventListener(OPEN_LINK_EVENT, onOpen);
    navigator.serviceWorker?.addEventListener("message", onWorker);
    return () => {
      window.removeEventListener(OPEN_LINK_EVENT, onOpen);
      navigator.serviceWorker?.removeEventListener("message", onWorker);
    };
  }, [applyLink]);

  // Közös megállók összevonva: a térképen és a keresőben a Volán-iker nem külön pötty
  // (az MVK-oszlop tábláján ott vannak a járatai), a figyelőben pedig a régi iker-
  // bejegyzés az MVK-oszlopra kerül — különben ugyanaz a tábla kétszer látszana.
  const stopMerge = useStopMerge();
  const mapStops = useMemo(() => (stopMerge === "off" ? stops : stops.filter((s) => !isMergedTwin(s, stopMerge))), [stops, stopMerge]);
  useEffect(() => {
    if (stopMerge === "off") return;
    const twinOf = new Map(stops.flatMap((s) => (s.twinOf ? [[s.id, s.twinOf] as const] : [])));
    if (!twinOf.size) return;
    setMonitoredStopIds((prev) => (prev.some((id) => twinOf.has(id)) ? [...new Set(prev.map((id) => twinOf.get(id) ?? id))] : prev));
  }, [stops, stopMerge]);

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
      return saved ? { ...migrateFilters(JSON.parse(saved)), vq: "" } : DEFAULT_FILTERS;
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
      if (saved && typeof saved === "object") setFilters(migrateFilters(saved));
    } catch {}
  });

  // A menetrend alapadatai. Gyenge térerőnél vagy a worker újraindulása alatt
  // az első kérés elbukhat — ilyenkor visszalépő várakozással újrapróbáljuk
  // (és hálózat-visszatéréskor azonnal), különben üres maradna a térkép.
  // A módok változásakor (Volán, vonat be/ki) újratöltődik.
  useEffect(() => {
    let alive = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let loaded = false;
    const initGtfs = async () => {
      if (loaded || !alive) return;
      try {
        const [loadedStops, loadedRoutes, meta] = await Promise.all([
          api.getStops(modesKey),
          api.getRoutes(modesKey),
          api.getGtfsMeta(),
        ]);
        if (!alive) return;
        loaded = true;
        setStops(loadedStops);
        const rMap: Record<string, Route> = {};
        loadedRoutes.forEach((r) => (rMap[r.id] = r));
        setRoutes(rMap);
        setGtfsMeta(meta);
        // A worker indulás után percekig építi a Volán és a vasút menetrendjét: addig a lista
        // csak MVK-s — újrakérjük, különben az állomások (Tiszai, Gömöri) újratöltésig hiányoznának.
        if (meta.regional === "pending" && /coach|rail/.test(modesKey)) {
          loaded = false;
          timer = setTimeout(initGtfs, REGIONAL_RETRY_MS);
        }
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
  }, [modesKey]);

  const fetchLivePositions = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const res = await api.getLivePositions(modesKey);
      const valid = (res.vehicles || []).filter(
        (v) => v.lat != null && v.lon != null,
      );
      // a „hol jár most” ugrások ebből keresnek — tartalék pollnál is legyen friss
      vehicleMap.current = new Map(valid.map((v) => [v.id, v]));
      setLiveVehicles(valid);
      setLastUpdated(new Date());
    } catch (err) {
      console.warn("Live positions update failed:", err);
    } finally {
      setIsRefreshing(false);
    }
  }, [modesKey]);

  // Élő járművek: a szerver WebSocketen küldi (induláskor a teljes listát,
  // utána csak a változott járműveket). Pollozás csak tartalékként, ha a
  // kapcsolat nem épül fel.
  // Menetkövetés (és utazás) közben is frissül: a fejléc száma és „utolsó adat”
  // ideje, a felszállás-felismerő és a Menetrend élő jelzései ebből dolgoznak.
  const vehicleMap = useRef(new Map<string, LiveVehicle>());
  // A téma a bekapcsolt módokat is hordozza: váltáskor a szerver a teljes új listát küldi.
  useTopic(`vehicles@${modesKey}`, (m) => {
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
    // Élő kapcsolatnál a WebSocket hozza a friss állapotot; a REST-pillanatkép (mozgásbecslés nélkül)
    // ilyenkor a buszokat a nyers jelhez rántaná vissza.
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible" && !realtime.connected) fetchLivePositions();
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

  // A menetrendből: ha a jármű azóta már másik menetet visz („ő vitte, hol jár most?”),
  // a mostani menetét követjük — különben a régi menet nyomvonala és adatai látszanának.
  const handleFocusTripOnMap = useCallback((tripId: string, vehicleId?: string) => {
    const now = vehicleId ? vehicleMap.current.get(vehicleId) : undefined;
    setActiveTab("map");
    setFocusTripId(now?.tripId || tripId);
    setFocusVehicleId(vehicleId ?? null);
  }, []);

  const [followPaused, setFollowPaused] = useState(false);

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
            monitoredStopsCount={shownMonitoredCount}
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
            monitoredStopsCount={shownMonitoredCount}
            liveIncidentCount={liveIncidentCount}
            onOpenNotifications={() => setNotificationsOpen(true)}
            onOpenAccount={() => setAccountOpen(true)}
          />

          <InstallBanner />
          <SyncBanner />
          <RegionalIntroBanner />

          {}
          <div className="flex-1 flex overflow-hidden relative">
            {}
            {activeTab === "map" && (
              <div className="flex-1 flex h-full w-full overflow-hidden relative">
                <TransitMap
                  stops={mapStops}
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
                  onFollowPausedChange={setFollowPaused}
                  tileLayerId={tileLayerId}
                  selectedStopId={selectedStopId}
                  monitoredStopIds={monitoredStopIds}
                  onToggleMonitorStop={handleToggleMonitorStop}
                  onSelectTileLayer={handleSelectTileLayer}
                  dock={Boolean(focusTripId) && !activeRide}
                />

                {}
                <RideLayer vehicles={liveVehicles} followingTripId={focusTripId} onFollow={handleFocusTrip} onStopFollow={handleExitFocus} />

                {focusTripId && !activeRide ? (
                  <FocusDock
                    tripId={focusTripId}
                    vehicleId={focusVehicleId}
                    stops={stops}
                    onClose={handleExitFocus}
                    followPaused={followPaused}
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
                focusStop={linkStop}
                onFocusTrip={handleFocusTripOnMap}
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
