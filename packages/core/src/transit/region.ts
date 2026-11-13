/**
 * A regionális lefedettség: a régi Borsod-Abaúj-Zemplén megye, plusz a
 * füzesabonyi vasúti csomópont (a miskolci vonatok fele ott csatlakozik).
 *
 * Egy Volán- vagy vasúti minta (pattern) akkor kerül be, ha legalább egy
 * megállója a sokszögön belül van  és akkor a TELJES útvonalával együtt
 * (a Budapest–Miskolc IC, a Miskolc–Debrecen busz végig követhető).
 */

/** [szélesség, hosszúság] csúcsok, nagyjából a megyehatár mentén. */
export const REGION_POLYGON: readonly (readonly [number, number])[] = [
  [48.3, 20.08], [48.3, 20.36], [48.47, 20.48], [48.56, 20.75], [48.55, 21.1], [48.52, 21.25], [48.57, 21.45],
  [48.41, 21.7], [48.38, 22.12], [48.25, 21.93], [48.18, 21.7], [48.1, 21.42], [48.0, 21.1], [47.88, 21.09],
  [47.64, 20.88], [47.7, 20.6], [47.7, 20.35], [47.95, 20.47], [48.08, 20.45], [48.12, 20.2], [48.2, 20.06],
];

export type Bbox = { minLat: number; minLon: number; maxLat: number; maxLon: number };

/** A sokszög befoglaló téglalapja (a megálló-felderítéshez). */
export const REGION_BBOX: Bbox = { minLat: 47.62, minLon: 20.04, maxLat: 48.6, maxLon: 22.15 };

/**
 * A járműpozíciók lekérdezésének doboza: a megye ~50 km-es sávval, így a
 * kifelé tartó buszok (Debrecen, Eger, Salgótarján, Nyíregyháza) a megyén
 * túl is látszanak. Ami ebből is kiér, azt mintánként külön követjük.
 */
export const POLL_BBOX: Bbox = { minLat: 47.15, minLon: 19.55, maxLat: 49.05, maxLon: 22.65 };

/** Magyarország (a vasúti járművekhez: a megyét érintő vonatok az egész útjukon). */
export const NATIONAL_BBOX: Bbox = { minLat: 45.7, minLon: 16.1, maxLat: 48.65, maxLon: 22.95 };

export function inRegion(lat: number, lon: number, poly: readonly (readonly [number, number])[] = REGION_POLYGON): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inBbox(lat: number, lon: number, b: Bbox): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}
