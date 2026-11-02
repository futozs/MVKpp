/**
 * A 3D követés kamerája: a busz mögül, a haladási irányba néz. Az irányt a
 * nyomvonalon előre nézve vesszük (így a kanyar előtt már fordul), és simítva
 * közelítjük, hogy ne rángasson. Függőség nélküli, hogy teszt is futtathassa.
 */

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

/** [lat, lon] */
export type LatLon = [number, number];

/** Két pont távolsága (m), kis távolságra elég a síkbeli közelítés. */
export function metersBetween(a: LatLon, b: LatLon): number {
  const kx = M_PER_DEG_LON * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.hypot((b[1] - a[1]) * kx, (b[0] - a[0]) * M_PER_DEG_LAT);
}

/** Az `a`-ból `b` felé mutató irány fokban (észak = 0, kelet = 90), 0–360. */
export function bearingTo(a: LatLon, b: LatLon): number {
  const kx = M_PER_DEG_LON * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  const deg = (Math.atan2((b[1] - a[1]) * kx, (b[0] - a[0]) * M_PER_DEG_LAT) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** A legrövidebb előjeles fordulás `from`-ból `to`-ba (-180, 180]. */
export function angleDelta(from: number, to: number): number {
  const d = (((to - from) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/**
 * A kamera iránya `dtS` idő múlva: `tauS` időállandóval közelít a célhoz, de
 * legfeljebb `maxDegPerS` sebességgel fordul (egy 180°-os csavar se legyen szédítő).
 */
export function approachAngle(cur: number, target: number, dtS: number, tauS = 0.9, maxDegPerS = 75): number {
  const d = angleDelta(cur, target);
  const share = 1 - Math.exp(-Math.max(0, dtS) / tauS);
  const limit = maxDegPerS * Math.max(0, dtS);
  const step = Math.max(-limit, Math.min(limit, d * share));
  return (cur + step + 360) % 360;
}

export function easeInOutCubic(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * A rárepülés íve: távoli busznál félúton ennyivel kicsinyít (zoomszint), hogy a
 * város fölött átrepüljön, ne végigsöpörjön rajta. 600 m alatt nincs ív.
 */
export function arcDepth(distM: number): number {
  if (!(distM > 600)) return 0;
  return Math.min(4, Math.log2(distM / 600));
}

export function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}
