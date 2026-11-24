import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Box, Crosshair, History, LocateFixed, Minus, Plus, RotateCw, SlidersHorizontal, X } from "lucide-react";
import type { FilterState, LiveVehicle, Route, Stop, TripPathResponse } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { distanceKm, nearest } from "@/lib/geo";
import { initialMapView, saveMapView } from "@/lib/viewState";
import { cn, normalizeSearchText } from "@/lib/utils";
import { MapTimeline } from "./MapTimeline";
import { safeHex, vehicleIdText } from "./vehicleIcon";
import { useLiveTraffic } from "./liveTraffic";
import { useRouteShapes } from "./useRouteShapes";
import { api } from "@/services/api";
import { MapControl, MapControlGroup, MapCorner, MapGroupButton } from "./controls/MapControl";
import { MapLayersControl } from "./controls/MapLayersControl";
import { MapSearch } from "./controls/MapSearch";
import { NewsButton } from "@/components/news/NewsButton";
import { FilterPanel } from "./filter/FilterPanel";
import { activeFilterCount, filterSummary, matchesModeFilters, MAX_WATCHED } from "./filter/filterState";
import { isRegionalId, vehicleModeOf } from "@/lib/modes";
import { lookById } from "./gl/looks";
import { prewarmMap } from "./gl/engine";
import { refreshPack } from "./gl/mapPack";
import type { FocusSpec, LiveMapHandle, MapView } from "./gl/LiveMap";

/** A térképmotor (MapLibre) külön csomag: a lap többi része nem vár rá. */
const LiveMap = lazy(() => import("./gl/LiveMap").then((m) => ({ default: m.LiveMap })));

/** a szűrőpanel nyitott állapota asztalon (eszközönként) */
const PANEL_KEY = "mvk_map_panel";
/** a 3D nézet bekapcsolva (eszközönként) */
const MAP_3D_KEY = "mvk_map_3d";

/** nincs kiválasztott vonal (állandó, hogy a nyomvonal-hook ne fusson újra) */
const NO_ROUTES: string[] = [];
const NO_VEHICLES: LiveVehicle[] = [];
const NO_STOPS: Stop[] = [];
/** Miskolc belváros, ha még nincs mentett nézet */
const DEFAULT_VIEW: MapView = { lat: 48.104, lon: 20.79, zoom: 12 };

/** nagyítások (MapLibre-skála, 512 px-es csempék) */
const NEAR_STOP_KM = 0.4;
const CLOSE_ZOOM = 16;
const ME_ZOOM = 15;
const VEHICLE_ZOOM = 15;
const WATCH_ZOOM = 14;

interface TransitMapProps {
  stops: Stop[];
  routes: Record<string, Route>;
  vehicles: LiveVehicle[];
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  onClearFilters: () => void;
  onSelectStop: (stopId: string) => void;
  focusTripId: string | null;
  focusVehicleId: string | null;
  onExitFocus: () => void;
  onFocusTrip: (tripId: string, vehicleId?: string) => void;
  /** követés közben a felhasználó elhúzta a térképet (a kártya felirata ezt mutatja) */
  onFollowPausedChange?: (paused: boolean) => void;
  tileLayerId: string;
  selectedStopId: string | null;
  monitoredStopIds: string[];
  onToggleMonitorStop: (stopId: string) => void;
  onSelectTileLayer: (layerId: string) => void;
  /**
   * Kint van a követés panelje (FocusDock): asztalon jobb oldalt a teljes magasságban
   * (menetrend + kártya)  a jobb oldali gombok mellé húzódnak.
   */
  dock?: boolean;
}

/** a FocusDock asztalon: jobb margó + szélesség + köz (px) */
const DOCK_INSET = "md:right-[408px]";

type Credit = { text: string; href: string };
const CREDIT_OSM: Credit = { text: "© OpenStreetMap", href: "https://www.openstreetmap.org/copyright" };
const CREDIT_PROTOMAPS: Credit = { text: "Protomaps", href: "https://protomaps.com" };
const CREDIT_DEM: Credit = { text: "Mapterhorn", href: "https://mapterhorn.com/attribution" };
const CREDIT_ESRI: Credit = { text: "Esri, Vantor", href: "https://www.esri.com/" };

export function TransitMap({
  stops,
  routes,
  vehicles,
  filters,
  setFilters,
  onClearFilters,
  onSelectStop,
  focusTripId,
  focusVehicleId,
  onExitFocus,
  onFocusTrip,
  onFollowPausedChange,
  tileLayerId,
  selectedStopId,
  monitoredStopIds,
  onToggleMonitorStop,
  onSelectTileLayer,
  dock = false,
}: TransitMapProps) {
  const liveRef = useRef<LiveMapHandle | null>(null);
  const [focusPath, setFocusPath] = useState<TripPathResponse | null>(null);
  const [followPaused, setFollowPaused] = useState(false);
  const lastFocusKeyRef = useRef<string>("");

  // A szűrőpanel asztalon nyitva maradhat (eszközönként megjegyezzük); telefonon mindig zárva indul.
  const [isPanelOpen, setPanelOpenState] = useState(() => {
    try {
      return window.matchMedia("(min-width: 768px)").matches && localStorage.getItem(PANEL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setPanelOpen = (open: boolean) => {
    setPanelOpenState(open);
    try {
      if (window.matchMedia("(min-width: 768px)").matches) localStorage.setItem(PANEL_KEY, open ? "1" : "0");
    } catch {
      /* privát mód */
    }
  };
  const geo = useGeo();
  const autoZoomRef = useRef<"none" | "stale" | "done">("none");

  // Idővonal: amíg él, az élő járművek helyett a visszajátszás látszik.
  const [historyOn, setHistoryOn] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [timelineInset, setTimelineInset] = useState(0);

  // 3D nézet (eszközönként megjegyezve): ugyanaz a térkép, megdöntve.
  const [is3d, setIs3dState] = useState(() => {
    try {
      return localStorage.getItem(MAP_3D_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setIs3d = (on: boolean) => {
    setIs3dState(on);
    setFollowPaused(false);
    try {
      localStorage.setItem(MAP_3D_KEY, on ? "1" : "0");
    } catch {
      /* privát mód */
    }
  };

  // A motor a lap betöltése után, tétlen időben előmelegszik (a worker elindul).
  useEffect(() => prewarmMap(), []);

  /** A térkép nem indult el: nincs WebGL2, vagy nem jön a csempekészlet. Újrapróbáláskor újra felépül. */
  const [mapError, setMapError] = useState<"webgl" | "tiles" | null>(null);
  /** a térkép betöltött: a kamera mozdulatai mostantól hatnak (előtte elvesznének) */
  const [mapReady, setMapReady] = useState(false);
  const onMapReady = useCallback(() => setMapReady(true), []);
  const [mapKey, setMapKey] = useState(0);
  const onMapFail = useCallback((reason: "webgl" | "tiles") => setMapError(reason), []);
  const retryMap = () => {
    setMapError(null);
    setMapReady(false);
    setMapKey((k) => k + 1);
  };

  // a korábban letöltött offline csomag az új csempekészlethez (ha lehet, csendben)
  useEffect(() => {
    if (mapReady) void refreshPack().catch(() => undefined);
  }, [mapReady]);

  const onMapView = useCallback((v: MapView) => saveMapView(v), []);
  const [initialView] = useState<MapView>(() => initialMapView() ?? DEFAULT_VIEW);

  const camera = {
    zoom: () => liveRef.current?.view()?.zoom ?? DEFAULT_VIEW.zoom,
    flyTo: (lat: number, lon: number, zoom: number) => liveRef.current?.flyTo(lat, lon, zoom),
    fitBounds: (points: [number, number][], maxZoom: number, padding?: number) => liveRef.current?.fitBounds(points, maxZoom, padding),
  };

  const openHistory = () => {
    if (focusTripId) onExitFocus();
    setPanelOpen(false);
    setHistoryOn(true);
  };

  // Ha máshonnan menetkövetés indul, az élő nézet kell  kilépünk.
  useEffect(() => {
    if (focusTripId) setHistoryOn(false);
  }, [focusTripId]);

  const getVisibleVehicles = () => {
    const q = normalizeSearchText(filters.vq.trim());
    const watchList = filters.watch.map((w) => normalizeSearchText(w));

    if (watchList.length > 0 || q) {
      const targets = [...watchList];
      if (q && !targets.includes(q)) targets.push(q);
      return vehicles.filter((v) => {
        // rendszám (Volán: LWA387), vonatszám (5139) vagy MVK-azonosító
        const keys = [v.id, v.label, v.plate, v.trainNo].filter(Boolean).map((x) => normalizeSearchText(String(x)));
        return targets.some((t) => keys.some((k) => k.includes(t)));
      });
    }

    let list = vehicles.filter((v) => matchesModeFilters(v, filters, routes));

    if (filters.routes.length > 0) {
      const routeSet = new Set(filters.routes);
      list = list.filter((v) => routeSet.has(v.routeId));
    }

    if (filters.speed === "moving") list = list.filter((v) => (v.speed || 0) > 0.5);
    else if (filters.speed === "idle") list = list.filter((v) => (v.speed || 0) <= 0.5);

    if (filters.nearMeKm != null && geo.position) {
      const { lat, lon } = geo.position;
      list = list.filter((v) => v.lat != null && v.lon != null && distanceKm(lat, lon, v.lat, v.lon) <= filters.nearMeKm!);
    }

    return list;
  };

  const focusOnMe = useCallback(() => {
    if (!geo.position) return;
    const { lat, lon } = geo.position;
    const hit = nearest(stops, lat, lon);
    if (hit && hit.km <= NEAR_STOP_KM && hit.item.lat != null && hit.item.lon != null) {
      camera.fitBounds(
        [
          [lat, lon],
          [hit.item.lat, hit.item.lon],
        ],
        CLOSE_ZOOM,
        80,
      );
      return;
    }
    camera.flyTo(lat, lon, ME_ZOOM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo.position, stops]);

  // A helymeghatározás magától indul a betöltéskor; ha a felhasználó
  // letiltotta, ne köszönjön vissza minden megnyitáskor egy hibasáv. Csak
  // akkor mondjuk el, ha ő maga kérte a helyzetét.
  const [geoAsked, setGeoAsked] = useState(false);

  const handleLocate = () => {
    setGeoAsked(true);
    if (!geo.position) {
      geo.start();
      return;
    }
    focusOnMe();
  };

  useEffect(() => {
    if (autoZoomRef.current === "done" || !mapReady) return;
    if (!geo.position || stops.length === 0) return;
    if (focusTripId) {
      autoZoomRef.current = "done";
      return;
    }
    if (geo.isStale) {
      if (autoZoomRef.current === "none") {
        focusOnMe();
        autoZoomRef.current = "stale";
      }
      return;
    }
    focusOnMe();
    autoZoomRef.current = "done";
  }, [geo.position, geo.isStale, stops, focusTripId, focusOnMe, mapReady]);

  // A kiválasztott vonalak nyomvonala (a letöltés közben kikapcsolt vonal nem marad kint).
  const routeShapes = useRouteShapes(filters.shape ? filters.routes : NO_ROUTES);
  const routeLines = useMemo(() => [...routeShapes].map(([id, lines]) => ({ color: `#${routes[id]?.color || "1FB574"}`, lines })), [routeShapes, routes]);

  // Élő forgalom: a most torlódott szakaszok citromsárgától sötétvörösig (félpercenként frissül).
  const traffic = useLiveTraffic(filters.traffic && !historyOn);

  // Amikor a kijelölt megálló máshonnan (megállófigyelő "cél a térképen"
  // gombja, keresés) érkezik, a térkép ugorjon is oda.
  useEffect(() => {
    if (!mapReady || !selectedStopId) return;
    const stop = stops.find((s) => s.id === selectedStopId);
    if (!stop) return;
    camera.flyTo(stop.lat, stop.lon, Math.max(camera.zoom(), CLOSE_ZOOM));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStopId, mapReady]);

  // A figyelt rendszámokra (keresésre) a térkép odaugrik  követés közben nem: a térkép a buszé.
  useEffect(() => {
    if (historyOn || !mapReady) return;
    const activeQ = filters.vq.trim().toLowerCase();
    if (focusTripId || (filters.watch.length === 0 && !activeQ)) return;
    const key = `${filters.watch.join(",")}|${activeQ}`;
    const visible = getVisibleVehicles();
    if (visible.length > 0 && (filters.follow || key !== lastFocusKeyRef.current)) {
      const points = visible.filter((v) => v.lat != null && v.lon != null).map((v) => [v.lat!, v.lon!] as [number, number]);
      if (points.length === 1) camera.flyTo(points[0][0], points[0][1], Math.max(camera.zoom(), WATCH_ZOOM));
      else if (points.length > 1) camera.fitBounds(points, VEHICLE_ZOOM);
    }
    lastFocusKeyRef.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles, filters, focusTripId, historyOn, mapReady]);

  // Menetkövetés: a menet útja (a busz nélkül is követhető: az élő adatfolyamból jön).
  useEffect(() => {
    setFollowPaused(false);
    setFocusPath(null);
    if (!focusTripId) return;
    let alive = true;
    api
      .getTripPath(focusTripId, focusVehicleId || undefined)
      .then((res) => {
        if (alive) setFocusPath(res);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [focusTripId, focusVehicleId]);

  useEffect(() => {
    onFollowPausedChange?.(Boolean(focusTripId) && followPaused);
  }, [focusTripId, followPaused, onFollowPausedChange]);

  const resumeFollow = () => {
    setFollowPaused(false);
    liveRef.current?.resumeFollow();
  };

  const vehicleResults = useMemo(() => {
    const list = getVisibleVehicles();
    if (filters.sort === "id") return list.sort((a, b) => a.id.localeCompare(b.id, "hu"));
    if (filters.sort === "speed") return list.sort((a, b) => (b.speed || 0) - (a.speed || 0));
    return list.sort((a, b) => a.routeShort.localeCompare(b.routeShort, "hu") || a.id.localeCompare(b.id, "hu"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles, filters, geo.position]);

  const flyToVehicle = (v: LiveVehicle) => {
    // Volán / vonat: követés. A jele 30–60 mp-cel késhet, és a látott részen kívül nem
    // becsüljük a helyét  a követés becsli és középen tartja (mint a figyelőből indítva).
    if (isRegionalId(v.id) && v.tripId) {
      onFocusTrip(v.tripId, v.id);
      return;
    }
    if (v.lat != null && v.lon != null) camera.flyTo(v.lat, v.lon, VEHICLE_ZOOM);
  };

  const activeFilters = activeFilterCount(filters);
  const summary = activeFilters ? filterSummary(filters, routes, vehicleResults.length) : "";
  const look = lookById(tileLayerId);
  const credits = [CREDIT_OSM, CREDIT_PROTOMAPS, ...(look.satellite ? [CREDIT_ESRI] : []), ...(is3d || look.topo ? [CREDIT_DEM] : [])];

  const pickStop = (stop: Stop) => {
    camera.flyTo(stop.lat, stop.lon, Math.max(camera.zoom(), CLOSE_ZOOM));
    onSelectStop(stop.id);
  };

  // A térkép adatai: a látható járművek (a követett nélkül), a követett menet, a megállók.
  const isFocused = (v: LiveVehicle) => Boolean(focusTripId) && (focusVehicleId ? v.id === focusVehicleId : v.tripId === focusTripId);
  const others = useMemo(
    () => (historyOn || (focusTripId && !filters.others) ? NO_VEHICLES : vehicleResults.filter((v) => !isFocused(v))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyOn, vehicleResults, focusTripId, focusVehicleId, filters.others],
  );
  const focusLive = focusTripId ? (vehicles.find((v) => isFocused(v) && v.lat != null && v.lon != null) ?? null) : null;
  const focusSpec = useMemo<FocusSpec | null>(() => {
    if (!focusTripId || historyOn) return null;
    const last = focusPath?.vehicle ?? null;
    const mode = focusLive ? vehicleModeOf(focusLive, routes[focusLive.routeId]?.type) : undefined;
    const id = focusLive?.id ?? last?.id ?? focusVehicleId;
    // a követett vonat címkéje a vonatszám (a csempén csak a kategória)
    const label = id ? vehicleIdText({ id, plate: focusLive?.plate, trainNo: focusLive?.trainNo, trainName: focusLive?.trainName }, mode) : null;
    const color = safeHex(focusLive?.routeColor || focusPath?.color, "1FB574");
    return {
      key: `${focusTripId}|${focusVehicleId ?? ""}`,
      shape: focusPath?.shape?.length ? focusPath.shape : null,
      color,
      badge: {
        text: focusLive?.routeShort || focusPath?.route || "?",
        bg: color,
        fg: safeHex(focusLive?.routeText || focusPath?.text, "FFFFFF"),
        mode,
        tracked: true,
        estimated: Boolean(focusLive?.estimated),
      },
      label,
      vehicle: focusLive ?? (last && last.lat != null && last.lon != null ? { id: last.id, lat: last.lat, lon: last.lon, motion: null } : null),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTripId, focusVehicleId, focusPath, focusLive, routes, historyOn]);
  const mapStops = useMemo(() => {
    if (!filters.stops || focusTripId) return NO_STOPS;
    if (!filters.onlyWatched) return stops;
    const watched = new Set(monitoredStopIds);
    return stops.filter((s) => watched.has(s.id));
  }, [filters.stops, filters.onlyWatched, focusTripId, stops, monitoredStopIds]);
  const ridePosition = geo.isActive && !geo.isStale ? geo.position : null;

  return (
    <div className="relative flex h-full w-full min-w-0 flex-1 overflow-hidden">
      <div className="relative h-full w-full min-w-0 flex-1 bg-background">
        {mapError ? (
          <div className="absolute inset-0 z-map flex items-center justify-center p-6">
            <div className="max-w-[320px] rounded-2xl border border-border bg-card p-5 shadow-lg">
              <p className="text-[15px] font-semibold">{mapError === "webgl" ? "Ez a böngésző nem tudja megjeleníteni a térképet" : "A térkép most nem érhető el"}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                {mapError === "webgl"
                  ? "A térképhez WebGL 2 kell (régebbi telefonon vagy kikapcsolt hardveres gyorsítással hiányzik). A megállók, a menetrend és a figyelő a többi fülön működik."
                  : "Nem jött le a térkép alapja. Ellenőrizd a kapcsolatot, és próbáld újra."}
              </p>
              {mapError === "tiles" ? (
                <button
                  type="button"
                  onClick={retryMap}
                  className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-transform duration-fast hover:brightness-110 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                >
                  <RotateCw className="h-4 w-4" />
                  Újra
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <Suspense fallback={null}>
            <LiveMap
              key={mapKey}
              ref={liveRef}
              onReady={onMapReady}
              lookId={tileLayerId}
              three={is3d}
              initialView={initialView}
              vehicles={others}
              routes={routes}
              watch={filters.watch}
              vq={filters.vq}
              labels={filters.labels}
              dim={Boolean(focusTripId)}
              focus={focusSpec}
              stops={mapStops}
              watchedStopIds={monitoredStopIds}
              selectedStopId={selectedStopId}
              routeLines={routeLines}
              traffic={traffic}
              position={geo.position}
              ridePosition={ridePosition}
              onSelectStop={onSelectStop}
              onFocusTrip={onFocusTrip}
              onFollowPausedChange={setFollowPaused}
              onViewChange={onMapView}
              onFail={onMapFail}
            />
          </Suspense>
        )}

        <FilterPanel
          open={isPanelOpen}
          onClose={() => setPanelOpen(false)}
          filters={filters}
          setFilters={setFilters}
          onClearFilters={onClearFilters}
          routes={routes}
          vehicles={vehicles}
          visibleVehicles={vehicleResults}
          hasPosition={Boolean(geo.position)}
          onStartGeo={geo.start}
          onPickVehicle={(v) => {
            flyToVehicle(v);
            if (!window.matchMedia("(min-width: 768px)").matches) setPanelOpen(false);
          }}
        />

        {/* Bal fent: szűrés (vagy menetkövetéskor a kilépés). A nyitott panel alatt nem látszik. */}
        <MapCorner corner="top-left" row className={cn("max-w-[calc(100%-5.5rem)]", isPanelOpen && "hidden")}>
          {focusTripId ? (
            <>
              <MapControl icon={ArrowLeft} label="Követés vége" showLabel="always" active onClick={onExitFocus} />
              {followPaused ? <MapControl icon={Crosshair} label="Busz középre" showLabel="always" onClick={resumeFollow} /> : null}
            </>
          ) : (
            <>
              <MapControl
                icon={SlidersHorizontal}
                label="Szűrés"
                showLabel="always"
                badge={activeFilters || null}
                active={activeFilters > 0}
                aria-expanded={isPanelOpen}
                onClick={() => setPanelOpen(true)}
              />
              {activeFilters ? (
                <div className="pointer-events-auto flex h-11 min-w-0 items-center gap-1 rounded-xl border border-primary/40 bg-card/90 pl-3 pr-1 shadow-md backdrop-blur-md">
                  <button type="button" onClick={() => setPanelOpen(true)} className="min-w-0 truncate text-left text-[12.5px] font-semibold text-primary" title={summary}>
                    {summary}
                  </button>
                  <button
                    type="button"
                    onClick={onClearFilters}
                    aria-label="Szűrők törlése"
                    title="Szűrők törlése"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
            </>
          )}
        </MapCorner>

        {/* Jobb fent: alaptérkép és rétegek, alatta az MVK hírei. */}
        <MapCorner corner="top-right" className={cn(dock && DOCK_INSET)}>
          <MapLayersControl tileLayerId={tileLayerId} onSelectTileLayer={onSelectTileLayer} filters={filters} setFilters={setFilters} watchedStops={monitoredStopIds.length} />
          <MapControl
            icon={Box}
            label="3D"
            showLabel="always"
            active={is3d}
            title={is3d ? "Vissza a felülnézetre" : "3D város: épületek, domborzat, követés a busz mögül"}
            onClick={() => setIs3d(!is3d)}
          />
          <NewsButton onShowRoute={(id) => setFilters((prev) => ({ ...prev, routes: [id] }))} />
        </MapCorner>

        {/* Bal lent: keresés (megálló, kód, rendszám)  hüvelykujjal elérhető. */}
        {historyOn ? null : (
          <MapCorner corner="bottom-left" className={cn(isPanelOpen && "hidden md:flex md:left-[384px]", searchOpen && "z-drawer")}>
            <MapSearch
              onOpenChange={setSearchOpen}
              stops={stops}
              vehicles={vehicles}
              position={geo.position}
              monitoredStopIds={monitoredStopIds}
              watched={filters.watch}
              onToggleMonitorStop={onToggleMonitorStop}
              onPickStop={pickStop}
              onPickPlace={(lat, lon) => camera.flyTo(lat, lon, VEHICLE_ZOOM)}
              onPickVehicle={flyToVehicle}
              onToggleWatch={(id) =>
                setFilters((prev) => ({
                  ...prev,
                  watch: prev.watch.includes(id) ? prev.watch.filter((x) => x !== id) : prev.watch.length < MAX_WATCHED ? [...prev.watch, id] : prev.watch,
                }))
              }
            />
          </MapCorner>
        )}

        {/* Jobb lent: idővonal, nagyítás (asztalon), helyzetem; az idővonal-sáv fölé emelkedik. */}
        <MapCorner corner="bottom-right" className={cn(dock && DOCK_INSET)} style={historyOn && timelineInset > 0 ? { bottom: timelineInset + 8 } : undefined}>
          {geo.error && (geoAsked || geo.status !== "denied") ? (
            <p role="status" className="pointer-events-auto max-w-[220px] rounded-xl border border-border/80 bg-card/90 px-3 py-2 text-[11.5px] text-muted-foreground shadow-md backdrop-blur-md">
              {geo.error}
            </p>
          ) : null}
          {historyOn ? null : <MapControl icon={History} label="Idővonal" showLabel="wide" title="Visszanézhető, merre jártak a járművek" onClick={openHistory} />}
          <MapControlGroup label="Nagyítás" className="hidden md:flex">
            <MapGroupButton icon={Plus} label="Nagyítás" onClick={() => liveRef.current?.zoomBy(1)} />
            <MapGroupButton icon={Minus} label="Kicsinyítés" onClick={() => liveRef.current?.zoomBy(-1)} />
          </MapControlGroup>
          <MapControl
            icon={LocateFixed}
            label={geo.position ? "Ugrás a helyzetemre" : "Helymeghatározás bekapcsolása"}
            active={geo.isActive}
            busy={geo.status === "requesting"}
            disabled={geo.status === "requesting"}
            onClick={handleLocate}
          />
        </MapCorner>

        <p className="absolute bottom-0.5 left-1/2 z-overlay flex -translate-x-1/2 gap-1.5 whitespace-nowrap rounded px-1.5 text-[9px] text-foreground/55">
          {credits.map((c) => (
            <a key={c.text} href={c.href} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
              {c.text}
            </a>
          ))}
        </p>

        {historyOn && mapReady ? <MapTimeline liveRef={liveRef} routes={routes} filters={filters} onExit={() => setHistoryOn(false)} onInsetChange={setTimelineInset} /> : null}
      </div>
    </div>
  );
}
