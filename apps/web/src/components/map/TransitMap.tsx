import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import L from "leaflet";
import {
  ArrowLeft,
  Crosshair,
  History,
  LocateFixed,
  Minus,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { FilterState, LiveMotion, LiveVehicle, Route, Stop, TripPathResponse } from "@/types";
import { api } from "@/services/api";
import { useGeo } from "@/context/GeoContext";
import { distanceKm, nearest } from "@/lib/geo";
import { initialMapView, saveMapView } from "@/lib/viewState";
import { token } from "@/lib/theme";
import { cn, normalizeSearchText } from "@/lib/utils";
import { MapTimeline } from "./MapTimeline";
import { createVehicleIcon, escapeHtml, safeHex } from "./vehicleIcon";
import { estimatePosition, type Shown } from "./liveMotion";
import { trafficColor } from "./trafficColor";
import { API_BASE } from "@/lib/apiBase";
import { boardVehicle } from "@/components/ride/RideLayer";
import { serverNow } from "@/lib/realtime";
import { getActiveRide } from "@/lib/rides";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { TILE_LAYERS, type TileLayerOption } from "./tileLayers";
import { MapControl, MapControlGroup, MapCorner, MapGroupButton } from "./controls/MapControl";
import { MapLayersControl } from "./controls/MapLayersControl";
import { MapSearch } from "./controls/MapSearch";
import { NewsButton } from "@/components/news/NewsButton";
import { FilterPanel } from "./filter/FilterPanel";
import { activeFilterCount, filterSummary, MAX_WATCHED } from "./filter/filterState";

/** a forgalom-réteg frissítése (ms) */
const TRAFFIC_POLL_MS = 30_000;

type TrafficSegment = { from: string; to: string; routes: string[]; path: [number, number][]; ratio: number; excessS: number; n: number; stuck: number; level: number; lastTs: number };

/** A dugó-szakasz buborékja: mennyire lassú, és miből tudjuk. */
function trafficPopupHtml(seg: TrafficSegment): string {
  const mins = Math.floor(seg.excessS / 60);
  const secs = String(seg.excessS % 60).padStart(2, "0");
  const ago = Math.max(0, Math.round((serverNow() - seg.lastTs) / 60));
  const evidence = [seg.n ? `${seg.n} átért busz` : "", seg.stuck ? `${seg.stuck} most bent ragadt` : ""].filter(Boolean).join(", ");
  const level = seg.level >= 0.75 ? "Beállt" : seg.level >= 0.4 ? "Torlódik" : "Lassul";
  return `
    <div style="min-width:200px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="width:10px;height:10px;border-radius:999px;background:${trafficColor(seg.level)}"></span>
        <strong style="font-size:13px">${level} a forgalom</strong>
      </div>
      <div style="font-size:12.5px;font-weight:600">${escapeHtml(seg.from)} → ${escapeHtml(seg.to)}</div>
      <div style="margin-top:4px;font-size:12px;color:hsl(var(--muted-foreground))">
        <b style="color:hsl(var(--foreground));font-family:var(--font-mono)">${String(seg.ratio).replace(".", ",")}×</b> lassabb a szokásosnál
        (<span style="font-family:var(--font-mono)">+${mins}:${secs}</span>)
      </div>
      <div style="margin-top:4px;font-size:11px;color:hsl(var(--muted-foreground))">${escapeHtml(evidence)} · ${ago ? `${ago} perce` : "most"} · ${escapeHtml(seg.routes.slice(0, 6).join(", "))}</div>
    </div>`;
}

/** a szűrőpanel nyitott állapota asztalon (eszközönként) */
const PANEL_KEY = "mvk_map_panel";

/** A csempék forrásmegjelölése (a licenc kéri; kicsiben, a térkép alján). */
const TILE_CREDIT: Record<string, { text: string; href: string }> = {
  osm: { text: "© OpenStreetMap közreműködők", href: "https://www.openstreetmap.org/copyright" },
  dark: { text: "© OpenStreetMap közreműködők", href: "https://www.openstreetmap.org/copyright" },
  light: { text: "© OpenStreetMap közreműködők", href: "https://www.openstreetmap.org/copyright" },
  satellite: { text: "© Esri, Maxar, Earthstar Geographics", href: "https://www.esri.com/" },
  topo: { text: "© OpenTopoMap (CC-BY-SA), OpenStreetMap", href: "https://opentopomap.org" },
};

const MAX_MAP_ZOOM = 19;

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
const STOP_R_ACTIVE = IS_TOUCH ? 7.5 : 6;

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
}

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

/**
 * A térkép alját teljes szélességben takaró panel (követett jármű, utazás —
 * `data-map-cover`) magassága: telefonon ezek alatt nem látszana a busz útja.
 */
function coveredBottom(container: HTMLElement): number {
  const box = container.getBoundingClientRect();
  let covered = 0;
  for (const el of document.querySelectorAll<HTMLElement>("[data-map-cover]")) {
    const r = el.getBoundingClientRect();
    if (r.width < box.width * 0.6 || r.top >= box.bottom || r.bottom < box.bottom - 4) continue;
    covered = Math.max(covered, box.bottom - r.top);
  }
  return Math.min(covered, box.height * 0.6);
}

/** Mennyit kell a térképnek elmozdulnia, hogy a busz a látható rész közepén legyen (px). */
function offsetToFollow(map: L.Map, pos: L.LatLng): L.Point {
  const size = map.getSize();
  const target = L.point(size.x / 2, (size.y - coveredBottom(map.getContainer())) / 2);
  return map.latLngToContainerPoint(pos).subtract(target);
}

/** Követéskor a nagyítás (csípés, görgő, dupla koppintás) a képközépen marad — ott a busz. */
function zoomAroundCenter(map: L.Map, on: boolean) {
  const mode = on ? "center" : true;
  map.options.touchZoom = mode;
  map.options.scrollWheelZoom = mode;
  map.options.doubleClickZoom = mode;
}

/** A jármű buborékja (megnyitáskor készül, így mindig a friss adatot mutatja). */
function vehiclePopupHtml(raw: LiveVehicle, actions = true): string {
  // A feed szövegei HTML-be kerülnek: escape-elve (egy „<” vagy „&” a célállomásban ne törje szét).
  const v = {
    ...raw,
    routeShort: escapeHtml(raw.routeShort ?? ""),
    headsign: escapeHtml(raw.headsign ?? ""),
    id: escapeHtml(raw.id),
    tripId: raw.tripId ? escapeHtml(raw.tripId) : raw.tripId,
    routeColor: safeHex(raw.routeColor, "1FB574"),
    routeText: safeHex(raw.routeText, "FFFFFF"),
  };
  const speed = v.speed != null ? `${Math.round(v.speed * 3.6)} km/h` : "—";
  return `
        <div style="min-width:210px">
          <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
            <span style="display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:26px;padding:0 8px;border-radius:8px;font-weight:800;font-size:14px;background:#${v.routeColor || "1FB574"};color:#${v.routeText || "FFFFFF"}">${v.routeShort}</span>
            <strong style="font-size:13px">${v.headsign || "Járat"}</strong>
          </div>
          <div style="border-radius:10px;background:hsl(var(--primary)/0.09);border:1px solid hsl(var(--primary)/0.25);padding:9px 11px;margin-bottom:8px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:hsl(var(--muted-foreground))">Rendszám</div>
            <div style="font-family:var(--font-mono);font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:hsl(var(--foreground))">${v.id}</div>
          </div>
          <div style="font-family:var(--font-mono);font-size:12px;color:hsl(var(--muted-foreground));display:grid;gap:3px">
            <div>Sebesség <strong style="color:hsl(var(--foreground))">${speed}</strong></div>
          </div>
          ${
            v.tripId && actions
              ? `<div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
                   <a href="#" data-trip="${v.tripId}" data-veh="${v.id}"
                      style="display:block;text-align:center;padding:8px 6px;border-radius:8px;border:1px solid hsl(var(--border));background:hsl(var(--secondary));color:hsl(var(--foreground));font-size:12px;font-weight:700;text-decoration:none">Követés</a>
                   <a href="#" data-board="${v.tripId}" data-veh="${v.id}"
                      style="display:block;text-align:center;padding:8px 6px;border-radius:8px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-size:12px;font-weight:700;text-decoration:none">Felszálltam</a>
                 </div>`
              : ""
          }
        </div>
      `;
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
  const geoCacheRef = useRef<Record<string, [number, number][][]>>({});
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

  const openHistory = () => {
    if (focusTripId) onExitFocus();
    setPanelOpen(false);
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
    };
    map.on("moveend", rememberView);

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
        const vid = normalizeSearchText(String(v.id || ""));
        const label = normalizeSearchText(String(v.label || ""));
        return targets.some((t) => vid.includes(t) || label.includes(t));
      });
    }

    let list = vehicles.slice();

    if (filters.type !== "all") {
      list = list.filter((v) => {
        const r = routes[v.routeId];
        const isTram = r?.type === "900" || v.label === "TRAM";
        return filters.type === "tram" ? isTram : !isTram;
      });
    }

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
        map.fitBounds(
          [
            [lat, lon],
            [hit.item.lat, hit.item.lon],
          ],
          { padding: [80, 80], maxZoom: CLOSE_ZOOM, animate },
        );
        return;
      }

      if (animate) map.flyTo([lat, lon], ME_ZOOM, { duration: 0.6 });
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

  useEffect(() => {
    if (!mapRef.current || !routeLayerRef.current) return;
    const layer = routeLayerRef.current;
    layer.clearLayers();
    if (!filters.shape || filters.routes.length === 0) return;

    // Ha a nyomvonal letöltése közben a szűrés változott, a régi kör ne rajzoljon
    // (különben egy közben kikapcsolt vonal nyomvonala ottmaradna).
    let alive = true;
    const render = async () => {
      const missing = filters.routes.filter((id) => !geoCacheRef.current[id]);
      if (missing.length > 0) {
        try {
          const res = await api.getRouteGeo(missing);
          res.routes.forEach((r) => {
            geoCacheRef.current[r.id] = r.shapes;
          });
        } catch {}
      }
      if (!alive) return;

      const halo = token("--background");
      filters.routes.forEach((id) => {
        const shapes = geoCacheRef.current[id];
        if (!shapes) return;
        const color = `#${routes[id]?.color || "1FB574"}`;
        shapes.forEach((line) => {
          L.polyline(line, {
            color: halo,
            weight: 6,
            opacity: 0.55,
            interactive: false,
          }).addTo(layer);
          L.polyline(line, {
            color,
            weight: 3,
            opacity: 0.95,
            interactive: false,
          }).addTo(layer);
        });
      });
    };

    render();
    return () => {
      alive = false;
    };
  }, [filters.routes, filters.shape, routes]);

  // Élő forgalom: a most torlódott szakaszok citromsárgától sötétvörösig (félpercenként frissül).
  useEffect(() => {
    const layer = trafficLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!filters.traffic || historyOn) return;
    let alive = true;
    const draw = async () => {
      try {
        const res = await fetch(`${API_BASE}/engine/traffic/live`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { segments: TrafficSegment[] };
        if (!alive) return;
        layer.clearLayers();
        const halo = token("--background");
        for (const seg of data.segments) {
          const color = trafficColor(seg.level);
          const weight = 5 + Math.round(seg.level * 3);
          L.polyline(seg.path, { color: halo, weight: weight + 4, opacity: 0.55, interactive: false, lineCap: "round" }).addTo(layer);
          L.polyline(seg.path, { color, weight, opacity: 0.95, lineCap: "round", lineJoin: "round" })
            .bindPopup(() => trafficPopupHtml(seg))
            .addTo(layer);
        }
      } catch {
        /* a következő kör újrapróbálja */
      }
    };
    void draw();
    const t = setInterval(draw, TRAFFIC_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [filters.traffic, historyOn]);

  useEffect(() => {
    if (!mapRef.current || !stopLayerRef.current) return;
    const layer = stopLayerRef.current;
    layer.clearLayers();
    if (!filters.stops || focusTripId) return;

    const neutral = token("--muted-foreground");
    const brand = token("--primary");
    const outline = token("--background");
    const watched = new Set(monitoredStopIds);
    const list = filters.onlyWatched
      ? stops.filter((s) => watched.has(s.id))
      : stops;

    list.forEach((s) => {
      const isWatched = watched.has(s.id);
      const isSelected = selectedStopId === s.id;
      const active = isWatched || isSelected;

      const marker = L.circleMarker([s.lat, s.lon], {
        radius: active ? STOP_R_ACTIVE : STOP_R,
        color: outline,
        weight: 1.5,
        fillColor: active ? brand : neutral,
        fillOpacity: 1,
        // A renderer 15 képpontos ráhagyásával együtt ez adja a
        // hüvelykujjnak elég nagy érzékeny felületet.
        bubblingMouseEvents: false,
      });

      // Érintőképernyőn a tooltip csak egy fölösleges lebegő doboz, amit a
      // koppintás azonnal ki is vált — ott a részletlap a válasz.
      if (!IS_TOUCH) {
        marker.bindTooltip(
          `<strong>${s.name}</strong><br><span style="opacity:.65">${s.id}</span>`,
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
  ]);

  // Amikor a kijelölt megálló máshonnan (megállófigyelő "cél a térképen"
  // gombja, keresés) érkezik, a térkép ugorjon is oda — eddig csak a pötty
  // stílusa változott, a nézet nem mozdult.
  useEffect(() => {
    if (!mapRef.current || !selectedStopId) return;
    const stop = stops.find((s) => s.id === selectedStopId);
    if (!stop) return;
    mapRef.current.flyTo(
      [stop.lat, stop.lon],
      Math.max(mapRef.current.getZoom(), CLOSE_ZOOM),
      { duration: 0.7 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStopId]);

  useEffect(() => {
    if (!mapRef.current || !busLayerRef.current) return;
    const layer = busLayerRef.current;
    const live = liveMarkersRef.current;
    // Követés közben (utazáskor is) a többi busz halványan látszik — kikapcsolható a Térkép rétegeinél.
    if (historyOn || (focusTripId && !filters.others)) {
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
      const iconKey = `${v.routeShort}|${v.routeColor}|${v.routeText}|${tracked}|${showId}|${dim}`;
      const icon = () =>
        createVehicleIcon(
          v.routeShort || "?",
          v.routeColor || "1FB574",
          v.routeText || "FFFFFF",
          tracked,
          showId ? v.id : null,
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
      marker.on("popupopen", (e) => {
        const el = e.popup.getElement();
        const follow = el?.querySelector("a[data-trip]");
        follow?.addEventListener("click", (ev) => {
          ev.preventDefault();
          const tId = follow.getAttribute("data-trip");
          const vId = follow.getAttribute("data-veh");
          if (tId) onFocusTrip(tId, vId || undefined);
        });
        // Felszállás egyből a buborékból: az utazás indul, a térkép a buszt követi.
        const board = el?.querySelector("a[data-board]");
        board?.addEventListener("click", (ev) => {
          ev.preventDefault();
          const cur = created.v;
          if (!cur.tripId) return;
          boardVehicle({ tripId: cur.tripId, vehicleId: cur.id, route: cur.routeShort, color: cur.routeColor, text: cur.routeText, headsign: cur.headsign }, "manual");
          marker.closePopup();
        });
      });
      marker.addTo(layer);
      live.set(v.id, created);
    });

    for (const [id, entry] of live) {
      if (seen.has(id)) continue;
      layer.removeLayer(entry.marker);
      live.delete(id);
    }

    // Követés közben a térkép a buszé: a figyelt rendszámokra nem ugrunk el.
    if (!focusTripId && (filters.watch.length > 0 || activeQ)) {
      const key = `${filters.watch.join(",")}|${activeQ}`;
      if (
        visible.length > 0 &&
        (filters.follow || key !== lastFocusKeyRef.current)
      ) {
        const points = visible
          .filter((v) => v.lat != null && v.lon != null)
          .map((v) => [v.lat!, v.lon!] as [number, number]);

        if (points.length === 1 && mapRef.current) {
          mapRef.current.flyTo(
            points[0],
            Math.max(mapRef.current.getZoom(), 15),
            { duration: 0.6 },
          );
        } else if (points.length > 1 && mapRef.current) {
          mapRef.current.fitBounds(points, { padding: [60, 60], maxZoom: 16 });
        }
      }
      lastFocusKeyRef.current = key;
    }
  }, [vehicles, filters, focusTripId, focusVehicleId, historyOn, routes, onFocusTrip]);

  // Élő becslés: negyed másodpercenként a nyomvonalon továbbvisszük a buszokat
  // (a szakasz szokásos sebességével, legfeljebb a következő megállóig) —
  // követéskor a követett buszt is, és a térkép vele együtt halad.
  useEffect(() => {
    if (historyOn) return;
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
      for (const entry of liveMarkersRef.current.values()) {
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
  }, [historyOn]);

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
    const iconKey = `${route}|${color}|${text}|${id}`;
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
        entry.marker.setIcon(createVehicleIcon(route, color, text, true, id));
        entry.iconKey = iconKey;
      }
      if (!motion) {
        entry.shown = undefined;
        entry.marker.setLatLng([lat, lon]);
      }
      return;
    }
    const marker = L.marker([lat, lon], { icon: createVehicleIcon(route, color, text, true, id), zIndexOffset: 1200, interactive: false }).addTo(layer);
    focusMarkerRef.current = { marker, iconKey, id: id ?? null, motion, shown: undefined, raw: [lat, lon] };
  }, [vehicles, focusTripId, focusVehicleId, focusPath]);

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
    if (v.lat != null && v.lon != null && mapRef.current) {
      mapRef.current.flyTo([v.lat, v.lon], 16, { duration: 0.5 });
    }
  };

  const activeFilters = activeFilterCount(filters);
  const summary = activeFilters ? filterSummary(filters, routes, vehicleResults.length) : "";
  const credit = TILE_CREDIT[tileLayerId] ?? TILE_CREDIT.osm;

  const pickStop = (stop: Stop) => {
    mapRef.current?.flyTo([stop.lat, stop.lon], Math.max(mapRef.current.getZoom(), CLOSE_ZOOM), { duration: 0.7 });
    onSelectStop(stop.id);
  };

  return (
    <div className="relative flex h-full w-full min-w-0 flex-1 overflow-hidden">
      <div className="relative h-full w-full min-w-0 flex-1 bg-background">
        <div ref={mapContainerRef} className="z-map h-full w-full" />

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
        <MapCorner corner="top-right">
          <MapLayersControl
            tileLayerId={tileLayerId}
            onSelectTileLayer={onSelectTileLayer}
            filters={filters}
            setFilters={setFilters}
            watchedStops={monitoredStopIds.length}
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
              onPickPlace={(lat, lon) => mapRef.current?.flyTo([lat, lon], 16, { duration: 0.7 })}
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
        <MapCorner corner="bottom-right" style={historyOn && timelineInset > 0 ? { bottom: timelineInset + 8 } : undefined}>
          {geo.error && (geoAsked || geo.status !== "denied") ? (
            <p role="status" className="pointer-events-auto max-w-[220px] rounded-xl border border-border/80 bg-card/90 px-3 py-2 text-[11.5px] text-muted-foreground shadow-md backdrop-blur-md">
              {geo.error}
            </p>
          ) : null}
          {historyOn ? null : <MapControl icon={History} label="Idővonal" showLabel="wide" title="Visszanézhető, merre jártak a járművek" onClick={openHistory} />}
          <MapControlGroup label="Nagyítás" className="hidden md:flex">
            <MapGroupButton icon={Plus} label="Nagyítás" onClick={() => mapRef.current?.zoomIn()} />
            <MapGroupButton icon={Minus} label="Kicsinyítés" onClick={() => mapRef.current?.zoomOut()} />
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
