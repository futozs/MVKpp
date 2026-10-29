/**
 * Élő becslés a térképen: két GPS-jel (10–15 mp) között a busz a nyomvonalán
 * halad tovább a szakasz szokásos sebességével, legfeljebb a következő
 * megállóig — ott megvárja a következő jelet. Nem ír ki semmit, csak a
 * marker mozog folyamatosan, mint a valóságban.
 */
import type { LiveMotion } from "@/types";
import { API_BASE } from "@/lib/apiBase";

type Shape = { pts: [number, number][]; cum: number[] };

/** ennél régebbi jelnél nem találgatunk tovább */
const MAX_EXTRAPOLATE_S = 90;
/** kis visszaugrás (az új jel a becslés mögött van) helyett a busz megáll */
const HOLD_BACK_M = 40;
/** ekkora eltérésig a marker nem ugrik, hanem gyorsan odacsúszik (m) */
const EASE_MAX_M = 400;
/** egy rajzolási lépésben (250 ms) a hátralévő eltérés ekkora része */
const EASE_SHARE = 0.3;
/** ennyi eltérést egy lépésben lekövetünk — a sima haladás nem késik */
const EASE_MIN_STEP_M = 8;

const shapes = new Map<string, Shape | null>();
const loading = new Map<string, Promise<void>>();

/** Nyomvonal betöltése (egyszer, gyorsítótárazva); `null`, amíg nincs meg. */
export function shapeFor(id: string): Shape | null {
  const hit = shapes.get(id);
  if (hit !== undefined) return hit;
  if (!loading.has(id)) {
    loading.set(
      id,
      fetch(`${API_BASE}/gtfs/shape?id=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? (r.json() as Promise<Shape>) : null))
        .then((s) => void shapes.set(id, s && s.pts.length > 1 ? s : null))
        .catch(() => void shapes.set(id, null))
        .finally(() => loading.delete(id)),
    );
  }
  return null;
}

function pointAt(shape: Shape, along: number): [number, number] {
  const { pts, cum } = shape;
  if (along <= 0) return pts[0];
  const last = cum.length - 1;
  if (along >= cum[last]) return pts[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  const f = (along - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
}

export type Shown = { shape: string; along: number };

/**
 * A busz becsült helye most. `shown` az előzőleg kirajzolt hely: a marker
 * nem ugrik vissza apró eltérésnél (a valóságban a busz nem tolat).
 */
export function estimatePosition(m: LiveMotion | null | undefined, nowServer: number, shown: Shown | undefined): { latlng: [number, number]; shown: Shown } | null {
  if (!m) return null;
  const shape = shapeFor(m.s);
  if (!shape) return null;
  const dt = Math.max(0, Math.min(MAX_EXTRAPOLATE_S, nowServer - m.t));
  let along = Math.min(m.a + m.v * dt, Math.max(m.a, m.e));
  if (shown && shown.shape === m.s) {
    const gap = along - shown.along;
    if (gap < 0 && -gap < HOLD_BACK_M) along = shown.along;
    // Új jelnél (előre vagy a becslés mögé) nem ugrik, hanem gyorsan odacsúszik.
    else if (Math.abs(gap) > EASE_MIN_STEP_M && Math.abs(gap) < EASE_MAX_M) along = shown.along + Math.sign(gap) * Math.max(EASE_MIN_STEP_M, Math.abs(gap) * EASE_SHARE);
  }
  return { latlng: pointAt(shape, along), shown: { shape: m.s, along } };
}
