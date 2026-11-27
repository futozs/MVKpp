/**
 * Az adventi villamos vonala egy dimenzióban: minden GPS-pontot a Tiszai pu.
 * → Felső-Majláth nyomvonalra vetítünk (méter a Tiszaitól). A két végállomás
 * hurok, a Tiszainál a remíz is ott van, ezért ott a vetítés helyett körzetet
 * nézünk.
 */
import { fastDistM, ProjectedShape, type LatLon } from "../geo.ts";
import type { AdventEnd, AdventSeason } from "./season.ts";

export type AdventStopGeo = { id: string; lat: number; lon: number };

export type AdventLine = {
  shape: ProjectedShape;
  /** a megállók helye a nyomvonalon (m), a season.stops sorrendjében: a Felső-Majláth felé menő peron */
  stopOut: number[];
  /** … és a Tiszai felé menő peron (a két oldal akár 100 m-re is lehet egymástól) */
  stopBack: number[];
  /** a végállomások helye a nyomvonalon: a végállomáson álló pont ide kerül */
  endM: Record<AdventEnd, number>;
  ends: Record<AdventEnd, { lat: number; lon: number }>;
  /** megállónként a két peron (oda, vissza) helye a térképhez */
  platforms: { out: AdventStopGeo; back: AdventStopGeo }[];
};

/** a végállomás (hurok, remíz) körzete */
export const END_RADIUS_M = 260;
/** ennél messzebb a nyomvonaltól a jármű nincs a vonalon (remízmenet, adathiba) */
export const OFF_LINE_M = 120;

/**
 * A vonal a Tiszai → Felső-Majláth nyomvonalból és a megállók mindkét
 * peronjából. null, ha valamelyik megálló hiányzik.
 */
export function buildAdventLine(
  season: AdventSeason,
  shapeOut: LatLon[],
  stopById: (id: string) => { lat: number; lon: number } | undefined,
): AdventLine | null {
  if (shapeOut.length < 2) return null;
  const shape = new ProjectedShape(shapeOut);
  const platforms: AdventLine["platforms"] = [];
  const stopOut: number[] = [];
  const stopBack: number[] = [];
  for (const s of season.stops) {
    const o = stopById(s.out);
    const b = stopById(s.back);
    if (!o || !b) return null;
    platforms.push({ out: { id: s.out, lat: o.lat, lon: o.lon }, back: { id: s.back, lat: b.lat, lon: b.lon } });
    const po = shape.project(o.lat, o.lon);
    const pb = shape.project(b.lat, b.lon);
    if (!po || !pb) return null;
    stopOut.push(po.alongM);
    stopBack.push(pb.alongM);
  }
  const last = stopOut.length - 1;
  const mid = (p: { out: AdventStopGeo; back: AdventStopGeo }) => ({ lat: (p.out.lat + p.back.lat) / 2, lon: (p.out.lon + p.back.lon) / 2 });
  return {
    shape,
    stopOut,
    stopBack,
    endM: { tiszai: Math.min(stopOut[0], stopBack[0]), majlath: Math.max(stopOut[last], stopBack[last]) },
    platforms,
    ends: { tiszai: mid(platforms[0]), majlath: mid(platforms[last]) },
  };
}

export type Place = AdventEnd | "line" | "off";

export type LineFix = {
  ts: number;
  lat: number;
  lon: number;
  /** GPS-sebesség (m/s), ha a jármű küldött */
  speed: number | null;
  /** helyzet a nyomvonalon (m a Tiszaitól); végállomáson a végállomás megállójáé */
  m: number;
  /** távolság a nyomvonaltól (m) */
  off: number;
  place: Place;
};

export function placeFix(line: AdventLine, p: { ts: number; lat: number; lon: number; speed: number | null }): LineFix {
  for (const end of ["tiszai", "majlath"] as const) {
    const e = line.ends[end];
    if (fastDistM(p.lat, p.lon, e.lat, e.lon) <= END_RADIUS_M) {
      const proj = line.shape.project(p.lat, p.lon);
      return { ...p, m: line.endM[end], off: proj?.distM ?? 0, place: end };
    }
  }
  const proj = line.shape.project(p.lat, p.lon);
  if (!proj) return { ...p, m: 0, off: Infinity, place: "off" };
  return { ...p, m: proj.alongM, off: proj.distM, place: proj.distM <= OFF_LINE_M ? "line" : "off" };
}

/** a megállók helye az adott irányban */
export const stopsM = (line: AdventLine, dir: "out" | "back") => (dir === "out" ? line.stopOut : line.stopBack);

/** A legközelebbi megálló indexe és távolsága egy vonalbeli helyhez (irány nélkül: a közelebbi peron). */
export function nearestStop(line: AdventLine, m: number, dir?: "out" | "back"): { idx: number; distM: number } {
  let idx = 0;
  let distM = Infinity;
  for (let i = 0; i < line.stopOut.length; i++) {
    const d = dir ? Math.abs(stopsM(line, dir)[i] - m) : Math.min(Math.abs(line.stopOut[i] - m), Math.abs(line.stopBack[i] - m));
    if (d < distM) {
      distM = d;
      idx = i;
    }
  }
  return { idx, distM };
}
