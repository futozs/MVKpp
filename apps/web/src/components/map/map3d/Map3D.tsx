/**
 * 3D térkép (MapLibre GL + OpenFreeMap): épületek, domborzat, dönthető-forgatható
 * kamera, követéskor a busz mögül néző kamera. Csak bekapcsolásra töltődik le
 * (a TransitMap lusta importja), és a 2D térkép adatait kapja meg.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Map as MLMap, Popup, type LngLatBounds } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LiveVehicle, Route, Stop } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { serverNow } from "@/lib/realtime";
import { getActiveRide } from "@/lib/rides";
import { token } from "@/lib/theme";
import { isRegionalId, vehicleModeOf } from "@/lib/modes";
import { escapeHtml, vehicleIconHtml, vehicleIdText } from "../vehicleIcon";
import { trafficPopupHtml, type TrafficSegment } from "../liveTraffic";
import { easeInOutCubic } from "./chaseCam";
import { FocusFollower, type Focus3D } from "./follow3d";
import { load3DStyle } from "./style3d";
import { ensureOverlays, setMe, setRouteLines, setStops, setTraffic, STOP_LAYERS, TRAFFIC_LAYER, type OverlayColors } from "./overlays3d";
import { TICK_MS, VehicleMarkers, type LngLat, type MarkerSpec } from "./vehicles3d";

export type { Focus3D };

/** a 2D (Leaflet, 256 px-es csempe) és a MapLibre (512 px) nagyítási szintje között ennyi a különbség */
const ZOOM_OFFSET = 1;
const MAX_PITCH = 72;
/** bekapcsoláskor a kamera ennyire dől meg, és legalább ennyire közelít (itt már látszanak a házak) */
const BROWSE_PITCH = 55;
const BROWSE_BEARING = -18;
const BROWSE_MIN_ZOOM = 14.6;
/** a regionális járművek mozgásbecslése ettől a nagyítástól (mint a 2D-ben) */
const REGIONAL_MOTION_ZOOM = 11 - ZOOM_OFFSET;
/** követés közben a többi jármű halványabban */
const DIM_OPACITY = 0.55;
/** görgetés után ennyi ideig a kamera nem nyúl a térképhez (ms) */
const WHEEL_QUIET_MS = 350;
/** a nézet mentése legfeljebb ilyen gyakran (követéskor a kamera folyton mozog) (ms) */
const SAVE_VIEW_MS = 2000;

const IS_TOUCH = typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false);
/** érintéskor ekkora ráhagyással találja el a megállópöttyöt (px) */
const HIT_TOLERANCE = IS_TOUCH ? 15 : 6;
const REDUCED_MOTION = typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

/** nézet a 2D nagyítási skáláján */
export type Map3DView = { lat: number; lon: number; zoom: number };

export interface Map3DHandle {
  flyTo(lat: number, lon: number, zoom: number): void;
  fitBounds(points: [number, number][], maxZoom: number): void;
  zoomBy(delta: number): void;
  view(): Map3DView | null;
  resumeFollow(): void;
  /** kikapcsolás előtt a kamera visszaáll felülnézetbe */
  flatten(): Promise<void>;
}

export interface Map3DProps {
  tileLayerId: string;
  initialView: Map3DView;
  /** a látható járművek (a követett nélkül) */
  vehicles: LiveVehicle[];
  routes: Record<string, Route>;
  watch: string[];
  vq: string;
  labels: boolean;
  dim: boolean;
  focus: Focus3D | null;
  stops: Stop[];
  watchedStopIds: string[];
  selectedStopId: string | null;
  routeLines: { color: string; lines: [number, number][][] }[];
  traffic: TrafficSegment[];
  position: GeoPosition | null;
  /** a telefon friss helyzete: utazás közben ez viszi a buszt, amin ülsz */
  ridePosition: GeoPosition | null;
  onSelectStop: (stopId: string) => void;
  onFocusTrip: (tripId: string, vehicleId?: string) => void;
  onFollowPausedChange: (paused: boolean) => void;
  onViewChange: (view: Map3DView) => void;
  /** nincs WebGL, vagy nem jött le az alaptérkép: vissza a 2D-re */
  onFail: () => void;
}

function overlayColors(): OverlayColors {
  return { halo: token("--background"), neutral: token("--muted-foreground"), brand: token("--primary"), mine: token("--early") };
}

/** A látott rész (dőlt kameránál a befoglaló téglalap), `share`-rel megnövelve. */
function paddedBounds(map: MLMap, share: number): LngLatBounds {
  const b = map.getBounds();
  const dx = (b.getEast() - b.getWest()) * share;
  const dy = (b.getNorth() - b.getSouth()) * share;
  b.setSouthWest([b.getWest() - dx, b.getSouth() - dy]);
  b.setNorthEast([b.getEast() + dx, b.getNorth() + dy]);
  return b;
}

const inBounds = (b: LngLatBounds, p: LngLat) => p[0] >= b.getWest() && p[0] <= b.getEast() && p[1] >= b.getSouth() && p[1] <= b.getNorth();

function markerSpecs({ vehicles, routes, watch, vq, labels, dim }: Map3DProps): MarkerSpec[] {
  const watchSet = new Set(watch.map((w) => w.toLowerCase()));
  const q = vq.trim().toLowerCase();
  return vehicles.map((v) => {
    const tracked = watchSet.has(v.id.toLowerCase()) || (q ? v.id.toLowerCase().includes(q) : false);
    const mode = vehicleModeOf(v, routes[v.routeId]?.type);
    const idText = labels || tracked ? vehicleIdText(v, mode) : null;
    return {
      v,
      key: `${v.routeShort}|${v.routeColor}|${v.routeText}|${tracked}|${idText ?? ""}|${dim}|${mode}|${v.estimated ? 1 : 0}`,
      html: () => vehicleIconHtml(v.routeShort || "?", v.routeColor || "1FB574", v.routeText || "FFFFFF", tracked, idText, { mode, estimated: v.estimated }),
      z: tracked ? 3 : 1,
      opacity: dim ? DIM_OPACITY : 1,
    };
  });
}

export const Map3D = forwardRef<Map3DHandle, Map3DProps>(function Map3D(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<VehicleMarkers | null>(null);
  const followerRef = useRef<FocusFollower | null>(null);
  /** minden stílusbetöltés új verzió: a rétegek adatai ilyenkor újra felkerülnek */
  const [styleReady, setStyleReady] = useState(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  const loadedStyleRef = useRef(props.tileLayerId);

  useImperativeHandle(ref, () => ({
    flyTo(lat, lon, zoom) {
      mapRef.current?.flyTo({ center: [lon, lat], zoom: zoom - ZOOM_OFFSET, duration: 1100, essential: true });
    },
    fitBounds(points, maxZoom) {
      const map = mapRef.current;
      if (!map || points.length === 0) return;
      const lons = points.map((p) => p[1]);
      const lats = points.map((p) => p[0]);
      map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 80, maxZoom: maxZoom - ZOOM_OFFSET, duration: 900 },
      );
    },
    zoomBy(delta) {
      const map = mapRef.current;
      if (map) map.zoomTo(map.getZoom() + delta, { duration: 300 });
    },
    view() {
      const map = mapRef.current;
      if (!map) return null;
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng, zoom: map.getZoom() + ZOOM_OFFSET };
    },
    resumeFollow() {
      followerRef.current?.resume(performance.now());
    },
    flatten() {
      const map = mapRef.current;
      if (!map || REDUCED_MOTION) return Promise.resolve();
      return new Promise<void>((resolve) => {
        map.once("moveend", () => resolve());
        map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 450 });
      });
    },
  }));

  // A térkép egyszer épül fel; a stílus (alaptérkép) cseréje lent.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ctl = new AbortController();
    const cleanup: (() => void)[] = [];
    const p0 = propsRef.current;

    load3DStyle(p0.tileLayerId, ctl.signal)
      .then((style) => {
        if (ctl.signal.aborted) return;
        let map: MLMap;
        try {
          map = new MLMap({
            container,
            style,
            center: [p0.initialView.lon, p0.initialView.lat],
            zoom: p0.initialView.zoom - ZOOM_OFFSET,
            maxPitch: MAX_PITCH,
            attributionControl: false,
            fadeDuration: 200,
          });
        } catch {
          // nincs WebGL (régi eszköz, letiltott hardveres gyorsítás)
          propsRef.current.onFail();
          return;
        }
        mapRef.current = map;
        // Egy-egy hiányzó csempe nem végzetes (a térkép újrapróbálja); a konzolt ne árassza el.
        map.on("error", () => undefined);
        const markers = new VehicleMarkers(map, (tripId, vehicleId) => propsRef.current.onFocusTrip(tripId, vehicleId));
        const follower = new FocusFollower(map, (paused) => propsRef.current.onFollowPausedChange(paused), () => token("--muted-foreground"));
        markersRef.current = markers;
        followerRef.current = follower;

        map.on("style.load", () => {
          ensureOverlays(map, overlayColors(), IS_TOUCH);
          follower.restyle();
          setStyleReady((n) => n + 1);
        });
        map.once("load", () => {
          if (propsRef.current.focus || REDUCED_MOTION) return;
          // bekapcsoláskor a város „felemelkedik”
          map.easeTo({ pitch: BROWSE_PITCH, bearing: BROWSE_BEARING, zoom: Math.max(map.getZoom(), BROWSE_MIN_ZOOM), duration: 1800, easing: easeInOutCubic });
        });

        wireInteractions(map, follower, propsRef);
        cleanup.push(runLoop(map, markers, follower, propsRef));
        // a térkép helye nem csak ablakméretre változik (követés panelje, telefon elforgatása)
        const resize = new ResizeObserver(() => map.resize());
        resize.observe(container);
        cleanup.push(() => resize.disconnect());
      })
      .catch(() => {
        if (!ctl.signal.aborted) propsRef.current.onFail();
      });

    return () => {
      ctl.abort();
      cleanup.forEach((fn) => fn());
      const map = mapRef.current;
      if (map) {
        const c = map.getCenter();
        propsRef.current.onViewChange({ lat: c.lat, lon: c.lng, zoom: map.getZoom() + ZOOM_OFFSET });
      }
      followerRef.current?.destroy();
      markersRef.current?.clear();
      map?.remove();
      mapRef.current = null;
      markersRef.current = null;
      followerRef.current = null;
    };
  }, []);

  // Alaptérkép-csere: új stílus; a saját rétegek a `style.load`-ra visszakerülnek.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || loadedStyleRef.current === props.tileLayerId) return;
    loadedStyleRef.current = props.tileLayerId;
    const ctl = new AbortController();
    load3DStyle(props.tileLayerId, ctl.signal)
      .then((style) => {
        // közben már másik alaptérképet választottak
        if (ctl.signal.aborted) return;
        // A régi domborzat a csere alatt nem rajzolhat (az új stílus vetülete még nincs kész —
        // MapLibre-hiba); az új stílus a betöltésekor visszateszi a sajátját.
        map.setTerrain(null);
        map.setStyle(style, { diff: false });
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [props.tileLayerId]);

  const { vehicles, routes, watch, vq, labels, dim, focus, stops, watchedStopIds, selectedStopId, routeLines, traffic, position } = props;

  useEffect(() => {
    markersRef.current?.sync(markerSpecs(propsRef.current), performance.now());
  }, [vehicles, routes, watch, vq, labels, dim, styleReady]);

  useEffect(() => {
    followerRef.current?.set(focus, performance.now());
  }, [focus, styleReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    setStops(map, { list: stops, watched: new Set(watchedStopIds), selected: selectedStopId, touch: IS_TOUCH, c: overlayColors() });
  }, [stops, watchedStopIds, selectedStopId, styleReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && styleReady) setRouteLines(map, routeLines);
  }, [routeLines, styleReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && styleReady) setTraffic(map, traffic);
  }, [traffic, styleReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && styleReady) setMe(map, position);
  }, [position, styleReady]);

  // (a MapLibre `position: relative`-et tesz a saját elemére: a helyét a burkoló adja)
  return (
    <div className="absolute inset-0 z-map">
      <div ref={containerRef} className="mvk-map3d h-full w-full" />
    </div>
  );
});

/**
 * Felhasználói mozdulatok: elhúzásra a követés megáll, kézi forgatásra a kamera
 * pár másodpercig nem fordul a busz mögé; megálló és dugó kattintásra.
 * (A figyelők a térképpel együtt szűnnek meg.)
 */
function wireInteractions(map: MLMap, follower: FocusFollower, propsRef: React.MutableRefObject<Map3DProps>): void {
  map.on("dragstart", (e) => {
    if (e.originalEvent) follower.pauseByUser();
  });
  map.on("rotatestart", (e) => {
    if (e.originalEvent) follower.userRotate("start", performance.now());
  });
  map.on("rotateend", () => follower.userRotate("end", performance.now()));

  let lastSave = 0;
  map.on("moveend", () => {
    const now = performance.now();
    if (now - lastSave < SAVE_VIEW_MS) return;
    lastSave = now;
    const c = map.getCenter();
    propsRef.current.onViewChange({ lat: c.lat, lon: c.lng, zoom: map.getZoom() + ZOOM_OFFSET });
  });

  // Megálló: ráhagyással (az ujj nem pixelpontos), a legközelebbi pötty. Dugó: a buborékja.
  map.on("click", (e) => {
    const target = e.originalEvent.target as HTMLElement | null;
    if (target?.closest(".maplibregl-marker, .maplibregl-popup")) return;
    const { x, y } = e.point;
    const stopLayers = STOP_LAYERS.filter((id) => map.getLayer(id));
    const hits = stopLayers.length
      ? map.queryRenderedFeatures(
          [
            [x - HIT_TOLERANCE, y - HIT_TOLERANCE],
            [x + HIT_TOLERANCE, y + HIT_TOLERANCE],
          ],
          { layers: stopLayers },
        )
      : [];
    let best: { id: string; d: number } | null = null;
    for (const f of hits) {
      if (f.geometry.type !== "Point") continue;
      const pt = map.project(f.geometry.coordinates as [number, number]);
      const d = Math.hypot(pt.x - x, pt.y - y);
      if (!best || d < best.d) best = { id: String(f.properties.id), d };
    }
    if (best) {
      propsRef.current.onSelectStop(best.id);
      return;
    }
    if (!map.getLayer(TRAFFIC_LAYER)) return;
    const jam = map.queryRenderedFeatures(
      [
        [x - 4, y - 4],
        [x + 4, y + 4],
      ],
      { layers: [TRAFFIC_LAYER] },
    )[0];
    const seg = jam ? propsRef.current.traffic[Number(jam.properties.i)] : undefined;
    if (seg) new Popup({ offset: 8, maxWidth: "300px", className: "mvk-popup" }).setLngLat(e.lngLat).setHTML(trafficPopupHtml(seg)).addTo(map);
  });

  // Asztalon a megálló neve ráálláskor (érintésnél a koppintás úgyis a részletlapot nyitja).
  if (!IS_TOUCH) {
    const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "mvk-tip" });
    map.on("mousemove", STOP_LAYERS, (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      map.getCanvas().style.cursor = "pointer";
      tip
        .setLngLat(f.geometry.coordinates as [number, number])
        .setHTML(`<strong>${escapeHtml(String(f.properties.name))}</strong><br><span style="opacity:.65">${escapeHtml(String(f.properties.kind))}</span>`)
        .addTo(map);
    });
    map.on("mouseleave", STOP_LAYERS, () => {
      map.getCanvas().style.cursor = "";
      tip.remove();
    });
  }
}

/**
 * A rajzolás üteme: negyedmásodpercenként új célok a becslésből, képkockánként
 * siklás és a követő kamera. Amíg a felhasználó a térképen tartja az ujját (vagy
 * görget), a kamera nem nyúl hozzá — a MapLibre `jumpTo` megszakítaná a mozdulatát.
 */
function runLoop(map: MLMap, markers: VehicleMarkers, follower: FocusFollower, propsRef: React.MutableRefObject<Map3DProps>): () => void {
  const pointers = new Set<number>();
  let lastWheel = -Infinity;
  const canvas = map.getCanvasContainer();
  const down = (e: PointerEvent) => pointers.add(e.pointerId);
  const up = (e: PointerEvent) => pointers.delete(e.pointerId);
  const wheel = () => {
    lastWheel = performance.now();
  };
  canvas.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  canvas.addEventListener("wheel", wheel, { passive: true });

  let raf = 0;
  let lastTick = -Infinity;
  let lastFrame = 0;
  const frame = (t: number) => {
    raf = requestAnimationFrame(frame);
    const p = propsRef.current;
    if (t - lastTick >= TICK_MS) {
      lastTick = t;
      const now = serverNow();
      // Utazás közben a busz, amin ülsz, a telefon GPS-ével megy (ha az friss és a buszhoz illik).
      const ridden = getActiveRide()?.vehicleId ?? null;
      const gps = ridden ? p.ridePosition : null;
      // A Volán- és vasúti járművek csak a látott részen és közelről mozognak a becsléssel (mint a 2D-ben).
      const view = map.getZoom() >= REGIONAL_MOTION_ZOOM ? paddedBounds(map, 0.3) : null;
      markers.tick(
        now,
        t,
        (v) => isRegionalId(v.id) && v.id !== ridden && v.lat != null && v.lon != null && (!view || !inBounds(view, [v.lon, v.lat])),
        (v) => (gps && v.id === ridden ? gps : null),
      );
      follower.tick(now, t, gps);
    }
    const dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 0;
    lastFrame = t;
    const visible = paddedBounds(map, 0.1);
    markers.frame(t, (pos) => inBounds(visible, pos));
    follower.frame(t, dt, pointers.size > 0 || t - lastWheel < WHEEL_QUIET_MS || map.isMoving());
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    canvas.removeEventListener("wheel", wheel);
  };
}
