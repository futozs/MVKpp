/**
 * A 3D térkép saját rétegei (GeoJSON): a kiválasztott vonalak nyomvonala, a dugók,
 * a követett menet útja (a megtett rész halványan), a megállók és a saját helyzet.
 * Stílusváltáskor (alaptérkép-csere) újra fel kell tenni őket: `ensureOverlays`.
 */
import type { CircleLayerSpecification, ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { Stop } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import type { TrafficSegment } from "../liveTraffic";
import { trafficColor } from "../trafficColor";
import { BUILDINGS_LAYER } from "./style3d";

export const SOURCES = { routes: "mvk-routes", traffic: "mvk-traffic", focus: "mvk-focus", stops: "mvk-stops", me: "mvk-me" } as const;
export const STOP_LAYERS = ["mvk-stops", "mvk-stops-coach"];
export const TRAFFIC_LAYER = "mvk-traffic-line";
const FOCUS_LINE = "mvk-focus-line";

/** a Volán-megállók csak ettől a nagyítástól (a 2D 14-es szintjének felel meg) */
const COACH_STOPS_ZOOM = 13;
const RAIL_COLOR = "#1E5AA8";
const EARTH_M = 40_075_016.686;

export type OverlayColors = { halo: string; neutral: string; brand: string; mine: string };

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;
const collection = (features: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const EMPTY = collection([]);

/** [lat, lon] → GeoJSON [lon, lat] */
const lonLat = (line: [number, number][]) => line.map(([lat, lon]) => [lon, lat]);

/** a vonalvastagság a nagyítással nő (a földre festett csík, nem képernyő-vonal) */
function width(atZ12: number, atZ16: number, atZ19: number): ExpressionSpecification {
  return ["interpolate", ["exponential", 1.6], ["zoom"], 12, atZ12, 16, atZ16, 19, atZ19];
}

export function ensureOverlays(map: MLMap, c: OverlayColors, touch: boolean): void {
  if (map.getSource(SOURCES.routes)) return;
  for (const id of Object.values(SOURCES)) {
    map.addSource(id, { type: "geojson", data: EMPTY, lineMetrics: id === SOURCES.focus });
  }
  // A földön futó csíkok az épületek alá: a ház eltakarja, ami mögötte van.
  const below = map.getLayer(BUILDINGS_LAYER) ? BUILDINGS_LAYER : undefined;
  const round = { "line-join": "round", "line-cap": "round" } as const;
  map.addLayer({ id: "mvk-routes-casing", type: "line", source: SOURCES.routes, layout: round, paint: { "line-color": c.halo, "line-width": width(4, 7, 16), "line-opacity": 0.55 } }, below);
  map.addLayer({ id: "mvk-routes-line", type: "line", source: SOURCES.routes, layout: round, paint: { "line-color": ["get", "color"], "line-width": width(2, 4, 10), "line-opacity": 0.95 } }, below);
  map.addLayer({ id: "mvk-traffic-casing", type: "line", source: SOURCES.traffic, layout: round, paint: { "line-color": c.halo, "line-width": ["+", ["get", "w"], 4], "line-opacity": 0.55 } }, below);
  map.addLayer({ id: TRAFFIC_LAYER, type: "line", source: SOURCES.traffic, layout: round, paint: { "line-color": ["get", "color"], "line-width": ["get", "w"], "line-opacity": 0.95 } }, below);
  map.addLayer({ id: "mvk-focus-casing", type: "line", source: SOURCES.focus, layout: round, paint: { "line-color": c.halo, "line-width": width(7, 12, 26), "line-opacity": 0.6 } }, below);
  map.addLayer({ id: "mvk-focus-glow", type: "line", source: SOURCES.focus, layout: round, paint: { "line-color": ["get", "color"], "line-width": width(10, 20, 44), "line-blur": width(6, 12, 26), "line-opacity": 0.28 } }, below);
  map.addLayer({ id: FOCUS_LINE, type: "line", source: SOURCES.focus, layout: round, paint: { "line-color": ["get", "color"], "line-width": width(3, 6, 13), "line-opacity": 0.98 } }, below);

  const stopPaint: CircleLayerSpecification["paint"] = {
    "circle-radius": ["get", "r"],
    "circle-color": ["get", "color"],
    "circle-stroke-color": c.halo,
    "circle-stroke-width": ["get", "sw"],
  };
  map.addLayer({ id: "mvk-stops-coach", type: "circle", source: SOURCES.stops, minzoom: COACH_STOPS_ZOOM, filter: ["==", ["get", "coach"], true], paint: stopPaint });
  map.addLayer({ id: "mvk-stops", type: "circle", source: SOURCES.stops, filter: ["!=", ["get", "coach"], true], paint: stopPaint });

  map.addLayer({
    id: "mvk-me-accuracy",
    type: "circle",
    source: SOURCES.me,
    // a sugarat a helyzet pontossága adja (`setMe`)
    paint: { "circle-radius": 0, "circle-color": c.mine, "circle-opacity": 0.12, "circle-stroke-color": c.mine, "circle-stroke-width": 1, "circle-stroke-opacity": 0.5, "circle-pitch-alignment": "map" },
  });
  map.addLayer({
    id: "mvk-me",
    type: "circle",
    source: SOURCES.me,
    paint: { "circle-radius": touch ? 8 : 7, "circle-color": c.mine, "circle-stroke-color": c.halo, "circle-stroke-width": 3, "circle-pitch-alignment": "viewport" },
  });
}

function setData(map: MLMap, id: string, data: GeoJSON.FeatureCollection): void {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}

export function setRouteLines(map: MLMap, routes: { color: string; lines: [number, number][][] }[]): void {
  setData(
    map,
    SOURCES.routes,
    collection(routes.flatMap((r) => r.lines.map((line) => ({ type: "Feature", properties: { color: r.color }, geometry: { type: "LineString", coordinates: lonLat(line) } }) as Feature))),
  );
}

export function setTraffic(map: MLMap, segments: TrafficSegment[]): void {
  setData(
    map,
    SOURCES.traffic,
    collection(
      segments.map((seg, i) => ({
        type: "Feature",
        properties: { i, color: trafficColor(seg.level), w: 5 + Math.round(seg.level * 3) },
        geometry: { type: "LineString", coordinates: lonLat(seg.path) },
      })),
    ),
  );
}

export function setFocusLine(map: MLMap, shape: [number, number][] | null, color: string): void {
  setData(map, SOURCES.focus, shape && shape.length > 1 ? collection([{ type: "Feature", properties: { color }, geometry: { type: "LineString", coordinates: lonLat(shape) } }]) : EMPTY);
}

/**
 * A követett menet útja: ami előtte van, a vonal színével; amit már megtett, halványan.
 * `progress`: hol tart a busz a vonal hosszán (0–1), `null`: nem tudjuk  az egész színes.
 */
export function setFocusProgress(map: MLMap, color: string, passed: string, progress: number | null): void {
  if (!map.getLayer(FOCUS_LINE)) return;
  const p = progress == null ? 0 : Math.max(0, Math.min(0.999, progress));
  const gradient: ExpressionSpecification =
    p <= 0 ? ["interpolate", ["linear"], ["line-progress"], 0, color, 1, color] : ["interpolate", ["linear"], ["line-progress"], 0, passed, p, passed, p + 0.001, color, 1, color];
  map.setPaintProperty(FOCUS_LINE, "line-gradient", gradient);
}

export type StopView = { list: Stop[]; watched: Set<string>; selected: string | null; touch: boolean; c: OverlayColors };

export function setStops(map: MLMap, { list, watched, selected, touch, c }: StopView): void {
  const ids = new Set(list.map((s) => s.id));
  const features: Feature[] = [];
  for (const s of list) {
    // a vágány / kocsiállás az állomásán keresztül látszik (egy pötty az állomás)
    if (s.parent && ids.has(s.parent)) continue;
    const active = watched.has(s.id) || selected === s.id;
    const rail = s.feed === "rail";
    const r = active ? (touch ? 7.5 : 6) : rail ? (touch ? 6.5 : 5) : touch ? 5 : 3.5;
    features.push({
      type: "Feature",
      properties: {
        id: s.id,
        name: s.name,
        kind: rail ? "Vasútállomás" : s.station ? "Autóbusz-állomás" : s.feed === "coach" ? "Volán-megálló" : s.id,
        r,
        sw: rail ? 2 : 1.5,
        color: active ? c.brand : rail ? RAIL_COLOR : c.neutral,
        // a kijelölt / figyelt Volán-megálló távolról is látszik
        coach: s.feed === "coach" && !s.station && !active,
      },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    });
  }
  setData(map, SOURCES.stops, collection(features));
}

export function setMe(map: MLMap, pos: GeoPosition | null): void {
  if (!pos) return setData(map, SOURCES.me, EMPTY);
  // a pontosság körének sugara képpontban nagyításonként: méter / (méter per képpont)
  const r0 = (Math.max(pos.accuracyM, 12) * 512) / (EARTH_M * Math.cos((pos.lat * Math.PI) / 180));
  setData(map, SOURCES.me, collection([{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [pos.lon, pos.lat] } }]));
  if (map.getLayer("mvk-me-accuracy")) {
    map.setPaintProperty("mvk-me-accuracy", "circle-radius", ["interpolate", ["exponential", 2], ["zoom"], 0, r0, 22, r0 * 2 ** 22]);
  }
}
