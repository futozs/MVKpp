/**
 * Térgeometria. Miskolc kicsi, ezért egy helyi síkvetület (equirectangular a
 * város közepén) méterpontos  nincs szükség PostGIS-re a forró úton.
 */

const R_KM = 6371;
const REF_LAT = 48.1;
const KY = 111_320; // m / fok szélesség
const KX = 111_320 * Math.cos((REF_LAT * Math.PI) / 180); // m / fok hosszúság

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(s));
}

/** Gyors távolság méterben (a városon belül < 0,1% hiba). */
export function fastDistM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  return Math.hypot((bLon - aLon) * KX, (bLat - aLat) * KY);
}

export type LatLon = [lat: number, lon: number];

/**
 * Előfeldolgozott nyomvonal: síkkoordináták + kumulált hossz, hogy egy
 * pozíció vetítése ne számolja újra minden alkalommal a teljes alakzatot.
 */
export class ProjectedShape {
  readonly points: LatLon[];
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** cum[i] = az i. pontig mért hossz méterben */
  readonly cum: Float64Array;
  readonly lengthM: number;

  constructor(points: LatLon[]) {
    this.points = points;
    const n = points.length;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = points[i][1] * KX;
      this.y[i] = points[i][0] * KY;
      if (i > 0) this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]);
    }
    this.lengthM = n ? this.cum[n - 1] : 0;
  }

  /**
   * Vetítés a nyomvonalra. Ha `nearAlongM` adott, először csak az előző
   * helyzet környékén keres (−backM … +aheadM): a visszaforduló és
   * önmagát keresztező vonalakon a globális legközelebbi pont gyakran a
   * nyomvonal rossz szakaszán van, ez okozott ugráló „along” értékeket.
   */
  project(
    lat: number,
    lon: number,
    nearAlongM?: number,
    backM = 400,
    aheadM = 4000,
  ): { alongM: number; distM: number } | null {
    const n = this.points.length;
    if (n < 2) return null;
    const px = lon * KX;
    const py = lat * KY;

    const scan = (fromM: number, toM: number) => {
      let best = Infinity;
      let bestAlong = 0;
      for (let i = 0; i < n - 1; i++) {
        if (this.cum[i + 1] < fromM || this.cum[i] > toM) continue;
        const ax = this.x[i], ay = this.y[i];
        const dx = this.x[i + 1] - ax, dy = this.y[i + 1] - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx, qy = ay + t * dy;
        const d = Math.hypot(px - qx, py - qy);
        if (d < best) {
          best = d;
          bestAlong = this.cum[i] + t * Math.sqrt(len2);
        }
      }
      return { alongM: bestAlong, distM: best };
    };

    if (nearAlongM != null) {
      const local = scan(nearAlongM - backM, nearAlongM + aheadM);
      if (local.distM <= 60) return local;
      const global = scan(-Infinity, Infinity);
      // A lokális találat marad, ha a globális csak kicsit jobb  ez véd az
      // önkeresztező szakaszok közti ugrálás ellen.
      return global.distM + 25 < local.distM ? global : local;
    }
    return scan(-Infinity, Infinity);
  }

  /**
   * Előre haladó vetítés megállósorhoz: `fromM`-től indulva az ELSŐ olyan
   * helyet adja, ahol a nyomvonal `nearM`-en belül megközelíti a pontot (a
   * lokális minimumot). Hurokjáratnál így az első megálló a nyomvonal elejére
   * kerül, nem a végére, ahol a hurok visszaér ugyanoda.
   */
  projectForward(lat: number, lon: number, fromM: number, nearM = 60, maxM = 250): { alongM: number; distM: number } | null {
    const n = this.points.length;
    if (n < 2) return null;
    const px = lon * KX;
    const py = lat * KY;
    let best = Infinity;
    let bestAlong = 0;
    let firstHit: { alongM: number; distM: number } | null = null;
    for (let i = 0; i < n - 1; i++) {
      if (this.cum[i + 1] < fromM) continue;
      const ax = this.x[i], ay = this.y[i];
      const dx = this.x[i + 1] - ax, dy = this.y[i + 1] - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      const along = Math.max(fromM, this.cum[i] + t * Math.sqrt(len2));
      if (d < best) {
        best = d;
        bestAlong = along;
      }
      if (firstHit) {
        if (d < firstHit.distM) firstHit = { alongM: along, distM: d };
        else if (d > firstHit.distM + 30) return firstHit; // elhagytuk a lokális minimumot
      } else if (d <= nearM) firstHit = { alongM: along, distM: d };
    }
    if (firstHit) return firstHit;
    return best <= maxM ? { alongM: bestAlong, distM: best } : null;
  }

  /** Pont a nyomvonalon adott hossznál (interpolálva). */
  pointAt(alongM: number): LatLon {
    const n = this.points.length;
    if (!n) return [0, 0];
    if (alongM <= 0) return this.points[0];
    if (alongM >= this.lengthM) return this.points[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= alongM) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[hi] - this.cum[lo] || 1;
    const t = (alongM - this.cum[lo]) / seg;
    const a = this.points[lo], b = this.points[hi];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
}

/** Kompatibilis a régi `projectOntoShapeKm`-mel (km-ben). */
export function projectOntoShapeKm(shape: ProjectedShape | LatLon[], lat: number, lon: number) {
  const ps = shape instanceof ProjectedShape ? shape : new ProjectedShape(shape);
  const p = ps.project(lat, lon);
  return p ? { alongKm: p.alongM / 1000, distKm: p.distM / 1000 } : null;
}
