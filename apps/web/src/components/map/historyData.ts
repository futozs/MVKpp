import { API_BASE } from "@/lib/apiBase";
import { modesParam } from "@/lib/modes";

/**
 * Az idővonal nyers adatai: az `/engine/history/*` végpontok válaszai, már
 * ellenőrizve és tömör típusos tömbökbe rendezve, hogy a képkockánkénti
 * keresés olcsó legyen.
 */

/** A backend egyszerre legfeljebb ennyit ad vissza. */
export const WINDOW_SEC = 2 * 3600;

export interface HistoryDays {
  /** Az első és az utolsó nap, amelyről van nyers GPS (YYYY-MM-DD). */
  gpsMin: string | null;
  gpsMax: string | null;
}

/** Egy jármű pályája egy ablakon belül, időrendben. */
export interface VehicleTrack {
  id: string;
  route: string | null;
  trip: string | null;
  ts: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  /** NaN, ha a jel nem hozott irányt. */
  brg: Float32Array;
  /** Pontonként: index a `routes` listába (−1: a jármű épp nem visz menetet). */
  routeIdx: Int16Array;
  routes: string[];
}

export interface HistoryWindow {
  start: number;
  end: number;
  tracks: Map<string, VehicleTrack>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, { signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Előzmény-hiba [${res.status}] ${path}: ${detail || res.statusText}`);
  }
  return res.json();
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asDay = (v: unknown): string | null =>
  typeof v === "string" && DAY_RE.test(v) ? v : null;

const asText = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;

export async function fetchHistoryDays(signal?: AbortSignal): Promise<HistoryDays> {
  const raw = await getJson("/engine/history/days", signal);
  const gps = isRecord(raw) && isRecord(raw.gps) ? raw.gps : null;
  const gpsMin = asDay(gps?.mn);
  const gpsMax = asDay(gps?.mx);
  if (!gpsMin || !gpsMax || gpsMin > gpsMax) return { gpsMin: null, gpsMax: null };
  return { gpsMin, gpsMax };
}

function parseTrack(id: string, raw: unknown): VehicleTrack | null {
  if (!isRecord(raw) || !Array.isArray(raw.p)) return null;
  const pts = raw.p as unknown[];
  const ts = new Float64Array(pts.length);
  const lat = new Float64Array(pts.length);
  const lon = new Float64Array(pts.length);
  const brg = new Float32Array(pts.length);
  const routeIdx = new Int16Array(pts.length).fill(-1);
  const routes = Array.isArray(raw.routes) ? (raw.routes as unknown[]).map((r) => asText(r) ?? "?") : [];

  let n = 0;
  let sorted = true;
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const [t, la, lo, b, ri] = p as unknown[];
    if (
      typeof t !== "number" ||
      typeof la !== "number" ||
      typeof lo !== "number" ||
      !Number.isFinite(t) ||
      !Number.isFinite(la) ||
      !Number.isFinite(lo)
    ) {
      continue;
    }
    if (n > 0 && t < ts[n - 1]) sorted = false;
    ts[n] = t;
    lat[n] = la;
    lon[n] = lo;
    brg[n] = typeof b === "number" && Number.isFinite(b) ? b : NaN;
    routeIdx[n] = typeof ri === "number" && ri >= 0 && ri < routes.length ? ri : -1;
    n++;
  }
  if (n === 0) return null;

  const track: VehicleTrack = {
    id,
    route: asText(raw.route),
    trip: asText(raw.trip),
    ts: ts.subarray(0, n),
    lat: lat.subarray(0, n),
    lon: lon.subarray(0, n),
    brg: brg.subarray(0, n),
    routeIdx: routeIdx.subarray(0, n),
    routes,
  };
  return sorted ? track : sortTrack(track);
}

/** Csak akkor fut, ha a backend mégsem időrendben küldte a pontokat. */
function sortTrack(track: VehicleTrack): VehicleTrack {
  const order = Array.from(track.ts, (_, i) => i).sort(
    (a, b) => track.ts[a] - track.ts[b],
  );
  const pick = <T extends Float64Array | Float32Array | Int16Array>(src: T, out: T): T => {
    order.forEach((from, to) => {
      out[to] = src[from];
    });
    return out;
  };
  const n = order.length;
  return {
    ...track,
    ts: pick(track.ts, new Float64Array(n)),
    lat: pick(track.lat, new Float64Array(n)),
    lon: pick(track.lon, new Float64Array(n)),
    brg: pick(track.brg, new Float32Array(n)),
    routeIdx: pick(track.routeIdx, new Int16Array(n)),
  };
}

/** A pont vonala (ahol épp a jármű tart); a régi válaszformánál a jármű utolsó vonala. */
export function routeAtPoint(track: VehicleTrack, i: number): string | null {
  if (!track.routes.length) return track.route;
  const ri = i >= 0 && i < track.routeIdx.length ? track.routeIdx[i] : -1;
  return ri >= 0 ? (track.routes[ri] ?? null) : null;
}

export async function fetchHistoryWindow(
  start: number,
  signal?: AbortSignal,
): Promise<HistoryWindow> {
  const end = start + WINDOW_SEC;
  const raw = await getJson(`/engine/history/frames?from=${start}&to=${end}&modes=${modesParam()}`, signal);
  const vehicles = isRecord(raw) && isRecord(raw.vehicles) ? raw.vehicles : {};
  const tracks = new Map<string, VehicleTrack>();
  for (const [id, value] of Object.entries(vehicles)) {
    const track = parseTrack(id, value);
    if (track) tracks.set(id, track);
  }
  return { start, end, tracks };
}

export const windowStartOf = (t: number): number =>
  Math.floor(t / WINDOW_SEC) * WINDOW_SEC;
