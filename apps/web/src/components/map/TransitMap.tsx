import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import L from "leaflet";
import {
  ArrowLeft,
  Box,
  Crosshair,
  History,
  LocateFixed,
  Minus,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { FilterState, LiveMotion, LiveVehicle, Route, Stop, TripPathResponse } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { distanceKm, nearest } from "@/lib/geo";
import { initialMapView, saveMapView } from "@/lib/viewState";
import { token } from "@/lib/theme";
import { cn, normalizeSearchText } from "@/lib/utils";
import { MapTimeline } from "./MapTimeline";
import { createVehicleIcon, escapeHtml, vehicleIconHtml, vehicleIdText, type VehicleIconOptions } from "./vehicleIcon";
import { estimatePosition, type Shown } from "./liveMotion";
import { trafficColor } from "./trafficColor";
import { trafficPopupHtml, useLiveTraffic } from "./liveTraffic";
import { useRouteShapes } from "./useRouteShapes";
import { vehiclePopupHtml, wireVehiclePopup } from "./vehiclePopup";
import { coveredBottom, coveredRight } from "./mapCover";
import { api } from "@/services/api";
import { serverNow } from "@/lib/realtime";
import { getActiveRide } from "@/lib/rides";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { TILE_LAYERS, type TileLayerOption } from "./tileLayers";
import { MapControl, MapControlGroup, MapCorner, MapGroupButton } from "./controls/MapControl";
import { MapLayersControl } from "./controls/MapLayersControl";
import { MapSearch } from "./controls/MapSearch";
import { NewsButton } from "@/components/news/NewsButton";
import { FilterPanel } from "./filter/FilterPanel";
import { activeFilterCount, filterSummary, matchesModeFilters, MAX_WATCHED } from "./filter/filterState";
import { isRegionalId, vehicleModeOf } from "@/lib/modes";
import type { Focus3D, Map3DHandle, Map3DView } from "./map3d/Map3D";

/** A 3D térkép (MapLibre) csak bekapcsoláskor töltődik le — a 2D nézet ebből semmit nem visz. */
const Map3D = lazy(() => import("./map3d/Map3D").then((m) => ({ default: m.Map3D })));

/** a szűrőpanel nyitott állapota asztalon (eszközönként) */
const PANEL_KEY = "mvk_map_panel";
/** a 3D nézet bekapcsolva (eszközönként) */
const MAP_3D_KEY = "mvk_map_3d";
/** ha a 3D nem indult el, ennyi ideig látszik a magyarázat (ms) */
const MAP_3D_ERROR_MS = 6000;

/** A csempék forrásmegjelölése (a licenc kéri; kicsiben, a térkép alján). */
const TILE_CREDIT: Record<string, { text: string; href: string }> = {
  osm: { text: "© OpenStreetMap közreműködők", href: "https://www.openstreetmap.org/copyright" },
  dark: { text: "© OpenStreetMap közreműködők", href: "https://www.openstreetmap.org/copyright" },
  light: { text: "© OpenStreetMap közreműködők", href: "https://www.openstreetmap.org/copyright" },
  satellite: { text: "© Esri, Maxar, Earthstar Geographics", href: "https://www.esri.com/" },
  topo: { text: "© OpenTopoMap (CC-BY-SA), OpenStreetMap", href: "https://opentopomap.org" },
};
/** 3D-ben: OpenFreeMap vektorcsempék (OpenMapTiles séma, OSM-adat), terep: Mapzen / AWS Open Data */
const CREDIT_3D = { text: "© OpenFreeMap, OpenMapTiles, OpenStreetMap · terep: Mapzen", href: "https://openfreemap.org" };
const CREDIT_3D_SATELLITE = { text: "© Esri, Maxar · OpenFreeMap, OpenStreetMap · terep: Mapzen", href: "https://openfreemap.org" };

const MAX_MAP_ZOOM = 19;
/** nincs kiválasztott vonal (állandó, hogy a nyomvonal-hook ne fusson újra) */
const NO_ROUTES: string[] = [];
const NO_VEHICLES: LiveVehicle[] = [];
const NO_STOPS: Stop[] = [];
/** Miskolc belváros, ha még nincs mentett nézet */
const DEFAULT_VIEW: Map3DView = { lat: 48.104, lon: 20.79, zoom: 13 };

const layerConf = (id: string) =>
  TILE_LAYERS.find((l) => l.id === id) || TILE_LAYERS[0];

function makeTile(conf: TileLayerOption, labels: boolean): L.TileLayer {
  const layer = L.tileLayer(labels ? conf.labelsUrl! : conf.url, {
    maxZoom: MAX_MAP_ZOOM + 1,
    maxNativeZoom: conf.maxNativeZoom,
    detectRetina: true,
    keepBuffer: 2,
    crossOrigin: true,
    ...(labels ? { pane: "shadowPane" } : { attribution: conf.attribution }),
  });

  if (!labels && conf.filter) {
    layer.on("add", () => {
      const el = layer.getContainer();
      if (el) el.style.filter = conf.filter!;
    });
  }
  return layer;
}


const NEAR_STOP_KM = 0.4;
const CLOSE_ZOOM = 17;
const ME_ZOOM = 16;

/** Érintőképernyőn az ujj nem pixelpontos — a találati sugár ezt pótolja. */
const IS_TOUCH =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)").matches ?? false);

/** Canvas-találati ráhagyás képpontban: ennyivel a pötty mellé is lehet nyúlni. */
const HIT_TOLERANCE = IS_TOUCH ? 15 : 6;

/** A megállópöttyök rajzolt mérete — érintésre nagyobb, hogy látszódjon is. */
const STOP_R = IS_TOUCH ? 5 : 3.5;
/** városnyi távolságból kisebb pötty: a buszok a lényeg, a megállók csak háttér */
const STOP_R_FAR = IS_TOUCH ? 3 : 2.5;
const STOP_R_ACTIVE = IS_TOUCH ? 7.5 : 6;
/** a Volán-megállók csak ettől a nagyítástól látszanak (a megyében ~3500 van belőlük) */
const COACH_STOPS_ZOOM = 14;
/** a vasútállomás pöttye nagyobb, MÁV-kék */
const RAIL_STOP_R = IS_TOUCH ? 6.5 : 5;
const RAIL_COLOR = "#1E5AA8";
/** a regionális járművek mozgásbecslése ettől a nagyítástól (távolról csak a GPS-helyük látszik) */
const REGIONAL_MOTION_ZOOM = 11;

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
   * (menetrend + kártya) — a jobb oldali gombok mellé húzódnak.
   */
  dock?: boolean;
}

/** a FocusDock asztalon: jobb margó + szélesség + köz (px) */
const DOCK_INSET = "md:right-[408px]";

const MOTION_TICK_MS = 250;

type LiveMarker = { marker: L.Marker; iconKey: string; v: LiveVehicle; shown: Shown | undefined };
/** a követett busz: ugyanúgy a becslés mozgatja, mint a többit */
type FocusMarker = { marker: L.Marker; iconKey: string; id: string | null; motion: LiveMotion | null; shown: Shown | undefined; raw?: [number, number] };

/** Csak akkor mozgatjuk a jelölőt, ha tényleg máshol van (a 250 ms-os ütem ne rajzoljon feleslegesen). */
function moveIfChanged(marker: L.Marker, lat: number, lon: number) {
  const ll = marker.getLatLng();
  if (ll.lat !== lat || ll.lng !== lon) marker.setLatLng([lat, lon]);
}
/** a térkép a követett busszal halad; elhúzásra megáll, nagyításkor a busz körül nagyít */
type FollowState = { paused: boolean; centered: boolean; zooming: boolean; holdUntil: number };

/** követéskor legalább ekkora nagyítás */
const FOCUS_ZOOM = 15;
/** követés közben a többi busz halványabban */
const DIM_OPACITY = 0.55;
/** a „Busz középre” csúszása alatt a követés nem rángatja a térképet (ms) */
const FOCUS_RECENTER_MS = 450;
/** ennél nagyobb eltérésnél a térkép odacsúszik a buszhoz, nem ugrik (px) */
const FOCUS_GLIDE_PX = 40;

/** Mennyit kell a térképnek elmozdulnia, hogy a busz a látható rész közepén legyen (px). */
function offsetToFollow(map: L.Map, pos: L.LatLng): L.Point {
  const size = map.getSize();
  const container = map.getContainer();
  const target = L.point((size.x - coveredRight(container)) / 2, (size.y - coveredBottom(container)) / 2);
  return map.latLngToContainerPoint(pos).subtract(target);
}

/** Követéskor a nagyítás (csípés, görgő, dupla koppintás) a képközépen marad — ott a busz. */
function zoomAroundCenter(map: L.Map, on: boolean) {
  const mode = on ? "center" : true;
  map.options.touchZoom = mode;
  map.options.scrollWheelZoom = mode;
  map.options.doubleClickZoom = mode;
}

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
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const labelLayerRef = useRef<L.TileLayer | null>(null);
  const stopLayerRef = useRef<L.LayerGroup | null>(null);
  const busLayerRef = useRef<L.LayerGroup | null>(null);
  const liveMarkersRef = useRef(new Map<string, LiveMarker>());
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const trafficLayerRef = useRef<L.LayerGroup | null>(null);
  const focusLayerRef = useRef<L.LayerGroup | null>(null);
  const focusMarkerRef = useRef<FocusMarker | null>(null);
  const followRef = useRef<FollowState>({ paused: false, centered: false, zooming: false, holdUntil: 0 });
  const [focusPath, setFocusPath] = useState<TripPathResponse | null>(null);
  const [followPaused, setFollowPaused] = useState(false);
  const lastFocusKeyRef = useRef<string>("");
  /**
   * A Volán-megállók (a megyében ~3500) csak közelről és csak a látott részen kerülnek
   * ki: a nézet (nagyítás + kivágat) változása ezt a számlálót lépteti.
   */
  const [stopView, setStopView] = useState<{ zoom: number; bounds: L.LatLngBounds | null }>({ zoom: 13, bounds: null });

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
  const geoLayerRef = useRef<L.LayerGroup | null>(null);
  /** a telefon friss helyzete (a becslés-ütemnek: utazás közben ez viszi a buszt, amin ülsz) */
  const geoPosRef = useRef<GeoPosition | null>(null);
  useEffect(() => {
    geoPosRef.current = geo.isActive && !geo.isStale ? geo.position : null;
  }, [geo.isActive, geo.isStale, geo.position]);

  // Idővonal: amíg él, az élő járművek helyett a visszajátszás látszik.
  const [historyOn, setHistoryOn] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [timelineInset, setTimelineInset] = useState(0);

  // 3D nézet (eszközönként megjegyezve). Közben a Leaflet-térkép láthatatlanul a helyén marad.
  const [is3d, setIs3dState] = useState(() => {
    try {
      return localStorage.getItem(MAP_3D_KEY) === "1";
    } catch {
      return false;
    }
  });
  const is3dRef = useRef(is3d);
  is3dRef.current = is3d;
  const map3dRef = useRef<Map3DHandle | null>(null);
  /** a 3D térkép kezdő nézete (bekapcsoláskor a 2D-é) */
  const [initial3dView, setInitial3dView] = useState<Map3DView | null>(null);

  const setIs3d = (on: boolean) => {
    setIs3dState(on);
    try {
      localStorage.setItem(MAP_3D_KEY, on ? "1" : "0");
    } catch {
      /* privát mód */
    }
  };

  /** 2D ↔ 3D: a nézet (középpont, nagyítás) átjön, a követés újra középre áll. */
  const switch3d = async (on: boolean) => {
    const leaflet = mapRef.current;
    if (on) {
      const c = leaflet?.getCenter();
      setInitial3dView(c ? { lat: c.lat, lon: c.lng, zoom: leaflet!.getZoom() } : null);
    } else {
      await map3dRef.current?.flatten();
      const v = map3dRef.current?.view();
      if (v && leaflet) leaflet.setView([v.lat, v.lon], Math.round(v.zoom), { animate: false });
    }
    followRef.current = { ...followRef.current, paused: false, centered: false };
    setFollowPaused(false);
    setIs3d(on);
  };

  /** A 3D nem indult el (nincs WebGL, nem jött le az alaptérkép): marad a 2D, és pár másodpercig megmondjuk, miért. */
  const [map3dError, setMap3dError] = useState(false);
  const on3dFail = useCallback(() => {
    setIs3d(false);
    setMap3dError(true);
  }, []);
  useEffect(() => {
    if (!map3dError) return;
    const t = setTimeout(() => setMap3dError(false), MAP_3D_ERROR_MS);
    return () => clearTimeout(t);
  }, [map3dError]);

  const on3dView = useCallback((v: Map3DView) => saveMapView({ lat: v.lat, lon: v.lon, zoom: v.zoom }), []);

  /** A kamera mozdulatai abba a térképbe mennek, amelyik épp látszik (a nagyítás a 2D skáláján). */
  const camera = {
    zoom: () => (is3dRef.current ? (map3dRef.current?.view()?.zoom ?? mapRef.current?.getZoom() ?? 13) : (mapRef.current?.getZoom() ?? 13)),
    flyTo: (lat: number, lon: number, zoom: number, duration = 0.7) => {
      if (is3dRef.current) map3dRef.current?.flyTo(lat, lon, zoom);
      else mapRef.current?.flyTo([lat, lon], zoom, { duration });
    },
    fitBounds: (points: [number, number][], maxZoom: number, padding = 60) => {
      if (is3dRef.current) map3dRef.current?.fitBounds(points, maxZoom);
      else mapRef.current?.fitBounds(points, { padding: [padding, padding], maxZoom });
    },
  };

  const openHistory = () => {
    if (focusTripId) onExitFocus();
    setPanelOpen(false);
    // az idővonal a 2D térképen játszik
    if (is3dRef.current) void switch3d(false);
    setHistoryOn(true);
  };

  // Ha máshonnan menetkövetés indul, az élő nézet kell — kilépünk.
  useEffect(() => {
    if (focusTripId) setHistoryOn(false);
  }, [focusTripId]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const saved = initialMapView();

    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      attributionControl: false,
      // A közös canvas-renderer találati ráhagyása minden körre és vonalra
      // érvényes — ettől lesz eltalálható a megállópötty telefonon.
      renderer: L.canvas({ tolerance: HIT_TOLERANCE, padding: 0.4 }),
      maxZoom: MAX_MAP_ZOOM,
      center: saved ? [saved.lat, saved.lon] : [48.104, 20.79],
      zoom: saved ? saved.zoom : 13,
    });

    const initial = layerConf(tileLayerId);
    tileLayerRef.current = makeTile(initial, false).addTo(map);
    if (initial.labelsUrl) {
      labelLayerRef.current = makeTile(initial, true).addTo(map);
    }

    routeLayerRef.current = L.layerGroup().addTo(map);
    // a dugók a járatnyomvonal fölött, a megállók és buszok alatt
    trafficLayerRef.current = L.layerGroup().addTo(map);
    stopLayerRef.current = L.layerGroup().addTo(map);
    busLayerRef.current = L.layerGroup().addTo(map);
    focusLayerRef.current = L.layerGroup().addTo(map);
    geoLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    const rememberView = () => {
      const c = map.getCenter();
      saveMapView({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
      // A Volán-megállók kivágata: csak közeli nagyításnál számít (távolról nem rajzoljuk őket).
      const z = map.getZoom();
      setStopView((prev) => (z < COACH_STOPS_ZOOM && prev.zoom < COACH_STOPS_ZOOM ? prev : { zoom: z, bounds: map.getBounds().pad(0.35) }));
    };
    map.on("moveend", rememberView);
    setStopView({ zoom: map.getZoom(), bounds: map.getBounds().pad(0.35) });

    const revalidateSize = () => {
      if (document.visibilityState === "visible") map.invalidateSize();
    };
    document.addEventListener("visibilitychange", revalidateSize);
    window.addEventListener("pageshow", revalidateSize);
    window.addEventListener("orientationchange", revalidateSize);

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(mapContainerRef.current);

    return () => {
      document.removeEventListener("visibilitychange", revalidateSize);
      window.removeEventListener("pageshow", revalidateSize);
      window.removeEventListener("orientationchange", revalidateSize);
      observer.disconnect();
      map.off("moveend", rememberView);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const conf = layerConf(tileLayerId);

    if (tileLayerRef.current) map.removeLayer(tileLayerRef.current);
    if (labelLayerRef.current) {
      map.removeLayer(labelLayerRef.current);
      labelLayerRef.current = null;
    }

    tileLayerRef.current = makeTile(conf, false).addTo(map);
    if (conf.labelsUrl) labelLayerRef.current = makeTile(conf, true).addTo(map);
  }, [tileLayerId]);

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

    if (filters.speed === "moving")
      list = list.filter((v) => (v.speed || 0) > 0.5);
    else if (filters.speed === "idle")
      list = list.filter((v) => (v.speed || 0) <= 0.5);

    if (filters.nearMeKm != null && geo.position) {
      const { lat, lon } = geo.position;
      list = list.filter(
        (v) =>
          v.lat != null &&
          v.lon != null &&
          distanceKm(lat, lon, v.lat, v.lon) <= filters.nearMeKm!,
      );
    }

    return list;
  };

  useEffect(() => {
    const layer = geoLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!geo.position) return;

    const { lat, lon, accuracyM } = geo.position;
    const mine = token("--early");

    L.circle([lat, lon], {
      radius: Math.max(accuracyM, 12),
      color: mine,
      weight: 1,
      opacity: 0.5,
      fillColor: mine,
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(layer);

    L.circleMarker([lat, lon], {
      radius: 7,
      color: token("--background"),
      weight: 3,
      fillColor: mine,
      fillOpacity: 1,
      interactive: false,
    })
      .bindTooltip("Itt vagy", { direction: "top", offset: [0, -8] })
      .addTo(layer);
  }, [geo.position]);

  const focusOnMe = useCallback(
    (animate: boolean) => {
      const map = mapRef.current;
      if (!map || !geo.position) return;

      const { lat, lon } = geo.position;
      const hit = nearest(stops, lat, lon);

      if (
        hit &&
        hit.km <= NEAR_STOP_KM &&
        hit.item.lat != null &&
        hit.item.lon != null
      ) {
        const both: [number, number][] = [
          [lat, lon],
          [hit.item.lat, hit.item.lon],
        ];
        if (is3dRef.current) camera.fitBounds(both, CLOSE_ZOOM);
        else map.fitBounds(both, { padding: [80, 80], maxZoom: CLOSE_ZOOM, animate });
        return;
      }

      if (is3dRef.current) camera.flyTo(lat, lon, ME_ZOOM);
      else if (animate) map.flyTo([lat, lon], ME_ZOOM, { duration: 0.6 });
      else map.setView([lat, lon], ME_ZOOM);
    },
    [geo.position, stops],
  );

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
    focusOnMe(true);
  };

  useEffect(() => {
    if (autoZoomRef.current === "done") return;
    if (!mapRef.current || !geo.position || stops.length === 0) return;

    if (focusTripId) {
      autoZoomRef.current = "done";
      return;
    }

    if (geo.isStale) {
      if (autoZoomRef.current === "none") {
        focusOnMe(false);
        autoZoomRef.current = "stale";
      }
      return;
    }

    focusOnMe(autoZoomRef.current === "stale");
    autoZoomRef.current = "done";
  }, [geo.position, geo.isStale, stops, focusTripId, focusOnMe]);

  // A kiválasztott vonalak nyomvonala (a letöltés közben kikapcsolt vonal nem marad kint).
  const routeShapes = useRouteShapes(filters.shape ? filters.routes : NO_ROUTES);
  const routeLines = useMemo(
    () => [...routeShapes].map(([id, lines]) => ({ color: `#${routes[id]?.color || "1FB574"}`, lines })),
    [routeShapes, routes],
  );

  useEffect(() => {
    const layer = routeLayerRef.current;
    if (!mapRef.current || !layer) return;
    layer.clearLayers();
    const halo = token("--background");
    for (const { color, lines } of routeLines) {
      for (const line of lines) {
        L.polyline(line, { color: halo, weight: 6, opacity: 0.55, interactive: false }).addTo(layer);
        L.polyline(line, { color, weight: 3, opacity: 0.95, interactive: false }).addTo(layer);
      }
    }
  }, [routeLines]);

  // Élő forgalom: a most torlódott szakaszok citromsárgától sötétvörösig (félpercenként frissül).
  const traffic = useLiveTraffic(filters.traffic && !historyOn);
  useEffect(() => {
    const layer = trafficLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const halo = token("--background");
    for (const seg of traffic) {
      const color = trafficColor(seg.level);
      const weight = 5 + Math.round(seg.level * 3);
      L.polyline(seg.path, { color: halo, weight: weight + 4, opacity: 0.55, interactive: false, lineCap: "round" }).addTo(layer);
      L.polyline(seg.path, { color, weight, opacity: 0.95, lineCap: "round", lineJoin: "round" })
        .bindPopup(() => trafficPopupHtml(seg))
        .addTo(layer);
    }
  }, [traffic]);

  useEffect(() => {
    if (!mapRef.current || !stopLayerRef.current) return;
    const layer = stopLayerRef.current;
    layer.clearLayers();
    if (!filters.stops || focusTripId) return;

    const neutral = token("--muted-foreground");
    const brand = token("--primary");
    const outline = token("--background");
    const watched = new Set(monitoredStopIds);
    const ids = new Set(stops.map((s) => s.id));
    const close = stopView.zoom >= COACH_STOPS_ZOOM;
    const list = (filters.onlyWatched ? stops.filter((s) => watched.has(s.id)) : stops).filter((s) => {
      // a vágány / kocsiállás az állomásán keresztül látszik (egy pötty az állomás)
      if (s.parent && ids.has(s.parent)) return false;
      if (s.feed !== "coach" || s.station || watched.has(s.id) || selectedStopId === s.id) return true;
      return close && (!stopView.bounds || stopView.bounds.contains([s.lat, s.lon]));
    });

    list.forEach((s) => {
      const isWatched = watched.has(s.id);
      const isSelected = selectedStopId === s.id;
      const active = isWatched || isSelected;
      const rail = s.feed === "rail";

      const marker = L.circleMarker([s.lat, s.lon], {
        radius: active ? STOP_R_ACTIVE : rail ? RAIL_STOP_R : close ? STOP_R : STOP_R_FAR,
        color: outline,
        weight: rail ? 2 : close || active ? 1.5 : 1,
        fillColor: active ? brand : rail ? RAIL_COLOR : neutral,
        fillOpacity: 1,
        // A renderer 15 képpontos ráhagyásával együtt ez adja a
        // hüvelykujjnak elég nagy érzékeny felületet.
        bubblingMouseEvents: false,
      });

      // Érintőképernyőn a tooltip csak egy fölösleges lebegő doboz, amit a
      // koppintás azonnal ki is vált — ott a részletlap a válasz.
      if (!IS_TOUCH) {
        // a név a feedből jön: escape-elve
        const kind = rail ? "Vasútállomás" : s.station ? "Autóbusz-állomás" : s.feed === "coach" ? "Volán-megálló" : s.id;
        marker.bindTooltip(
          `<strong>${escapeHtml(s.name)}</strong><br><span style="opacity:.65">${escapeHtml(kind)}</span>`,
          { direction: "top", offset: [0, -4] },
        );
      }
      marker.on("click", () => onSelectStop(s.id));
      marker.addTo(layer);
    });
  }, [
    stops,
    filters.stops,
    filters.onlyWatched,
    focusTripId,
    onSelectStop,
    monitoredStopIds,
    selectedStopId,
    stopView,
  ]);

  // Amikor a kijelölt megálló máshonnan (megállófigyelő "cél a térképen"
  // gombja, keresés) érkezik, a térkép ugorjon is oda — eddig csak a pötty
  // stílusa változott, a nézet nem mozdult.
  useEffect(() => {
    if (!mapRef.current || !selectedStopId) return;
    const stop = stops.find((s) => s.id === selectedStopId);
    if (!stop) return;
    camera.flyTo(stop.lat, stop.lon, Math.max(camera.zoom(), CLOSE_ZOOM));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStopId]);

  useEffect(() => {
    if (!mapRef.current || !busLayerRef.current) return;
    const layer = busLayerRef.current;
    const live = liveMarkersRef.current;
    // Követés közben (utazáskor is) a többi busz halványan látszik — kikapcsolható a Térkép rétegeinél.
    // 3D-ben a járműveket a 3D térkép rajzolja.
    if (historyOn || is3d || (focusTripId && !filters.others)) {
      layer.clearLayers();
      live.clear();
      return;
    }
    const isFocused = (v: LiveVehicle) => Boolean(focusTripId) && (focusVehicleId ? v.id === focusVehicleId : v.tripId === focusTripId);
    const dim = Boolean(focusTripId);

    const visible = getVisibleVehicles().filter((v) => !isFocused(v));
    const watchSet = new Set(filters.watch.map((w) => w.toLowerCase()));
    const activeQ = filters.vq.trim().toLowerCase();
    const seen = new Set<string>();

    // A markerek megmaradnak (csak a változás frissül), így a becslés
    // folyamatosan mozgathatja őket két GPS-jel között.
    visible.forEach((v) => {
      if (v.lat == null || v.lon == null) return;
      seen.add(v.id);

      const tracked =
        watchSet.has(v.id.toLowerCase()) ||
        (activeQ ? v.id.toLowerCase().includes(activeQ) : false);
      const showId = filters.labels || tracked;
      const mode = vehicleModeOf(v, routes[v.routeId]?.type);
      const iconKey = `${v.routeShort}|${v.routeColor}|${v.routeText}|${tracked}|${showId}|${dim}|${mode}|${v.trainNo ?? ""}|${v.estimated ? 1 : 0}`;
      const icon = () =>
        createVehicleIcon(
          v.routeShort || "?",
          v.routeColor || "1FB574",
          v.routeText || "FFFFFF",
          tracked,
          showId ? vehicleIdText(v, mode) : null,
          { mode, estimated: v.estimated },
        );

      // Ha a térkép közben újraépült, a régi marker már nincs a rétegen: újat teszünk ki.
      const entry = live.get(v.id);
      if (entry && layer.hasLayer(entry.marker)) {
        entry.v = v;
        if (entry.iconKey !== iconKey) {
          entry.marker.setIcon(icon());
          entry.marker.setZIndexOffset(tracked ? 1000 : 500);
          entry.marker.setOpacity(dim ? DIM_OPACITY : 1);
          entry.iconKey = iconKey;
        }
        if (!v.motion) {
          // Nincs becslés (áll a kiinduló megállóban, vagy nincs menete): a valós jel helye.
          entry.shown = undefined;
          entry.marker.setLatLng([v.lat, v.lon]);
        }
        return;
      }

      const marker = L.marker([v.lat, v.lon], { icon: icon(), zIndexOffset: tracked ? 1000 : 500, opacity: dim ? DIM_OPACITY : 1 });
      const created: LiveMarker = { marker, iconKey, v, shown: undefined };
      // Utazás közben a többi busz csak nézelődésre való: se követésre váltás, se felszállás róla.
      marker.bindPopup(() => vehiclePopupHtml(created.v, !getActiveRide()));
      // Követés vagy felszállás egyből a buborékból: az utazás indul, a térkép a buszt követi.
      marker.on("popupopen", (e) => wireVehiclePopup(e.popup.getElement(), () => created.v, onFocusTrip, () => marker.closePopup()));
      marker.addTo(layer);
      live.set(v.id, created);
    });

    for (const [id, entry] of live) {
      if (seen.has(id)) continue;
      layer.removeLayer(entry.marker);
      live.delete(id);
    }
  }, [vehicles, filters, focusTripId, focusVehicleId, historyOn, is3d, routes, onFocusTrip]);

  // A figyelt rendszámokra (keresésre) a térkép odaugrik — követés közben nem: a térkép a buszé.
  useEffect(() => {
    if (historyOn || !mapRef.current) return;
    const activeQ = filters.vq.trim().toLowerCase();
    if (focusTripId || (filters.watch.length === 0 && !activeQ)) return;
    const key = `${filters.watch.join(",")}|${activeQ}`;
    const visible = getVisibleVehicles();
    if (visible.length > 0 && (filters.follow || key !== lastFocusKeyRef.current)) {
      const points = visible.filter((v) => v.lat != null && v.lon != null).map((v) => [v.lat!, v.lon!] as [number, number]);
      if (points.length === 1) camera.flyTo(points[0][0], points[0][1], Math.max(camera.zoom(), 15), 0.6);
      else if (points.length > 1) camera.fitBounds(points, 16);
    }
    lastFocusKeyRef.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles, filters, focusTripId, historyOn]);

  // Élő becslés: negyed másodpercenként a nyomvonalon továbbvisszük a buszokat
  // (a szakasz szokásos sebességével, legfeljebb a következő megállóig) —
  // követéskor a követett buszt is, és a térkép vele együtt halad.
  useEffect(() => {
    if (historyOn || is3d) return;
    const follow = (pos: L.LatLng) => {
      const map = mapRef.current;
      const st = followRef.current;
      if (!map || st.paused || st.zooming || performance.now() < st.holdUntil) return;
      // Rákövetéskor azonnal, animáció nélkül a buszra állunk.
      const first = !st.centered;
      if (first) {
        st.centered = true;
        map.setView(pos, Math.max(map.getZoom(), FOCUS_ZOOM), { animate: false });
      }
      const off = offsetToFollow(map, pos);
      if (Math.abs(off.x) < 1 && Math.abs(off.y) < 1) return;
      // Nagyobb eltérésnél (nagyítás után, ugrásszerű új jelnél) odacsúszik, különben lépésről lépésre követ.
      if (!first && Math.hypot(off.x, off.y) > FOCUS_GLIDE_PX) {
        st.holdUntil = performance.now() + FOCUS_RECENTER_MS;
        map.panBy(off, { animate: true, duration: FOCUS_RECENTER_MS / 1000 - 0.05 });
      } else map.panBy(off, { animate: false });
    };
    const tick = () => {
      const now = serverNow();
      // Utazás közben a busz, amin ülsz, a telefon GPS-ével megy (ha az friss és a buszhoz illik).
      const ridden = getActiveRide()?.vehicleId ?? null;
      const gps = ridden ? geoPosRef.current : null;
      // A Volán- és vasúti járművek (a megyében ~250) csak a látott részen és közelről mozognak a becsléssel:
      // a többi a valós jel helyén áll, így a nyomvonaluk sem töltődik le feleslegesen.
      const map = mapRef.current;
      const view = map && map.getZoom() >= REGIONAL_MOTION_ZOOM ? map.getBounds().pad(0.3) : null;
      for (const entry of liveMarkersRef.current.values()) {
        const v = entry.v;
        if (isRegionalId(v.id) && v.id !== ridden && v.lat != null && v.lon != null && (!view || !view.contains([v.lat, v.lon]))) {
          entry.shown = undefined;
          moveIfChanged(entry.marker, v.lat, v.lon);
          continue;
        }
        const est = estimatePosition(entry.v.motion, now, entry.shown, gps && entry.v.id === ridden ? gps : null);
        if (!est) {
          // nincs (még) nyomvonal a becsléshez: a valós jel helyén mutatjuk, nem a régi helyén
          if (entry.v.lat != null && entry.v.lon != null) moveIfChanged(entry.marker, entry.v.lat, entry.v.lon);
          continue;
        }
        entry.shown = est.shown;
        entry.marker.setLatLng(est.latlng);
      }
      const f = focusMarkerRef.current;
      if (!f) return;
      const est = estimatePosition(f.motion, now, f.shown, gps && f.id === ridden ? gps : null);
      if (est) {
        f.shown = est.shown;
        f.marker.setLatLng(est.latlng);
      } else if (f.raw) moveIfChanged(f.marker, f.raw[0], f.raw[1]);
      follow(f.marker.getLatLng());
    };
    tick();
    const t = setInterval(tick, MOTION_TICK_MS);
    return () => clearInterval(t);
  }, [historyOn, is3d]);

  // Menetkövetés: a nyomvonal egyszer rajzolódik ki; a buszt az élő adatfolyam
  // frissíti (lent), és a fenti becslés mozgatja folyamatosan.
  useEffect(() => {
    const layer = focusLayerRef.current;
    if (!mapRef.current || !layer) return;
    layer.clearLayers();
    focusMarkerRef.current = null;
    followRef.current = { paused: false, centered: false, zooming: false, holdUntil: 0 };
    setFollowPaused(false);
    setFocusPath(null);
    if (!focusTripId) return;

    let alive = true;
    api
      .getTripPath(focusTripId, focusVehicleId || undefined)
      .then((res) => {
        if (!alive) return;
        setFocusPath(res);
        if (!res.shape?.length) return;
        L.polyline(res.shape, { color: token("--background"), weight: 8, opacity: 0.6, interactive: false }).addTo(layer);
        L.polyline(res.shape, { color: `#${res.color || "1FB574"}`, weight: 4, opacity: 0.95, interactive: false }).addTo(layer);
        // Busz még nincs (nem indult el, nincs jele): a teljes nyomvonal látszik.
        if (!focusMarkerRef.current && !res.vehicle && mapRef.current) {
          mapRef.current.fitBounds(res.shape, { padding: [60, 60], maxZoom: 16 });
        }
      })
      // A nyomvonal nélkül is követhető: a busz az élő adatfolyamból jön.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [focusTripId, focusVehicleId]);

  // A követett busz jelölője az élő adatfolyamból (ha onnan hiányzik: a menet utolsó ismert helye).
  useEffect(() => {
    const layer = focusLayerRef.current;
    if (!layer || !focusTripId) return;
    const live = vehicles.find((v) => (focusVehicleId ? v.id === focusVehicleId : v.tripId === focusTripId) && v.lat != null && v.lon != null);
    const last = focusPath?.vehicle ?? null;
    const lat = live?.lat ?? last?.lat;
    const lon = live?.lon ?? last?.lon;
    if (lat == null || lon == null) return;

    const route = live?.routeShort || focusPath?.route || "?";
    const color = live?.routeColor || focusPath?.color || "1FB574";
    const text = live?.routeText || focusPath?.text || "FFFFFF";
    const id = live?.id ?? last?.id ?? focusVehicleId;
    const iconOpts: VehicleIconOptions = live ? { mode: vehicleModeOf(live, routes[live.routeId]?.type), estimated: live.estimated } : {};
    // a követett vonat címkéje a vonatszám (a csempén csak a kategória)
    const shownId = id ? vehicleIdText({ id, plate: live?.plate, trainNo: live?.trainNo, trainName: live?.trainName }, iconOpts.mode) : null;
    const iconKey = `${route}|${color}|${text}|${id}|${iconOpts.mode ?? ""}|${shownId ?? ""}`;
    const motion = live?.motion ?? null;

    const entry = focusMarkerRef.current;
    if (entry && layer.hasLayer(entry.marker) && !live) {
      // a busz egy körre kiesett a jelentésből: ott marad, ahol volt (nem ugrik a követés kezdőpontjára)
      entry.motion = null;
      return;
    }
    if (entry && layer.hasLayer(entry.marker)) {
      entry.motion = motion;
      entry.raw = [lat, lon];
      entry.id = id ?? null;
      if (entry.iconKey !== iconKey) {
        entry.marker.setIcon(createVehicleIcon(route, color, text, true, shownId, iconOpts));
        entry.iconKey = iconKey;
      }
      if (!motion) {
        entry.shown = undefined;
        entry.marker.setLatLng([lat, lon]);
      }
      return;
    }
    const marker = L.marker([lat, lon], { icon: createVehicleIcon(route, color, text, true, shownId, iconOpts), zIndexOffset: 1200, interactive: false }).addTo(layer);
    focusMarkerRef.current = { marker, iconKey, id: id ?? null, motion, shown: undefined, raw: [lat, lon] };
  }, [vehicles, focusTripId, focusVehicleId, focusPath, routes]);

  // Követés közben: elhúzásra a térkép megáll (körül lehet nézni), nagyításkor nem rángatjuk.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusTripId) return;
    const onDrag = () => {
      followRef.current.paused = true;
      setFollowPaused(true);
    };
    const onZoomStart = () => {
      followRef.current.zooming = true;
    };
    const onZoomEnd = () => {
      followRef.current.zooming = false;
    };
    map.on("dragstart", onDrag);
    map.on("zoomstart", onZoomStart);
    map.on("zoomend", onZoomEnd);
    return () => {
      map.off("dragstart", onDrag);
      map.off("zoomstart", onZoomStart);
      map.off("zoomend", onZoomEnd);
      followRef.current.zooming = false;
    };
  }, [focusTripId]);

  useEffect(() => {
    const map = mapRef.current;
    if (map) zoomAroundCenter(map, Boolean(focusTripId) && !followPaused);
    onFollowPausedChange?.(Boolean(focusTripId) && followPaused);
  }, [focusTripId, followPaused, onFollowPausedChange]);

  const resumeFollow = () => {
    const st = followRef.current;
    st.paused = false;
    setFollowPaused(false);
    if (is3dRef.current) {
      map3dRef.current?.resumeFollow();
      return;
    }
    const f = focusMarkerRef.current;
    if (!f || !mapRef.current) return;
    st.holdUntil = performance.now() + FOCUS_RECENTER_MS;
    mapRef.current.panBy(offsetToFollow(mapRef.current, f.marker.getLatLng()), { animate: true, duration: FOCUS_RECENTER_MS / 1000 - 0.05 });
  };

  const vehicleResults = useMemo(() => {
    const list = getVisibleVehicles();
    if (filters.sort === "id")
      return list.sort((a, b) => a.id.localeCompare(b.id, "hu"));
    if (filters.sort === "speed")
      return list.sort((a, b) => (b.speed || 0) - (a.speed || 0));
    return list.sort(
      (a, b) =>
        a.routeShort.localeCompare(b.routeShort, "hu") ||
        a.id.localeCompare(b.id, "hu"),
    );
  }, [vehicles, filters, geo.position]);

  const flyToVehicle = (v: LiveVehicle) => {
    // Volán / vonat: követés. A jele 30–60 mp-cel késhet, és a látott részen kívül nem
    // becsüljük a helyét — a követés becsli és középen tartja (mint a figyelőből indítva).
    if (isRegionalId(v.id) && v.tripId) {
      onFocusTrip(v.tripId, v.id);
      return;
    }
    if (v.lat != null && v.lon != null) camera.flyTo(v.lat, v.lon, 16, 0.5);
  };

  const activeFilters = activeFilterCount(filters);
  const summary = activeFilters ? filterSummary(filters, routes, vehicleResults.length) : "";
  const credit = is3d ? (tileLayerId === "satellite" ? CREDIT_3D_SATELLITE : CREDIT_3D) : (TILE_CREDIT[tileLayerId] ?? TILE_CREDIT.osm);

  const pickStop = (stop: Stop) => {
    camera.flyTo(stop.lat, stop.lon, Math.max(camera.zoom(), CLOSE_ZOOM));
    onSelectStop(stop.id);
  };

  // A 3D térkép adatai: ugyanaz, amit a 2D rajzol (a látható járművek, a követett menet, a megállók).
  const isFocused = (v: LiveVehicle) => Boolean(focusTripId) && (focusVehicleId ? v.id === focusVehicleId : v.tripId === focusTripId);
  const others3d = useMemo(
    () => (!is3d || historyOn || (focusTripId && !filters.others) ? NO_VEHICLES : vehicleResults.filter((v) => !isFocused(v))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [is3d, historyOn, vehicleResults, focusTripId, focusVehicleId, filters.others],
  );
  const focusLive = focusTripId ? (vehicles.find((v) => isFocused(v) && v.lat != null && v.lon != null) ?? null) : null;
  const focus3d = useMemo<Focus3D | null>(() => {
    if (!is3d || !focusTripId) return null;
    const last = focusPath?.vehicle ?? null;
    const mode = focusLive ? vehicleModeOf(focusLive, routes[focusLive.routeId]?.type) : undefined;
    const id = focusLive?.id ?? last?.id ?? focusVehicleId;
    const shownId = id ? vehicleIdText({ id, plate: focusLive?.plate, trainNo: focusLive?.trainNo, trainName: focusLive?.trainName }, mode) : null;
    const color = focusLive?.routeColor || focusPath?.color || "1FB574";
    return {
      key: `${focusTripId}|${focusVehicleId ?? ""}`,
      shape: focusPath?.shape?.length ? focusPath.shape : null,
      color,
      html: vehicleIconHtml(focusLive?.routeShort || focusPath?.route || "?", color, focusLive?.routeText || focusPath?.text || "FFFFFF", true, shownId, { mode, estimated: focusLive?.estimated }),
      vehicle: focusLive ?? (last && last.lat != null && last.lon != null ? { id: last.id, lat: last.lat, lon: last.lon, motion: null } : null),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3d, focusTripId, focusVehicleId, focusPath, focusLive, routes]);
  const stops3d = useMemo(() => {
    if (!is3d || !filters.stops || focusTripId) return NO_STOPS;
    if (!filters.onlyWatched) return stops;
    const watched = new Set(monitoredStopIds);
    return stops.filter((s) => watched.has(s.id));
  }, [is3d, filters.stops, filters.onlyWatched, focusTripId, stops, monitoredStopIds]);
  const ridePosition = geo.isActive && !geo.isStale ? geo.position : null;

  return (
    <div className="relative flex h-full w-full min-w-0 flex-1 overflow-hidden">
      <div className="relative h-full w-full min-w-0 flex-1 bg-background">
        {/* 3D-ben a Leaflet-térkép láthatatlanul a helyén marad (a visszaváltás azonnali). A burkolón
            vált: a Leaflet saját osztályait (leaflet-container…) a React nem írhatja felül. */}
        <div className={cn("h-full w-full", is3d && "invisible")} aria-hidden={is3d || undefined}>
          <div ref={mapContainerRef} className="z-map h-full w-full" />
        </div>
        {is3d ? (
          <Suspense fallback={null}>
            <Map3D
              ref={map3dRef}
              tileLayerId={tileLayerId}
              initialView={initial3dView ?? initialMapView() ?? DEFAULT_VIEW}
              vehicles={others3d}
              routes={routes}
              watch={filters.watch}
              vq={filters.vq}
              labels={filters.labels}
              dim={Boolean(focusTripId)}
              focus={focus3d}
              stops={stops3d}
              watchedStopIds={monitoredStopIds}
              selectedStopId={selectedStopId}
              routeLines={routeLines}
              traffic={traffic}
              position={geo.position}
              ridePosition={ridePosition}
              onSelectStop={onSelectStop}
              onFocusTrip={onFocusTrip}
              onFollowPausedChange={setFollowPaused}
              onViewChange={on3dView}
              onFail={on3dFail}
            />
          </Suspense>
        ) : null}

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
          <MapLayersControl
            tileLayerId={tileLayerId}
            onSelectTileLayer={onSelectTileLayer}
            filters={filters}
            setFilters={setFilters}
            watchedStops={monitoredStopIds.length}
          />
          <MapControl
            icon={Box}
            label="3D"
            showLabel="always"
            active={is3d}
            title={is3d ? "Vissza a 2D térképre" : "3D város: épületek, domborzat, követés a busz mögül"}
            onClick={() => void switch3d(!is3d)}
          />
          <NewsButton onShowRoute={(id) => setFilters((prev) => ({ ...prev, routes: [id] }))} />
        </MapCorner>

        {/* Bal lent: keresés (megálló, kód, rendszám) — hüvelykujjal elérhető. */}
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
              onPickPlace={(lat, lon) => camera.flyTo(lat, lon, 16)}
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
          {map3dError ? (
            <p role="status" className="pointer-events-auto max-w-[220px] rounded-xl border border-border/80 bg-card/90 px-3 py-2 text-[11.5px] text-muted-foreground shadow-md backdrop-blur-md">
              A 3D térkép most nem tölthető be (a böngésző nem támogatja, vagy nem érhető el az alaptérkép) — maradt a 2D.
            </p>
          ) : null}
          {historyOn ? null : <MapControl icon={History} label="Idővonal" showLabel="wide" title="Visszanézhető, merre jártak a járművek" onClick={openHistory} />}
          <MapControlGroup label="Nagyítás" className="hidden md:flex">
            <MapGroupButton icon={Plus} label="Nagyítás" onClick={() => (is3d ? map3dRef.current?.zoomBy(1) : mapRef.current?.zoomIn())} />
            <MapGroupButton icon={Minus} label="Kicsinyítés" onClick={() => (is3d ? map3dRef.current?.zoomBy(-1) : mapRef.current?.zoomOut())} />
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

        <a
          href={credit.href}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-0.5 left-1/2 z-overlay -translate-x-1/2 whitespace-nowrap rounded px-1.5 text-[9px] text-foreground/55 hover:text-foreground"
        >
          {credit.text}
        </a>

        {historyOn ? (
          <MapTimeline
            mapRef={mapRef}
            routes={routes}
            filters={filters}
            onExit={() => setHistoryOn(false)}
            onInsetChange={setTimelineInset}
          />
        ) : null}

      </div>
    </div>
  );
}
