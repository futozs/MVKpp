/**
 * Hőtérkép-alapok a menetrendből: megállóköz-szakaszok nyomvonala (a városi
 * hőtérképhez) és egy vonal-irány fő megállósora (a vonal-hőtérkép soraihoz).
 */
import type { LatLon, ProjectedShape } from "./geo.ts";
import { fastDistM } from "./geo.ts";
import type { Feed } from "./gtfs/feed.ts";
import { isMvkId } from "./transit/modes.ts";

/** a kirajzolt szakaszon ennyinél közelebbi pontokat elhagyjuk (m) */
const SIMPLIFY_M = 12;

export type SegmentPath = { from: string; to: string; path: LatLon[]; routes: string[]; lengthM: number };

const segCache = new WeakMap<Feed, Map<string, SegmentPath>>();

function slice(shape: ProjectedShape, a: number, b: number): LatLon[] {
  const out: LatLon[] = [shape.pointAt(a)];
  for (let i = 0; i < shape.points.length; i++) {
    const c = shape.cum[i];
    if (c <= a || c >= b) continue;
    const p = shape.points[i];
    const last = out[out.length - 1];
    if (fastDistM(last[0], last[1], p[0], p[1]) >= SIMPLIFY_M) out.push(p);
  }
  out.push(shape.pointAt(b));
  return out.map(([la, lo]) => [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5]);
}

/** Minden megállóköz (`from|to`) nyomvonala és az ott közlekedő vonalak. */
export function segmentPaths(feed: Feed): Map<string, SegmentPath> {
  const hit = segCache.get(feed);
  if (hit) return hit;
  const out = new Map<string, SegmentPath>();
  const routesOf = new Map<string, Set<string>>();
  const doneShapes = new Set<string>();
  for (const t of feed.trips.values()) {
    // a városi hőtérkép az MVK-é (a kompozit feedben a Volán és a vasút is benne van)
    if (!isMvkId(t.id)) continue;
    const route = feed.routes.get(t.routeId)?.short ?? t.routeId;
    const seq = feed.tripStops.get(t.id);
    if (!seq || seq.length < 2) continue;
    for (let i = 0; i < seq.length - 1; i++) {
      const key = `${seq[i].stopId}|${seq[i + 1].stopId}`;
      (routesOf.get(key) ?? routesOf.set(key, new Set()).get(key)!).add(route);
    }
    // A geometria nyomvonalanként egyszer elég.
    if (!t.shapeId || doneShapes.has(t.shapeId)) continue;
    doneShapes.add(t.shapeId);
    const along = feed.tripStopsAlong(t.id);
    const shape = feed.shapes.get(t.shapeId);
    if (!along || !shape) continue;
    for (let i = 0; i < along.length - 1; i++) {
      const key = `${along[i].stopId}|${along[i + 1].stopId}`;
      if (out.has(key) || along[i + 1].alongM <= along[i].alongM) continue;
      out.set(key, {
        from: along[i].stopId,
        to: along[i + 1].stopId,
        path: slice(shape, along[i].alongM, along[i + 1].alongM),
        routes: [],
        lengthM: Math.round(along[i + 1].alongM - along[i].alongM),
      });
    }
  }
  for (const [key, seg] of out) seg.routes = [...(routesOf.get(key) ?? [])].sort((a, b) => a.localeCompare(b, "hu", { numeric: true }));
  segCache.set(feed, out);
  return out;
}

export type RouteDirection = { dir: string; headsign: string; trips: number };

/** Egy vonal irányai (a legtöbb menettel bíró célállomás-felirattal). */
export function routeDirections(feed: Feed, routeShort: string): RouteDirection[] {
  const byDir = new Map<string, Map<string, number>>();
  for (const t of feed.trips.values()) {
    if ((feed.routes.get(t.routeId)?.short ?? t.routeId) !== routeShort) continue;
    const m = byDir.get(t.dir) ?? byDir.set(t.dir, new Map()).get(t.dir)!;
    m.set(t.headsign, (m.get(t.headsign) ?? 0) + 1);
  }
  return [...byDir.entries()]
    .map(([dir, m]) => {
      const [headsign] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      return { dir, headsign, trips: [...m.values()].reduce((a, b) => a + b, 0) };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Egy vonal-irány fő megállósora (a leggyakoribb nyomvonal), és az irány
 * összes nyomvonala (a tényadatok szűréséhez  betérő menetekkel együtt).
 */
export function mainPattern(feed: Feed, routeShort: string, dir: string): { stops: { id: string; name: string }[]; shapeIds: string[] } | null {
  const count = new Map<string, { n: number; tripId: string }>();
  for (const t of feed.trips.values()) {
    if (t.dir !== dir || (feed.routes.get(t.routeId)?.short ?? t.routeId) !== routeShort || !t.shapeId) continue;
    const c = count.get(t.shapeId);
    count.set(t.shapeId, { n: (c?.n ?? 0) + 1, tripId: c?.tripId ?? t.id });
  }
  const best = [...count.values()].sort((a, b) => b.n - a.n)[0];
  const seq = best ? feed.tripStops.get(best.tripId) : undefined;
  if (!seq?.length) return null;
  return {
    stops: seq.map((s) => ({ id: s.stopId, name: feed.stops.get(s.stopId)?.name ?? s.stopId })),
    shapeIds: [...count.keys()],
  };
}
