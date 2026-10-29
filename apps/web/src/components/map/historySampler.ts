import type { VehicleTrack } from "./historyData";

/**
 * Egy jármű helyzete tetszőleges pillanatban: a két szomszédos GPS-pont
 * közötti lineáris interpoláció. Városi léptékben a lat/lon szerinti lerp
 * elég pontos.
 */

/** Ennél nagyobb hézagon át nem interpolálunk — a jármű addig nem látszik. */
export const MAX_GAP_SEC = 180;
/** Nagy hézag szélén ennyi ideig még a valós jel helyén tartjuk. */
const HOLD_AFTER_FIX_SEC = 45;
const SHOW_BEFORE_FIX_SEC = 15;
/** Ennél kisebb elmozdulásból nem számolunk irányt (GPS-zaj). */
const MIN_MOVE_M = 5;
const EARTH_R = 6_371_000;
const DEG = Math.PI / 180;

export interface PointRef {
  track: VehicleTrack;
  i: number;
}

export interface Sample {
  lat: number;
  lon: number;
  /** A kurzor előtti utolsó index a jármű saját (aktuális ablakbeli) pályáján. */
  index: number;
  /** Az utolsó valós jel ideje a kurzor előtt (vagy az első utána). */
  fixTs: number;
  a: PointRef | null;
  b: PointRef | null;
}

/** A legnagyobb `i`, amelyre `ts[i] <= t`; -1, ha nincs ilyen. */
export function seek(ts: Float64Array, t: number, hint: number): number {
  const n = ts.length;
  // Lejátszás közben a kurzor alig mozdul, így szinte mindig a régi index
  // vagy a rákövetkező a jó — ez képkockánként O(1).
  if (hint >= 0 && hint < n && ts[hint] <= t) {
    if (hint === n - 1 || ts[hint + 1] > t) return hint;
    if (hint + 2 >= n || ts[hint + 2] > t) return hint + 1;
  }
  let lo = 0;
  let hi = n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * `prev`/`next` ugyanennek a járműnek a szomszédos ablakbeli pályája: az
 * ablakhatáron átnyúló szakaszt ezekből pótoljuk.
 */
export function sampleTrack(
  track: VehicleTrack,
  t: number,
  hint: number,
  prev?: VehicleTrack,
  next?: VehicleTrack,
): Sample | null {
  const n = track.ts.length;
  const index = seek(track.ts, t, hint);

  const a: PointRef | null =
    index >= 0
      ? { track, i: index }
      : prev && prev.ts.length > 0
        ? { track: prev, i: prev.ts.length - 1 }
        : null;
  const b: PointRef | null =
    index + 1 < n
      ? { track, i: index + 1 }
      : next && next.ts.length > 0
        ? { track: next, i: 0 }
        : null;

  const ta = a ? a.track.ts[a.i] : -Infinity;
  const tb = b ? b.track.ts[b.i] : Infinity;

  if (a && b && tb - ta <= MAX_GAP_SEC) {
    const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
    const la = a.track.lat[a.i];
    const lo = a.track.lon[a.i];
    return {
      lat: la + (b.track.lat[b.i] - la) * f,
      lon: lo + (b.track.lon[b.i] - lo) * f,
      index,
      fixTs: ta,
      a,
      b,
    };
  }
  if (a && t - ta <= HOLD_AFTER_FIX_SEC) {
    return { lat: a.track.lat[a.i], lon: a.track.lon[a.i], index, fixTs: ta, a, b: null };
  }
  if (b && tb - t <= SHOW_BEFORE_FIX_SEC) {
    return { lat: b.track.lat[b.i], lon: b.track.lon[b.i], index, fixTs: tb, a: null, b };
  }
  return null;
}

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * DEG * Math.cos(((lat1 + lat2) / 2) * DEG);
  const y = (lat2 - lat1) * DEG;
  return Math.sqrt(x * x + y * y) * EARTH_R;
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

export interface Motion {
  /** Fok, északtól az óramutató járásával; null, ha nem ismert. */
  bearing: number | null;
  /** Becsült sebesség km/h-ban a két jel között; null, ha nem számolható. */
  speedKmh: number | null;
}

/** Irány és sebesség a buborékhoz — csak a nyitott jármű, nem képkockánként mindenki. */
export function motionOf(sample: Sample): Motion {
  const { a, b } = sample;
  let bearing: number | null = null;
  let speedKmh: number | null = null;

  if (a && b) {
    const la = a.track.lat[a.i];
    const lo = a.track.lon[a.i];
    const lb = b.track.lat[b.i];
    const ob = b.track.lon[b.i];
    const dist = distanceM(la, lo, lb, ob);
    const dt = b.track.ts[b.i] - a.track.ts[a.i];
    if (dt > 0) speedKmh = (dist / dt) * 3.6;
    if (dist >= MIN_MOVE_M) bearing = bearingDeg(la, lo, lb, ob);
  }

  if (bearing == null) {
    const own = a ? a.track.brg[a.i] : b ? b.track.brg[b.i] : NaN;
    if (Number.isFinite(own)) bearing = own;
  }
  return { bearing, speedKmh };
}

const COMPASS = ["É", "ÉK", "K", "DK", "D", "DNy", "Ny", "ÉNy"];

export const compassLabel = (deg: number): string =>
  COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
