import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import L from "leaflet";
import {
  CornerDownLeft,
  Crosshair,
  Hash,
  History,
  Layers,
  LocateFixed,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { FilterState, LiveVehicle, Route, Stop } from "@/types";
import { api } from "@/services/api";
import { RouteChips } from "@/components/fleet/RouteChips";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RouteTile } from "@/components/transit/RouteTile";
import { LiveDot } from "@/components/transit/LiveDot";
import { useGeo } from "@/context/GeoContext";
import { distanceKm, nearest } from "@/lib/geo";
import { initialMapView, saveMapView } from "@/lib/viewState";
import { token } from "@/lib/theme";
import { cn, normalizeSearchText } from "@/lib/utils";
import { MapTimeline } from "./MapTimeline";
import { createVehicleIcon } from "./vehicleIcon";
import { estimatePosition, type Shown } from "./liveMotion";
import { boardVehicle } from "@/components/ride/RideLayer";
import { serverNow } from "@/lib/realtime";

export interface TileLayerOption {
  id: string;
  name: string;
  note: string;
  url: string;
  labelsUrl?: string;
  attribution: string;
  maxNativeZoom: number;
  swatch: string;
  filter?: string;
}

const OSM_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> közreműködők';
const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const TILE_LAYERS: TileLayerOption[] = [
  {
    id: "osm",
    name: "Utcatérkép",
    note: "OpenStreetMap",
    url: OSM_URL,
    attribution: OSM_ATTRIB,
    maxNativeZoom: 19,
    swatch: "#E8E0D8",
  },
  {
    id: "dark",
    name: "Sötét",
    note: "Sötétített OpenStreetMap",
    url: OSM_URL,
    attribution: OSM_ATTRIB,
    maxNativeZoom: 19,
    swatch: "#20241F",
    filter:
      "invert(1) hue-rotate(180deg) brightness(0.86) contrast(0.92) saturate(0.65)",
  },
  {
    id: "light",
    name: "Halvány",
    note: "Kifakított OpenStreetMap",
    url: OSM_URL,
    attribution: OSM_ATTRIB,
    maxNativeZoom: 19,
    swatch: "#DEDEDC",
    filter: "grayscale(0.85) brightness(1.06) contrast(0.9)",
  },
  {
    id: "satellite",
    name: "Műhold",
    note: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    labelsUrl:
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    attribution:
      '&copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
    maxNativeZoom: 19,
    swatch: "#3F5B3C",
  },
  {
    id: "topo",
    name: "Domborzat",
    note: "OpenTopoMap",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution:
      'Csempe: <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), adat: &copy; OpenStreetMap',
    maxNativeZoom: 17,
    swatch: "#CBD3B0",
  },
];

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


function FilterSection({
  title,
  aside,
  last,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "space-y-2.5 px-4 py-3.5",
        !last && "border-b border-border",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {typeof aside === "string" ? (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {aside}
          </span>
        ) : (
          aside
        )}
      </div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/60 p-1"
      >
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            aria-pressed={value === o.id}
            className={cn(
              "rounded-md py-1.5 text-xs font-semibold transition-all duration-fast",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              value === o.id
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChipRow<T>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          disabled={disabled && o.value !== null}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-all duration-fast",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-40",
            value === o.value
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg px-1 py-2 transition-colors duration-fast hover:bg-accent">
      <Label htmlFor={id} className="cursor-pointer text-xs font-medium">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

const MAX_WATCHED = 12;

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
  tileLayerId: string;
  selectedStopId: string | null;
  monitoredStopIds: string[];
  onToggleMonitorStop: (stopId: string) => void;
  onOpenMapPicker: () => void;
}

const MOTION_TICK_MS = 250;

type LiveMarker = { marker: L.Marker; iconKey: string; v: LiveVehicle; shown: Shown | undefined };

/** A jármű buborékja (megnyitáskor készül, így mindig a friss adatot mutatja). */
function vehiclePopupHtml(v: LiveVehicle): string {
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
            v.tripId
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
  tileLayerId,
  selectedStopId,
  monitoredStopIds,
  onToggleMonitorStop,
  onOpenMapPicker,
}: TransitMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const labelLayerRef = useRef<L.TileLayer | null>(null);
  const stopLayerRef = useRef<L.LayerGroup | null>(null);
  const busLayerRef = useRef<L.LayerGroup | null>(null);
  const liveMarkersRef = useRef(new Map<string, LiveMarker>());
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const focusLayerRef = useRef<L.LayerGroup | null>(null);
  const geoCacheRef = useRef<Record<string, [number, number][][]>>({});
  const lastFocusKeyRef = useRef<string>("");

  const [isPanelOpen, setPanelOpen] = useState(false);
  const geo = useGeo();
  const autoZoomRef = useRef<"none" | "stale" | "done">("none");
  const geoLayerRef = useRef<L.LayerGroup | null>(null);
  const [stopQuery, setStopQuery] = useState("");
  const [typedId, setTypedId] = useState("");

  const [codeOpen, setCodeOpen] = useState(false);
  const [codeValue, setCodeValue] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Idővonal: amíg él, az élő járművek helyett a visszajátszás látszik.
  const [historyOn, setHistoryOn] = useState(false);
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
  }, [filters.routes, filters.shape, routes]);

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
    if (focusTripId || historyOn) {
      layer.clearLayers();
      live.clear();
      return;
    }

    const visible = getVisibleVehicles();
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
      const iconKey = `${v.routeShort}|${v.routeColor}|${v.routeText}|${tracked}|${showId}`;
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
          entry.iconKey = iconKey;
        }
        if (!v.motion) entry.marker.setLatLng([v.lat, v.lon]);
        return;
      }

      const marker = L.marker([v.lat, v.lon], { icon: icon(), zIndexOffset: tracked ? 1000 : 500 });
      const created: LiveMarker = { marker, iconKey, v, shown: undefined };
      marker.bindPopup(() => vehiclePopupHtml(created.v));
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

    if (filters.watch.length > 0 || activeQ) {
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
  }, [vehicles, filters, focusTripId, historyOn, routes, onFocusTrip]);

  // Élő becslés: negyed másodpercenként a nyomvonalon továbbvisszük a buszokat
  // (a szakasz szokásos sebességével, legfeljebb a következő megállóig).
  useEffect(() => {
    if (focusTripId || historyOn) return;
    const tick = () => {
      const now = serverNow();
      for (const entry of liveMarkersRef.current.values()) {
        const est = estimatePosition(entry.v.motion, now, entry.shown);
        if (!est) continue;
        entry.shown = est.shown;
        entry.marker.setLatLng(est.latlng);
      }
    };
    tick();
    const t = setInterval(tick, MOTION_TICK_MS);
    return () => clearInterval(t);
  }, [focusTripId, historyOn]);

  useEffect(() => {
    if (!mapRef.current || !focusLayerRef.current) return;
    const layer = focusLayerRef.current;
    layer.clearLayers();
    if (!focusTripId) return;

    let alive = true;

    const draw = async (fit: boolean) => {
      try {
        const res = await api.getTripPath(
          focusTripId,
          focusVehicleId || undefined,
        );
        if (!alive) return;

        layer.clearLayers();
        const color = `#${res.color || "1FB574"}`;
        const halo = token("--background");
        const bounds: [number, number][] = [];

        if (res.shape?.length) {
          L.polyline(res.shape, {
            color: halo,
            weight: 8,
            opacity: 0.6,
            interactive: false,
          }).addTo(layer);
          L.polyline(res.shape, {
            color,
            weight: 4,
            opacity: 0.95,
            interactive: false,
          }).addTo(layer);
          res.shape.forEach((pt) => bounds.push(pt));
        }

        if (res.vehicle?.lat != null && res.vehicle?.lon != null) {
          L.marker([res.vehicle.lat, res.vehicle.lon], {
            icon: createVehicleIcon(
              res.route,
              res.color,
              res.text,
              true,
              res.vehicle.id,
            ),
            zIndexOffset: 1200,
          }).addTo(layer);

          bounds.push([res.vehicle.lat, res.vehicle.lon]);

          if (fit && mapRef.current) {
            // Rákövetéskor azonnal, animáció nélkül a járműre zoomolunk —
            // nem a teljes útvonalra, hogy ne kelljen várni a következő
            // frissítési ciklusra.
            mapRef.current.setView([res.vehicle.lat, res.vehicle.lon], 15, {
              animate: false,
            });
          } else if (mapRef.current) {
            mapRef.current.flyTo([res.vehicle.lat, res.vehicle.lon], 15, {
              duration: 0.5,
            });
          }
        } else if (fit && bounds.length && mapRef.current) {
          mapRef.current.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
        }
      } catch {}
    };

    draw(true);
    const timer = setInterval(() => draw(false), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [focusTripId, focusVehicleId]);

  const addWatch = (value?: string) => {
    const target = (value ?? typedId).trim();
    if (!target || filters.watch.length >= MAX_WATCHED) return;
    if (filters.watch.some((x) => x.toLowerCase() === target.toLowerCase()))
      return;
    setFilters((prev) => ({ ...prev, watch: [...prev.watch, target], vq: "" }));
    setTypedId("");
  };

  const removeWatch = (value: string) =>
    setFilters((prev) => ({
      ...prev,
      watch: prev.watch.filter((x) => x.toLowerCase() !== value.toLowerCase()),
    }));

  const toggleRoute = (routeId: string) =>
    setFilters((prev) => ({
      ...prev,
      routes: prev.routes.includes(routeId)
        ? prev.routes.filter((id) => id !== routeId)
        : [...prev.routes, routeId],
    }));

  // A megállók GTFS-azonosítója kocsiállásonként/irányonként külön sor —
  // ugyanaz a hely (pl. "Villanyrendőr") így sokszor szerepelne egymás
  // alatt. A kódot senki nem tudja fejből, de a térképen ránézve ki tudja
  // választani a neki kellő szürke pöttyöt — ezért a keresés a HELY nevére
  // csoportosít, a kiválasztás pedig csak a közelébe zoomol, nem választ
  // helyette egy konkrét pöttyöt.
  const stopResults = useMemo(() => {
    const q = normalizeSearchText(stopQuery.trim());
    const source = q
      ? stops.filter(
          (s) =>
            normalizeSearchText(s.name).includes(q) ||
            (s.code && normalizeSearchText(s.code).includes(q)) ||
            s.id.toLowerCase().includes(q),
        )
      : stops;

    const byName = new Map<string, Stop[]>();
    for (const s of source) {
      const list = byName.get(s.name) ?? [];
      list.push(s);
      byName.set(s.name, list);
    }

    return [...byName.entries()]
      .map(([name, group]) => ({
        name,
        group,
        lat: group.reduce((sum, s) => sum + s.lat, 0) / group.length,
        lon: group.reduce((sum, s) => sum + s.lon, 0) / group.length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "hu"))
      .slice(0, 80);
  }, [stops, stopQuery]);

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

  /**
   * Megállókód → megálló. A GTFS-azonosító `SP` + kód alakú, a kiírt tábla
   * viszont csak a számot mutatja, ezért mindkettőt elfogadjuk.
   */
  const findByCode = (raw: string): Stop | null => {
    const code = raw.trim().replace(/^sp/i, "");
    if (!code) return null;
    const lower = code.toLowerCase();
    return (
      stops.find((s) => s.id.toLowerCase() === `sp${lower}`) ??
      stops.find((s) => s.id.toLowerCase() === lower) ??
      null
    );
  };

  const closeCodeSearch = () => {
    setCodeOpen(false);
    setCodeValue("");
    setCodeError(null);
  };

  const jumpToCode = async () => {
    const raw = codeValue.trim();
    if (!raw) return;

    const local = findByCode(raw);
    if (local) {
      mapRef.current?.flyTo([local.lat, local.lon], CLOSE_ZOOM, {
        duration: 0.7,
      });
      onSelectStop(local.id);
      closeCodeSearch();
      return;
    }

    // Nincs a betöltött listában — az arrivals végpont még ismerheti.
    setCodeBusy(true);
    setCodeError(null);
    try {
      const id = `SP${raw.replace(/^sp/i, "")}`;
      const res = await api.getArrivals(id, 16);
      if (res.stop?.lat != null && res.stop?.lon != null) {
        mapRef.current?.flyTo([res.stop.lat, res.stop.lon], CLOSE_ZOOM, {
          duration: 0.7,
        });
      }
      onSelectStop(res.stop?.id ?? id);
      closeCodeSearch();
    } catch {
      setCodeError(`Nincs ${raw} kódú megálló.`);
    } finally {
      setCodeBusy(false);
    }
  };

  const flyToVehicle = (v: LiveVehicle) => {
    if (v.lat != null && v.lon != null && mapRef.current) {
      mapRef.current.flyTo([v.lat, v.lon], 16, { duration: 0.5 });
    }
  };

  const filterActive =
    filters.vq.trim() !== "" ||
    filters.watch.length > 0 ||
    filters.routes.length > 0 ||
    filters.type !== "all" ||
    filters.speed !== "all" ||
    filters.nearMeKm != null ||
    filters.onlyWatched ||
    !filters.stops;

  const filterSummary = filters.watch.length
    ? `${filters.watch.join(", ")} követése`
    : filters.routes.length
      ? `${filters.routes.length} járat · ${vehicleResults.length} jármű`
      : filters.nearMeKm != null
        ? `${filters.nearMeKm < 1 ? `${filters.nearMeKm * 1000} m` : `${filters.nearMeKm} km`} sugarú körben`
        : filters.speed === "moving"
          ? "Csak mozgó járművek"
          : filters.speed === "idle"
            ? "Csak álló járművek"
            : filters.onlyWatched
              ? `Csak a figyelt megállók (${monitoredStopIds.length})`
              : `Szűrés aktív · ${vehicleResults.length} jármű`;

  const LAYER_TOGGLES = [
    { key: "stops", label: "Megállók" },
    { key: "onlyWatched", label: `Csak a figyeltek (${monitoredStopIds.length})` },
    { key: "shape", label: "Járatnyomvonal" },
    { key: "labels", label: "Rendszámok a csempéken" },
  ] as const;

  const RADIUS_OPTIONS: { value: number | null; label: string }[] = [
    { value: null, label: "Nincs" },
    { value: 0.5, label: "500 m" },
    { value: 1.5, label: "1,5 km" },
    { value: 5, label: "5 km" },
  ];

  return (
    <div className="relative flex h-full w-full min-w-0 flex-1 overflow-hidden">
      {}
      {isPanelOpen ? (
        <button
          type="button"
          aria-label="Vezérlőpanel bezárása"
          onClick={() => setPanelOpen(false)}
          className="absolute inset-0 z-drawer bg-background/70 backdrop-blur-sm md:hidden"
        />
      ) : null}

      {}
      <Tabs
        defaultValue="filter"
        className={cn(
          "absolute inset-y-0 left-0 z-drawer flex w-[86%] max-w-[340px] flex-col overflow-hidden",
          "border-r border-border bg-card shadow-xl transition-transform duration-normal ease-out",
          "md:static md:z-overlay md:w-[340px] md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none lg:w-[380px]",
          isPanelOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="shrink-0 border-b border-border p-2">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="filter" className="text-xs">
              Szűrés
            </TabsTrigger>
            <TabsTrigger value="fleet" className="gap-1.5 text-xs">
              Járművek
              <span className="rounded bg-primary/15 px-1 font-mono text-[10px] font-bold tabular-nums text-primary">
                {vehicleResults.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="stops" className="text-xs">
              Megállók
            </TabsTrigger>
          </TabsList>
        </div>

        {}
        <TabsContent
          value="filter"
          className="mt-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden focus-visible:outline-none"
        >
          {/* Követés — ez a leggyakoribb művelet, ezért ez van legfelül. */}
          <FilterSection
            title="Jármű követése"
            aside={
              filters.watch.length > 0
                ? `${filters.watch.length}/${MAX_WATCHED}`
                : undefined
            }
          >
            <div className="flex items-center gap-2">
              <Input
                value={typedId}
                onChange={(e) => {
                  const digits = e.target.value.replace(/[^0-9]/g, "");
                  setTypedId(digits);
                  setFilters((prev) => ({ ...prev, vq: digits }));
                }}
                onKeyDown={(e) => e.key === "Enter" && addWatch()}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                enterKeyHint="done"
                placeholder="Rendszám, pl. 1641"
                aria-label="Jármű rendszáma"
                className="h-10 font-mono tabular-nums"
              />
              <Button
                size="icon"
                className="h-10 w-10 shrink-0"
                onClick={() => addWatch()}
                disabled={
                  !typedId.trim() || filters.watch.length >= MAX_WATCHED
                }
                aria-label="Jármű hozzáadása a követési listához"
              >
                <Plus />
              </Button>
            </div>

            {filters.watch.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {filters.watch.map((id) => (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => removeWatch(id)}
                      aria-label={`${id} eltávolítása a követésből`}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/35 bg-primary/12 px-2.5",
                        "font-mono text-xs font-bold tabular-nums text-primary",
                        "transition-colors duration-fast hover:border-destructive/50 hover:bg-destructive/12 hover:text-destructive",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      )}
                    >
                      {id}
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <ToggleRow
              id="follow-toggle"
              label="Térkép kövesse a járművet"
              checked={filters.follow}
              onChange={(v) => setFilters((prev) => ({ ...prev, follow: v }))}
            />
          </FilterSection>

          {/* Két egysoros választó egymás mellett — kevesebb görgetés. */}
          <FilterSection title="Mit mutasson">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Segmented
                label="Típus"
                value={filters.type}
                onChange={(v) => setFilters((prev) => ({ ...prev, type: v }))}
                options={[
                  { id: "all", label: "Mind" },
                  { id: "bus", label: "Busz" },
                  { id: "tram", label: "Villamos" },
                ]}
              />
              <Segmented
                label="Mozgás"
                value={filters.speed}
                onChange={(v) => setFilters((prev) => ({ ...prev, speed: v }))}
                options={[
                  { id: "all", label: "Mind" },
                  { id: "moving", label: "Mozgó" },
                  { id: "idle", label: "Álló" },
                ]}
              />
            </div>
          </FilterSection>

          <FilterSection
            title="A közelemben"
            aside={
              !geo.position ? (
                <button
                  type="button"
                  onClick={geo.start}
                  className="text-[11px] font-semibold text-primary underline underline-offset-4"
                >
                  GPS bekapcsolása
                </button>
              ) : undefined
            }
          >
            <ChipRow
              options={RADIUS_OPTIONS}
              value={filters.nearMeKm}
              disabled={!geo.position}
              onChange={(v) =>
                setFilters((prev) => ({ ...prev, nearMeKm: v }))
              }
            />
          </FilterSection>

          <FilterSection
            title="Járatok"
            aside={
              filters.routes.length > 0
                ? `${filters.routes.length} kiválasztva`
                : "mind"
            }
          >
            <RouteChips
              routes={routes}
              selectedRoutes={filters.routes}
              onToggleRoute={toggleRoute}
              onSetRoutes={(ids) =>
                setFilters((prev) => ({ ...prev, routes: ids }))
              }
              liveVehicles={vehicles}
            />
          </FilterSection>

          <FilterSection title="Megjelenítés" last>
            <div className="space-y-0.5">
              {LAYER_TOGGLES.map(({ key, label }) => (
                <ToggleRow
                  key={key}
                  id={`layer-${key}`}
                  label={label}
                  checked={filters[key] as boolean}
                  onChange={(v) =>
                    setFilters((prev) => ({ ...prev, [key]: v }))
                  }
                />
              ))}
            </div>

            <Button
              variant="outline"
              className="mt-1 w-full justify-start"
              onClick={onOpenMapPicker}
            >
              <Layers />
              Alaptérkép
            </Button>
          </FilterSection>

          {filterActive ? (
            <div className="sticky bottom-0 border-t border-border bg-card/95 p-3 backdrop-blur-sm">
              <Button
                variant="outline"
                className="w-full"
                onClick={onClearFilters}
              >
                Szűrők törlése
              </Button>
            </div>
          ) : null}
        </TabsContent>

        {}
        <TabsContent
          value="fleet"
          className="mt-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden focus-visible:outline-none"
        >
          {}
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-4 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Rendezés
            </span>
            <div className="flex gap-1">
              {(
                [
                  { id: "route", label: "Járat" },
                  { id: "id", label: "Rendszám" },
                  { id: "speed", label: "Sebesség" },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() =>
                    setFilters((prev) => ({ ...prev, sort: option.id }))
                  }
                  aria-pressed={filters.sort === option.id}
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] font-semibold transition-colors duration-fast",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    filters.sort === option.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {vehicleResults.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              A jelenlegi szűrésnek egy jármű sem felel meg.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {vehicleResults.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => {
                      flyToVehicle(v);
                      setPanelOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-fast hover:bg-accent",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
                  >
                    <RouteTile
                      short={v.routeShort}
                      color={v.routeColor}
                      text={v.routeText}
                    />

                    <span className="min-w-0 flex-1">
                      {}
                      <span className="flex items-center gap-1.5 font-mono text-sm font-bold tabular-nums">
                        {v.id}
                        <LiveDot />
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {v.headsign}
                      </span>
                    </span>

                    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-muted-foreground">
                      {v.speed != null
                        ? `${Math.round(v.speed * 3.6)} km/h`
                        : "—"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        {}
        <TabsContent
          value="stops"
          className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden focus-visible:outline-none"
        >
          <div className="shrink-0 border-b border-border px-4 py-3">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={stopQuery}
                onChange={(e) => setStopQuery(e.target.value)}
                placeholder="Megálló neve vagy kódja"
                aria-label="Megálló keresése"
                className="pl-9"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {stopResults.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                Nincs „{stopQuery}” nevű megálló.
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {stopResults.map((g) => {
                  const single = g.group.length === 1 ? g.group[0] : null;
                  const isSelected = g.group.some((s) => s.id === selectedStopId);
                  const watched = single
                    ? monitoredStopIds.includes(single.id)
                    : false;
                  return (
                    <li
                      key={g.name}
                      className={cn(
                        "flex items-center gap-1 transition-colors duration-fast",
                        isSelected ? "bg-primary/10" : "hover:bg-accent",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (single) {
                            onSelectStop(single.id);
                          } else if (mapRef.current) {
                            mapRef.current.flyTo([g.lat, g.lon], 16, {
                              duration: 0.7,
                            });
                          }
                          setPanelOpen(false);
                        }}
                        className="min-w-0 flex-1 px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="block truncate text-xs font-medium">
                          {g.name}
                        </span>
                        <span className="block font-mono text-[11px] tabular-nums text-muted-foreground">
                          {single ? single.id : `${g.group.length} megálló`}
                        </span>
                      </button>

                      {single ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant={watched ? "default" : "ghost"}
                              size="icon"
                              className="mr-3 h-7 w-7 shrink-0"
                              onClick={() => onToggleMonitorStop(single.id)}
                              aria-pressed={watched}
                              aria-label={
                                watched
                                  ? `${g.name} levétele a figyelőről`
                                  : `${g.name} felvétele a figyelőre`
                              }
                            >
                              <Plus className={cn(watched && "rotate-45")} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {watched
                              ? "Levétel a figyelőről"
                              : "Felvétel a figyelőre"}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {}
      <div className="relative h-full w-full min-w-0 flex-1 bg-background">
        <div ref={mapContainerRef} className="z-map h-full w-full" />

        {}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPanelOpen(true)}
          className="absolute left-3 top-3 z-overlay shadow-lg md:hidden"
        >
          <SlidersHorizontal />
          Szűrés
        </Button>

        {}
        <Button
          variant="secondary"
          size="icon"
          onClick={() => {
            setCodeOpen(true);
            setCodeError(null);
            requestAnimationFrame(() => codeInputRef.current?.focus());
          }}
          aria-label="Ugrás megállókód alapján"
          className={cn(
            "absolute bottom-3 left-3 z-overlay h-11 w-11 shadow-lg mb-[env(safe-area-inset-bottom)]",
            historyOn && "hidden",
          )}
        >
          <Hash />
        </Button>

        {}
        {codeOpen ? (
          <div className="absolute inset-0 z-drawer flex items-center justify-center px-6">
            <button
              type="button"
              aria-label="Megállókód-kereső bezárása"
              onClick={closeCodeSearch}
              className="absolute inset-0 bg-background/60 backdrop-blur-sm"
            />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                jumpToCode();
              }}
              className="relative w-full max-w-[260px] rounded-2xl border border-border bg-card p-3 shadow-2xl"
            >
              <label
                htmlFor="stop-code"
                className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Megállókód
              </label>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  id="stop-code"
                  ref={codeInputRef}
                  value={codeValue}
                  onChange={(e) => {
                    setCodeValue(e.target.value.replace(/[^0-9]/g, ""));
                    setCodeError(null);
                  }}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  enterKeyHint="go"
                  placeholder="pl. 1"
                  aria-label="Megálló kódja"
                  className="h-12 text-center font-mono text-xl font-bold tabular-nums"
                />
                <Button
                  type="submit"
                  size="icon"
                  className="h-12 w-12 shrink-0"
                  disabled={!codeValue.trim() || codeBusy}
                  aria-label="Ugrás a megállóhoz"
                >
                  <CornerDownLeft />
                </Button>
              </div>
              {codeError ? (
                <p role="alert" className="mt-2 text-[11px] text-destructive">
                  {codeError}
                </p>
              ) : null}
            </form>
          </div>
        ) : null}

        {/* Jobb alsó oszlop; az idővonal-sáv alatt nem bújhat el, ezért fölé emelkedik. */}
        <div
          className="absolute bottom-3 right-3 z-overlay mb-[env(safe-area-inset-bottom)] flex flex-col items-end gap-2"
          style={
            historyOn && timelineInset > 0
              ? { bottom: timelineInset + 8 }
              : undefined
          }
        >
          {historyOn ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  className="h-11 gap-2 px-3.5 shadow-lg"
                  onClick={openHistory}
                  aria-label="Idővonal: korábbi járműmozgások visszajátszása"
                >
                  <History />
                  Idővonal
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                Visszanézhető, merre jártak a járművek
              </TooltipContent>
            </Tooltip>
          )}

          {geo.error && (geoAsked || geo.status !== "denied") ? (
            <p
              role="status"
              className="max-w-[220px] rounded-lg border border-border bg-card/95 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-lg backdrop-blur-sm"
            >
              {geo.error}
            </p>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={geo.isActive ? "default" : "secondary"}
                size="icon"
                className="h-11 w-11 shadow-lg"
                onClick={handleLocate}
                disabled={geo.status === "requesting"}
                aria-label={
                  geo.position
                    ? "Ugrás a helyzetemre"
                    : "Helymeghatározás bekapcsolása"
                }
              >
                <LocateFixed
                  className={cn(geo.status === "requesting" && "animate-pulse")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {geo.position
                ? "Helyzetem és a közeli megállók"
                : "Helymeghatározás bekapcsolása"}
            </TooltipContent>
          </Tooltip>
        </div>

        {historyOn ? (
          <MapTimeline
            mapRef={mapRef}
            routes={routes}
            filters={filters}
            onExit={() => setHistoryOn(false)}
            onInsetChange={setTimelineInset}
          />
        ) : null}

        {focusTripId ? (
          <div className="absolute left-3 top-[3.4rem] z-overlay md:left-4 md:top-4">
            <Button onClick={onExitFocus} className="shadow-xl">
              Menetkövetés vége
            </Button>
          </div>
        ) : null}

        {}
        {filterActive && !focusTripId ? (
          <button
            type="button"
            onClick={onClearFilters}
            aria-label={`${filterSummary} — szűrők törlése`}
            title={filterSummary}
            className={cn(
              "absolute right-3 top-3 z-overlay inline-flex h-9 items-center gap-1 rounded-lg px-2",
              "border border-primary/40 bg-primary/15 text-primary shadow-lg backdrop-blur-sm",
              "transition-colors duration-fast active:bg-primary/25",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:hidden",
            )}
          >
            <SlidersHorizontal aria-hidden className="h-4 w-4" />
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        ) : null}

        {}
        {filterActive && !focusTripId ? (
          <div className="absolute right-4 top-4 z-overlay hidden max-w-sm items-center gap-3 rounded-xl border border-border bg-card/95 px-3.5 py-2.5 shadow-xl backdrop-blur-sm md:flex">
            <Crosshair aria-hidden className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 truncate text-xs font-medium">
              {filterSummary}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={onClearFilters}
            >
              Alaphelyzet
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
