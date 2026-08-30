export function distanceKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function formatDistance(km: number): string {
  const m = km * 1000;
  if (m < 100) return `${Math.round(m)} m`;
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${km.toFixed(1).replace(".", ",")} km`;
}

export interface PathProjection {
  alongKm: number;
  distKm: number;
}

export function projectOntoPath(
  path: [number, number][],
  lat: number,
  lon: number,
): PathProjection | null {
  if (path.length < 2) return null;

  const kx = 111.32 * Math.cos((path[0][0] * Math.PI) / 180);
  const ky = 111.32;
  const px = lon * kx;
  const py = lat * ky;

  let cumKm = 0;
  let bestDistKm = Infinity;
  let bestAlongKm = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][1] * kx;
    const ay = path[i][0] * ky;
    const bx = path[i + 1][1] * kx;
    const by = path[i + 1][0] * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const segLen2 = dx * dx + dy * dy;
    const t =
      segLen2 > 0
        ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / segLen2))
        : 0;
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    const dist = Math.hypot(px - projX, py - projY);

    if (dist < bestDistKm) {
      bestDistKm = dist;
      bestAlongKm = cumKm + Math.hypot(projX - ax, projY - ay);
    }
    cumKm += Math.hypot(dx, dy);
  }

  return { alongKm: bestAlongKm, distKm: bestDistKm };
}

export interface NearestHit<T> {
  item: T;
  km: number;
}

export function nearest<T extends { lat: number | null; lon: number | null }>(
  list: readonly T[],
  lat: number,
  lon: number,
): NearestHit<T> | null {
  let best: NearestHit<T> | null = null;
  for (const item of list) {
    if (item.lat == null || item.lon == null) continue;
    const km = distanceKm(lat, lon, item.lat, item.lon);
    if (!best || km < best.km) best = { item, km };
  }
  return best;
}
