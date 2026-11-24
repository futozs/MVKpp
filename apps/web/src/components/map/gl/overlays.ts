/**
 * A térkép saját rétegei (GeoJSON): a kiválasztott vonalak nyomvonala, a dugók,
 * a követett menet útja (a megtett rész halványan), a megállók és a saját helyzet.
 * A vonalak az alaptérkép feliratai alá kerülnek (az utcanevek olvashatók maradnak),
 * a megállók fölé. Stílusváltáskor újra fel kell tenni őket: `ensureOverlays`.
 */
import type { CircleLayerSpecification, ExpressionSpecification, GeoJSONSource, LayerSpecification, Map as MLMap } from "maplibre-gl";
import type { Stop } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import type { TrafficSegment } from "../liveTraffic";
import { trafficColor } from "../trafficColor";

export const SOURCES = { routes: "mvk-routes", traffic: "mvk-traffic", focus: "mvk-focus", stops: "mvk-stops", me: "mvk-me" } as const;
export const STOP_LAYERS = ["mvk-stops", "mvk-stops-coach"];
const STOP_NAMES = "mvk-stop-names";
export const TRAFFIC_LAYER = "mvk-traffic-line";
const FOCUS_LINE = "mvk-focus-line";

/** a Volán-megállók (a megyében ~3500) csak ettől a nagyítástól */
const COACH_STOPS_ZOOM = 13;
/** a megállók neve ettől a nagyítástól */
const STOP_NAMES_ZOOM = 15.5;
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

/** A saját rétegek: `lines` az alaptérkép feliratai alá, `top` minden fölé (a járművek alá). */
export function overlayLayers(c: OverlayColors, touch: boolean, dark: boolean): { lines: LayerSpecification[]; top: LayerSpecification[] } {
  const round = { "line-join": "round", "line-cap": "round" } as const;
  const stopPaint: CircleLayerSpecification["paint"] = {
    // városnyi távolságból kisebb pötty: a buszok a lényeg, a megállók csak háttér
    // (a nagyítás csak a legkülső interpolate-ben állhat)
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, ["*", 0.6, ["get", "r"]], 13, ["get", "r"]],
    "circle-color": ["get", "color"],
    "circle-stroke-color": c.halo,
    "circle-stroke-width": ["get", "sw"],
  };
  return {
    lines: [
      { id: "mvk-routes-casing", type: "line", source: SOURCES.routes, layout: round, paint: { "line-color": c.halo, "line-width": width(4, 7, 16), "line-opacity": 0.55 } },
      { id: "mvk-routes-line", type: "line", source: SOURCES.routes, layout: round, paint: { "line-color": ["get", "color"], "line-width": width(2, 4, 10), "line-opacity": 0.95 } },
      { id: "mvk-traffic-casing", type: "line", source: SOURCES.traffic, layout: round, paint: { "line-color": c.halo, "line-width": ["+", ["get", "w"], 4], "line-opacity": 0.55 } },
      { id: TRAFFIC_LAYER, type: "line", source: SOURCES.traffic, layout: round, paint: { "line-color": ["get", "color"], "line-width": ["get", "w"], "line-opacity": 0.95 } },
      { id: "mvk-focus-casing", type: "line", source: SOURCES.focus, layout: round, paint: { "line-color": c.halo, "line-width": width(7, 12, 26), "line-opacity": 0.6 } },
      { id: "mvk-focus-glow", type: "line", source: SOURCES.focus, layout: round, paint: { "line-color": ["get", "color"], "line-width": width(10, 20, 44), "line-blur": width(6, 12, 26), "line-opacity": 0.28 } },
      { id: FOCUS_LINE, type: "line", source: SOURCES.focus, layout: round, paint: { "line-color": ["get", "color"], "line-width": width(3, 6, 13), "line-opacity": 0.98 } },
    ],
    top: [
      { id: "mvk-stops-coach", type: "circle", source: SOURCES.stops, minzoom: COACH_STOPS_ZOOM, filter: ["==", ["get", "coach"], true], paint: stopPaint },
      { id: "mvk-stops", type: "circle", source: SOURCES.stops, filter: ["!=", ["get", "coach"], true], paint: stopPaint },
      {
        id: STOP_NAMES,
        type: "symbol",
        source: SOURCES.stops,
        minzoom: STOP_NAMES_ZOOM,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Medium"],
          "text-size": 11,
          "text-variable-anchor": ["left", "right", "top", "bottom"],
          "text-radial-offset": 0.75,
          "text-justify": "auto",
          "text-max-width": 9,
          "text-padding": 4,
        },
        paint: {
          "text-color": dark ? "#c5d1cb" : "#2f3633",
          "text-halo-color": dark ? "rgba(10, 15, 13, 0.92)" : "rgba(255, 255, 255, 0.92)",
          "text-halo-width": 1.4,
        },
      },
      {
        id: "mvk-me-accuracy",
        type: "circle",
        source: SOURCES.me,
        // a sugarat a helyzet pontossága adja (`setMe`)
        paint: { "circle-radius": 0, "circle-color": c.mine, "circle-opacity": 0.12, "circle-stroke-color": c.mine, "circle-stroke-width": 1, "circle-stroke-opacity": 0.5, "circle-pitch-alignment": "map" },
      },
      {
        id: "mvk-me",
        type: "circle",
        source: SOURCES.me,
        paint: { "circle-radius": touch ? 8 : 7, "circle-color": c.mine, "circle-stroke-color": c.halo, "circle-stroke-width": 3, "circle-pitch-alignment": "viewport" },
      },
    ],
  };
}

export const OVERLAY_SOURCES = Object.values(SOURCES);

/** `below`: az alaptérkép első felirat-rétege (a vonalak ez alá kerülnek) */
export function ensureOverlays(map: MLMap, c: OverlayColors, touch: boolean, below: string | undefined, dark: boolean): void {
  if (map.getSource(SOURCES.routes)) return;
  for (const id of OVERLAY_SOURCES) {
    map.addSource(id, { type: "geojson", data: EMPTY, lineMetrics: id === SOURCES.focus });
  }
  const { lines, top } = overlayLayers(c, touch, dark);
  for (const l of lines) map.addLayer(l, below);
  for (const l of top) map.addLayer(l);
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
