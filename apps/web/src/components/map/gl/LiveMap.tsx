/**
 * Az élő térkép (MapLibre GL, saját vektorcsempék): egyetlen motor 2D-re és 3D-re.
 * A 3D ugyanaz a térkép megdöntve, domborzattal és épületekkel  a váltás azonnali,
 * nincs második térkép. A járművek egy GPU-rétegen (`VehicleLayer`), a vonalak, dugók,
 * megállók GeoJSON-rétegeken; minden ugyanabban a képkockában készül, semmi nem csúszik
 * el a térképhez képest. Csak akkor rajzol újra, amikor valami annyit mozdult, hogy látszik.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Map as MLMap, LngLatBounds, Popup, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LiveVehicle, Route, Stop } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { serverNow } from "@/lib/realtime";
import { getActiveRide } from "@/lib/rides";
import { token } from "@/lib/theme";
import { isRegionalId, vehicleModeOf } from "@/lib/modes";
import { escapeHtml, safeHex, vehicleIdText } from "../vehicleIcon";
import { trafficPopupHtml, type TrafficSegment } from "../liveTraffic";
import { vehiclePopupHtml, wireVehiclePopup } from "../vehiclePopup";
import { BadgeAtlas, type BadgeSpec } from "./badges";
import { buildStyle, DEM_SOURCE, demTiles, firstLabelLayer, LAYERS_3D, type Tileset } from "./basemap";
import { easeInOutCubic } from "./chaseCam";
import { loadMapLibre, loadTileset, lowMemoryDevice } from "./engine";
import { FocusFollower, type FocusSpec } from "./follow";
import { lookById, type Look } from "./looks";
import { ensureOverlays, setMe, setRouteLines, setStops, setTraffic, STOP_LAYERS, TRAFFIC_LAYER, type OverlayColors } from "./overlays";
import { VehicleLayer, type Sprite } from "./vehicleLayer";
import { TICK_MS, VehicleSet, type Pos, type VehicleSpec } from "./vehicles";

export type { FocusSpec };

const MAX_PITCH = 70;
/** 3D bekapcsolásakor a kamera ennyire dől meg, és legalább ennyire közelít (itt már látszanak a házak) */
const BROWSE_PITCH = 55;
const BROWSE_BEARING = -18;
const BROWSE_MIN_ZOOM = 14.6;
/** a regionális járművek mozgásbecslése ettől a nagyítástól (távolról csak a GPS-helyük látszik) */
const REGIONAL_MOTION_ZOOM = 10;
/** követés közben a többi jármű halványabban */
const DIM_OPACITY = 0.55;
/** görgetés után ennyi ideig a kamera nem nyúl a térképhez (ms) */
const WHEEL_QUIET_MS = 350;
/** a nézet mentése legfeljebb ilyen gyakran (követéskor a kamera folyton mozog) (ms) */
const SAVE_VIEW_MS = 2000;
/** ennyi fokkal a csempekészlet széle mögé még el lehet húzni a térképet */
const BOUNDS_SLACK = 0.6;
const VEHICLE_LAYER = "mvk-vehicles";

const IS_TOUCH = typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false);
/** érintéskor ekkora ráhagyással találja el a megállót / járművet (px) */
const HIT_TOLERANCE = IS_TOUCH ? 15 : 6;
const REDUCED_MOTION = typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

export type MapView = { lat: number; lon: number; zoom: number };

/** amit a térkép a képkocka rajzolásakor még kitehet (az idővonal visszajátszott járművei) */
export type SpriteSource = (t: number, labels: Sprite[], badges: Sprite[]) => void;

export interface LiveMapHandle {
  flyTo(lat: number, lon: number, zoom: number): void;
  fitBounds(points: [number, number][], maxZoom: number, padding?: number): void;
  zoomBy(delta: number): void;
  view(): MapView | null;
  resumeFollow(): void;
  map(): MLMap | null;
  atlas(): BadgeAtlas | null;
  /**
   * További képek a járműréteg alá (idővonal), és a koppintásuk (`true`: elkapta, a
   * térkép nem keres alatta megállót). A visszaadott függvény leveszi.
   */
  addSprites(source: SpriteSource, onClick?: (x: number, y: number) => boolean): () => void;
  /** egy buborék a térkép stílusában */
  popup(): Popup;
}

export interface LiveMapProps {
  lookId: string;
  three: boolean;
  initialView: MapView;
  /** a látható járművek (a követett nélkül) */
  vehicles: LiveVehicle[];
  routes: Record<string, Route>;
  watch: string[];
  vq: string;
  labels: boolean;
  dim: boolean;
  focus: FocusSpec | null;
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
  onViewChange: (view: MapView) => void;
  /** az első stílus betöltött: a kamera-hívások mostantól hatnak */
  onReady: () => void;
  /** nincs WebGL, vagy nem jön a csempekészlet */
  onFail: (reason: "webgl" | "tiles") => void;
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

const inBounds = (b: LngLatBounds, lon: number, lat: number) => lon >= b.getWest() && lon <= b.getEast() && lat >= b.getSouth() && lat <= b.getNorth();

export function vehicleBadge(v: LiveVehicle, routes: Record<string, Route>, tracked: boolean): BadgeSpec {
  return {
    text: v.routeShort || "?",
    bg: safeHex(v.routeColor, "1FB574"),
    fg: safeHex(v.routeText, "FFFFFF"),
    mode: vehicleModeOf(v, routes[v.routeId]?.type),
    tracked,
    estimated: Boolean(v.estimated),
  };
}

function vehicleSpecs({ vehicles, routes, watch, vq, labels, dim }: LiveMapProps): VehicleSpec[] {
  const watchSet = new Set(watch.map((w) => w.toLowerCase()));
  const q = vq.trim().toLowerCase();
  return vehicles.map((v) => {
    const tracked = watchSet.has(v.id.toLowerCase()) || (q ? v.id.toLowerCase().includes(q) : false);
    const badge = vehicleBadge(v, routes, tracked);
    return {
      v,
      badge,
      label: labels || tracked ? vehicleIdText(v, badge.mode) : null,
      alpha: dim ? DIM_OPACITY : 1,
      z: tracked ? 2 : 1,
    };
  });
}

/** a csempe képe csak akkor készül újra, ha tényleg más lett (a spec objektum minden frissítéskor új) */
function stableSpecs(prev: Map<string, VehicleSpec>, next: VehicleSpec[]): VehicleSpec[] {
  return next.map((s) => {
    const old = prev.get(s.v.id);
    if (!old) return s;
    const same = old.badge.text === s.badge.text && old.badge.bg === s.badge.bg && old.badge.fg === s.badge.fg && old.badge.mode === s.badge.mode && old.badge.tracked === s.badge.tracked && old.badge.estimated === s.badge.estimated;
    return same ? { ...s, badge: old.badge } : s;
  });
}

type Engine = {
  map: MLMap;
  ml: typeof import("maplibre-gl");
  atlas: BadgeAtlas;
  vehicles: VehicleSet;
  follower: FocusFollower;
  layer: VehicleLayer;
  extra: Set<SpriteSource>;
  clicks: Set<(x: number, y: number) => boolean>;
  tileset: Tileset;
  look: Look;
  popup: { id: string; popup: Popup } | null;
  /** a 3D nézet (a kamera és a gesztusok ehhez igazodnak) */
  three: boolean;
  /** a domborzat épp be van-e kapcsolva a térképen */
  terrain: boolean;
  frameT: number;
  repaint: () => void;
};

export const LiveMap = forwardRef<LiveMapHandle, LiveMapProps>(function LiveMap(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  /** minden stílusbetöltés új verzió: a saját rétegek adatai ilyenkor újra felkerülnek */
  const [styleReady, setStyleReady] = useState(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  const specCache = useRef(new Map<string, VehicleSpec>());

  useImperativeHandle(ref, () => ({
    flyTo(lat, lon, zoom) {
      engineRef.current?.map.flyTo({ center: [lon, lat], zoom, duration: REDUCED_MOTION ? 0 : 1000, essential: true });
    },
    fitBounds(points, maxZoom, padding = 70) {
      const map = engineRef.current?.map;
      if (!map || points.length === 0) return;
      const lons = points.map((p) => p[1]);
      const lats = points.map((p) => p[0]);
      map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding, maxZoom, duration: REDUCED_MOTION ? 0 : 900 },
      );
    },
    zoomBy(delta) {
      const map = engineRef.current?.map;
      if (map) map.zoomTo(map.getZoom() + delta, { duration: 250 });
    },
    view() {
      const map = engineRef.current?.map;
      if (!map) return null;
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
    },
    resumeFollow() {
      engineRef.current?.follower.resume(performance.now());
    },
    map: () => engineRef.current?.map ?? null,
    atlas: () => engineRef.current?.atlas ?? null,
    addSprites(source, onClick) {
      const eng = engineRef.current;
      if (!eng) return () => undefined;
      eng.extra.add(source);
      if (onClick) eng.clicks.add(onClick);
      return () => {
        eng.extra.delete(source);
        if (onClick) eng.clicks.delete(onClick);
        eng.map.triggerRepaint();
      };
    },
    popup() {
      const eng = engineRef.current;
      if (!eng) throw new Error("a térkép még nem töltött be");
      return newPopup(eng);
    },
  }));

  // A térkép egyszer épül fel; a nézet cseréje és a 3D lent.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const cleanup: (() => void)[] = [];

    const start = async () => {
      const [ml, tileset] = await Promise.all([loadMapLibre(), loadTileset().catch(() => null)]);
      if (cancelled) return;
      if (!tileset) {
        propsRef.current.onFail("tiles");
        return;
      }
      const p0 = propsRef.current;
      const look = lookById(p0.lookId);
      const style = await styleFor(ml, look, tileset);
      if (cancelled) return;
      const low = lowMemoryDevice();
      let map: MLMap;
      try {
        map = new ml.Map({
          container,
          style,
          center: [p0.initialView.lon, p0.initialView.lat],
          zoom: p0.initialView.zoom,
          minZoom: 5,
          maxZoom: 19.5,
          maxPitch: MAX_PITCH,
          ...(tileset.bounds
            ? {
                maxBounds: [
                  [tileset.bounds[0] - BOUNDS_SLACK, tileset.bounds[1] - BOUNDS_SLACK],
                  [tileset.bounds[2] + BOUNDS_SLACK, tileset.bounds[3] + BOUNDS_SLACK],
                ],
              }
            : {}),
          attributionControl: false,
          // 3-as kijelzőn a 2-es élesség is szép, és fele annyi képpont: hűvösebb telefon
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          canvasContextAttributes: { antialias: false, powerPreference: "default" },
          fadeDuration: REDUCED_MOTION ? 0 : 150,
          renderWorldCopies: false,
          refreshExpiredTiles: false,
          validateStyle: false,
          maxTileCacheZoomLevels: low ? 3 : 5,
          // gyors, saját csempéknél nagyításkor a durvább csempe helyén fokozatosan élesedik
          cancelPendingTileRequestsWhileZooming: low,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          clickTolerance: 4,
        });
      } catch {
        // nincs WebGL2 (régi eszköz, letiltott hardveres gyorsítás)
        propsRef.current.onFail("webgl");
        return;
      }
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      // Egy-egy hiányzó csempe nem végzetes (a térkép újrapróbálja); a konzolt ne árassza el.
      // Minden más hiba (stílus, réteg, worker) látsszon.
      map.on("error", (e) => {
        if ("sourceId" in e || "tile" in e) return;
        console.error(e.error);
      });

      const atlas = new BadgeAtlas(map.getPixelRatio(), {
        primary: token("--primary"),
        background: token("--background"),
        foreground: token("--foreground"),
        popover: token("--popover"),
        border: token("--border"),
        trackedText: token("--sg-200"),
      });
      const vehicles = new VehicleSet(atlas);
      const follower = new FocusFollower(map, atlas, (paused) => propsRef.current.onFollowPausedChange(paused), () => token("--muted-foreground"));
      const extra = new Set<SpriteSource>();
      const labels: Sprite[] = [];
      const badges: Sprite[] = [];
      const eng: Engine = {
        map,
        ml,
        atlas,
        vehicles,
        follower,
        extra,
        clicks: new Set(),
        tileset,
        look,
        popup: null,
        three: false,
        terrain: false,
        frameT: performance.now(),
        repaint: () => map.triggerRepaint(),
        layer: new VehicleLayer(VEHICLE_LAYER, atlas, (out) => {
          labels.length = 0;
          badges.length = 0;
          const t = eng.frameT;
          for (const src of extra) src(t, labels, badges);
          vehicles.collect(t, labels, badges);
          follower.collect(labels, badges);
          for (const s of labels) out.push(s);
          for (const s of badges) out.push(s);
        }),
      };
      engineRef.current = eng;
      cleanup.push(() => {
        follower.destroy();
        vehicles.clear();
        eng.popup?.popup.remove();
      });

      let firstLoad = true;
      map.on("style.load", () => {
        ensureOverlays(map, overlayColors(), IS_TOUCH, firstLabelLayer(map.getStyle()), eng.look.dark);
        if (!map.getLayer(VEHICLE_LAYER)) map.addLayer(eng.layer);
        follower.restyle();
        // első betöltéskor (mentett 3D) a város „felemelkedik”; nézetcserénél a kamera marad
        applyThree(eng, propsRef.current.three, firstLoad);
        if (firstLoad) propsRef.current.onReady();
        firstLoad = false;
        setStyleReady((n) => n + 1);
      });

      wireInteractions(eng, propsRef);
      cleanup.push(runLoop(eng, propsRef));
      // a térkép helye nem csak ablakméretre változik (követés panelje, telefon elforgatása)
      const resize = new ResizeObserver(() => map.resize());
      resize.observe(container);
      cleanup.push(() => resize.disconnect());
    };
    void start();

    return () => {
      cancelled = true;
      cleanup.forEach((fn) => fn());
      const eng = engineRef.current;
      if (eng) {
        const c = eng.map.getCenter();
        propsRef.current.onViewChange({ lat: c.lat, lon: c.lng, zoom: eng.map.getZoom() });
        eng.map.remove();
      }
      engineRef.current = null;
    };
  }, []);

  // Nézetcsere: új stílus; a saját rétegek a `style.load`-ra visszakerülnek.
  useEffect(() => {
    const eng = engineRef.current;
    const look = lookById(props.lookId);
    if (!eng || eng.look.id === look.id) return;
    eng.look = look;
    let stale = false;
    void styleFor(eng.ml, look, eng.tileset).then((style) => {
      // közben már másik nézetet választottak
      if (stale || engineRef.current !== eng) return;
      // A domborzat a csere alatt nem rajzolhat (az új stílus vetülete még nincs kész  MapLibre-hiba).
      eng.map.setTerrain(null);
      eng.terrain = false;
      eng.map.setStyle(style, { diff: false });
    });
    return () => {
      stale = true;
    };
  }, [props.lookId, styleReady]);

  // 2D ↔ 3D: ugyanaz a térkép, megdöntve, domborzattal és épületekkel.
  useEffect(() => {
    const eng = engineRef.current;
    if (eng && styleReady) applyThree(eng, props.three, true);
  }, [props.three, styleReady]);

  const { vehicles, routes, watch, vq, labels, dim, focus, stops, watchedStopIds, selectedStopId, routeLines, traffic, position } = props;

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const specs = stableSpecs(specCache.current, vehicleSpecs(propsRef.current));
    specCache.current = new Map(specs.map((s) => [s.v.id, s]));
    eng.vehicles.sync(specs, performance.now(), elevationFn(eng));
    eng.repaint();
  }, [vehicles, routes, watch, vq, labels, dim, styleReady]);

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.follower.set(focus, performance.now(), elevationFn(eng));
    eng.repaint();
  }, [focus, styleReady]);

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !styleReady) return;
    setStops(eng.map, { list: stops, watched: new Set(watchedStopIds), selected: selectedStopId, touch: IS_TOUCH, c: overlayColors() });
  }, [stops, watchedStopIds, selectedStopId, styleReady]);

  useEffect(() => {
    const eng = engineRef.current;
    if (eng && styleReady) setRouteLines(eng.map, routeLines);
  }, [routeLines, styleReady]);

  useEffect(() => {
    const eng = engineRef.current;
    if (eng && styleReady) setTraffic(eng.map, traffic);
  }, [traffic, styleReady]);

  useEffect(() => {
    const eng = engineRef.current;
    if (eng && styleReady) setMe(eng.map, position);
  }, [position, styleReady]);

  // (a MapLibre `position: relative`-et tesz a saját elemére: a helyét a burkoló adja)
  return (
    <div className="absolute inset-0 z-map bg-background">
      <div ref={containerRef} className="mvk-map h-full w-full" />
    </div>
  );
});

/** A Domborzat nézet szintvonalai: a böngészőben, a saját domborzati csempékből számolva. */
let contours: { key: string; url: Promise<string> } | null = null;
function contourUrl(ml: typeof import("maplibre-gl"), origin: string, ts: Tileset): Promise<string> {
  const tiles = demTiles(origin, ts);
  if (contours?.key === tiles) return contours.url;
  // a csomag csak a Domborzat nézethez kell: a többi nézet nem tölti le
  const url = import("maplibre-contour").then(({ default: mlcontour }) => {
    const dem = new mlcontour.DemSource({ url: tiles, encoding: "terrarium", maxzoom: 11, worker: true });
    dem.setupMaplibre(ml);
    return dem.contourProtocolUrl({
      // nagyítás → [vékony, vastag (feliratos)] szintköz méterben
      thresholds: { 10: [100, 500], 11: [50, 200], 12: [20, 100], 14: [10, 50] },
      elevationKey: "ele",
      levelKey: "level",
      contourLayer: "contours",
    });
  });
  contours = { key: tiles, url };
  return url;
}

async function styleFor(ml: typeof import("maplibre-gl"), look: Look, ts: Tileset): Promise<StyleSpecification> {
  const origin = window.location.origin;
  const contourTiles = look.topo ? await contourUrl(ml, origin, ts) : undefined;
  return buildStyle(look, ts, { origin, esriKey: process.env.NEXT_PUBLIC_ESRI_KEY, contourTiles });
}

/** a terep magassága 3D-ben (a jármű a domboldalon is a földön álljon), 2D-ben 0 */
function elevationFn(eng: Engine): (lon: number, lat: number) => number {
  if (!eng.terrain) return () => 0;
  return (lon, lat) => eng.map.queryTerrainElevation([lon, lat]) ?? 0;
}

/**
 * 3D be/ki: terep, ég, épületek, finom domborzat-árnyék és a dönthető kamera. Mindig
 * ugyanarra az állapotra hoz (stílusváltás után újra kell); a kamera csak váltáskor mozdul.
 */
function applyThree(eng: Engine, three: boolean, animate: boolean): void {
  const { map, look, follower } = eng;
  const changed = eng.three !== three;
  eng.three = three;
  const t = performance.now();
  if (three) {
    if (!eng.terrain) {
      map.setTerrain({ source: DEM_SOURCE, exaggeration: look.exaggeration });
      map.setSky(look.sky);
      eng.terrain = true;
    }
    for (const id of LAYERS_3D) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.touchPitch.enable();
    map.keyboard.enableRotation();
    follower.setThree(true, t);
    if (changed && animate && !follower.active) {
      // a város „felemelkedik” (csökkentett mozgásnál animáció nélkül, de ugyanúgy megdől)
      const view = { pitch: BROWSE_PITCH, bearing: BROWSE_BEARING, zoom: Math.max(map.getZoom(), BROWSE_MIN_ZOOM) };
      if (REDUCED_MOTION) map.jumpTo(view);
      else map.easeTo({ ...view, duration: 1600, easing: easeInOutCubic });
    }
    return;
  }
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.touchPitch.disable();
  map.keyboard.disableRotation();
  follower.setThree(false, t);
  const flat = () => {
    // közben visszakapcsolták a 3D-t
    if (eng.three) return;
    for (const id of LAYERS_3D) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
    if (eng.terrain) {
      map.setTerrain(null);
      map.setSky({});
      eng.terrain = false;
    }
  };
  const tilted = map.getPitch() !== 0 || map.getBearing() !== 0;
  if (changed && animate && tilted && !follower.active && !REDUCED_MOTION) {
    map.once("moveend", flat);
    map.easeTo({ pitch: 0, bearing: 0, duration: 450 });
    return;
  }
  if (tilted && !follower.active) map.jumpTo({ pitch: 0, bearing: 0 });
  flat();
}

function newPopup(eng: Engine): Popup {
  return new eng.ml.Popup({ offset: 14, maxWidth: "300px", className: "mvk-popup", focusAfterOpen: false });
}

/**
 * Felhasználói mozdulatok: elhúzásra a követés megáll, kézi forgatásra a kamera pár
 * másodpercig nem fordul a busz mögé; jármű, megálló és dugó kattintásra.
 */
function wireInteractions(eng: Engine, propsRef: React.RefObject<LiveMapProps>): void {
  const { map, follower, vehicles } = eng;
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
    propsRef.current.onViewChange({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
  });

  const project = (p: Pos) => map.project([p[0], p[1]]);

  const openVehicle = (v: LiveVehicle) => {
    eng.popup?.popup.remove();
    const at = vehicles.drawnOf(v.id);
    if (!at) return;
    const popup = newPopup(eng)
      .setLngLat([at[0], at[1]])
      // Utazás közben a többi busz csak nézelődésre való: se követésre váltás, se felszállás róla.
      .setHTML(vehiclePopupHtml(v, !getActiveRide()))
      .addTo(map);
    // követéskor a buborék bezárul: a kamera a buszra áll, a kártya mutatja az adatait
    const follow = (tripId: string, vehicleId?: string) => {
      popup.remove();
      propsRef.current.onFocusTrip(tripId, vehicleId);
    };
    wireVehiclePopup(popup.getElement(), () => vehicles.vehicle(v.id) ?? v, follow, () => popup.remove());
    const entry = { id: v.id, popup };
    eng.popup = entry;
    popup.on("close", () => {
      if (eng.popup === entry) eng.popup = null;
    });
  };

  // Jármű (a legfelső csempe), aztán megálló (ráhagyással, a legközelebbi pötty), végül dugó.
  map.on("click", (e) => {
    const target = e.originalEvent.target;
    if (target instanceof HTMLElement && target.closest(".maplibregl-popup")) return;
    const { x, y } = e.point;
    for (const handler of eng.clicks) if (handler(x, y)) return;
    const hitVehicle = vehicles.pick(project, x, y, HIT_TOLERANCE / 2);
    if (hitVehicle) {
      openVehicle(hitVehicle);
      return;
    }
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
      const [lon, lat] = f.geometry.coordinates;
      const pt = map.project([lon, lat]);
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
    if (seg) new eng.ml.Popup({ offset: 8, maxWidth: "300px", className: "mvk-popup" }).setLngLat(e.lngLat).setHTML(trafficPopupHtml(seg)).addTo(map);
  });

  // Asztalon: kéz a járművek és megállók fölött, a megálló neve ráálláskor.
  if (IS_TOUCH) return;
  const tip = new eng.ml.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "mvk-tip" });
  let hoverStop = false;
  map.on("mousemove", STOP_LAYERS, (e) => {
    const f = e.features?.[0];
    if (!f || f.geometry.type !== "Point") return;
    hoverStop = true;
    const [lon, lat] = f.geometry.coordinates;
    tip
      .setLngLat([lon, lat])
      .setHTML(`<strong>${escapeHtml(String(f.properties.name))}</strong><br><span style="opacity:.65">${escapeHtml(String(f.properties.kind))}</span>`)
      .addTo(map);
  });
  map.on("mouseleave", STOP_LAYERS, () => {
    hoverStop = false;
    tip.remove();
  });
  let pending = false;
  map.on("mousemove", (e) => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const overVehicle = vehicles.pick(project, e.point.x, e.point.y, 0) != null;
      map.getCanvas().style.cursor = overVehicle || hoverStop ? "pointer" : "";
    });
  });
}

/**
 * A rajzolás üteme: negyedmásodpercenként új célok a becslésből; képkockánként a követő
 * kamera, és újrarajzolás csak akkor, ha egy jármű legalább fél képpontot haladt (a
 * nagyítástól és a leggyorsabb jármű sebességétől függ: városnézetben pár Hz, közelről 60).
 * Amíg a felhasználó a térképen tartja az ujját (vagy görget), a kamera nem nyúl hozzá
 * a MapLibre `jumpTo` megszakítaná a mozdulatát.
 */
function runLoop(eng: Engine, propsRef: React.RefObject<LiveMapProps>): () => void {
  const { map, vehicles, follower } = eng;
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
  let lastPaint = -Infinity;
  const frame = (t: number) => {
    raf = requestAnimationFrame(frame);
    const p = propsRef.current;
    eng.frameT = t;
    if (t - lastTick >= TICK_MS) {
      lastTick = t;
      const now = serverNow();
      // Utazás közben a busz, amin ülsz, a telefon GPS-ével megy (ha az friss és a buszhoz illik).
      const ridden = getActiveRide()?.vehicleId ?? null;
      const gps = ridden ? p.ridePosition : null;
      const elevation = elevationFn(eng);
      // A Volán- és vasúti járművek (a megyében ~250) csak a látott részen és közelről mozognak a becsléssel:
      // a többi a valós jel helyén áll, így a nyomvonaluk sem töltődik le feleslegesen.
      const view = map.getZoom() >= REGIONAL_MOTION_ZOOM ? paddedBounds(map, 0.3) : null;
      vehicles.tick(
        now,
        t,
        (v) => isRegionalId(v.id) && v.id !== ridden && v.lat != null && v.lon != null && (!view || !inBounds(view, v.lon, v.lat)),
        (v) => (gps && v.id === ridden ? gps : null),
        elevation,
      );
      follower.tick(now, t, gps, elevation);
    }
    const dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 0;
    lastFrame = t;
    const interacting = pointers.size > 0 || t - lastWheel < WHEEL_QUIET_MS || map.isMoving();
    follower.frame(t, dt, interacting);

    // a nyitott buborék a járművel megy
    const pop = eng.popup;
    if (pop) {
      const at = pop.id === follower.id ? follower.drawn() : vehicles.drawnOf(pop.id);
      if (at) pop.popup.setLngLat([at[0], at[1]]);
    }

    // Újrarajzolás csak akkor, ha a leggyorsabb jármű fél képpontnyit haladt.
    const zoom = map.getZoom();
    const lat = map.getCenter().lat;
    // dőlt kameránál a kép alja közelebb van: ott nagyobbat lép ugyanannyi méter
    const mpp = (78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom / (map.getPitch() > 20 ? 3 : 1);
    const speed = Math.max(vehicles.maxSpeed(), follower.active ? 15 : 0);
    const hz = REDUCED_MOTION ? 1 : Math.min(60, Math.max(1, (2 * speed) / mpp));
    // (az idővonal a saját ütemében maga kér újrarajzolást)
    if (t - lastPaint >= 1000 / hz - 2) {
      lastPaint = t;
      map.triggerRepaint();
    }
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
